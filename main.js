const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const Store = require('electron-store');
const config = require('./config');
const { resolveInstallId, resolveOsInfo } = require('./lib/install-id');
const { sendHeartbeat } = require('./lib/telemetry');
const { checkForUpdate, downloadToFile, verifyChecksum } = require('./lib/updater');
const { checkComponents } = require('./lib/dependencies');

const store = new Store({ name: 'ncdai-session' });

// Works around a known Electron/Chromium issue where a frameless window
// (frame: false, like ours) renders as a solid black rectangle on some
// GPU/driver combinations — happens on real physical machines too, not
// just VMs, usually with older/integrated GPU drivers. Because our
// titlebar (including the close button) is drawn in HTML by us rather
// than by Windows, a black render also makes the window look un-closeable:
// the X is there in the DOM, it just isn't being painted. Disabling GPU
// compositing trades a little rendering performance for reliability here.
app.disableHardwareAcceleration();

let win = null;
let tray = null;
let isQuitting = false; // true only on the real quit path (tray "Exit"); distinguishes that from the user clicking the titlebar X, which should just hide the window
let installId = null;
let osInfo = { osVersion: 'unknown', osLabel: 'Unknown Windows version' }; // set once installId is resolved, see createWindow()
let elevatedTaskName = null; // scheduled task name for silent component install (if enabled at install time)
let pendingUpdateInstallerPath = null; // set once an "optional" update has finished downloading

// Only one NCDAI process may run at a time. Without this, clicking the
// desktop shortcut while the app is already hidden in the tray would launch
// a second, fully independent process (its own window, its own webview,
// another multi-minute workspace load) instead of just bringing the
// existing one back — exactly the duplicate-process problem single-instance
// lock exists to prevent, same as any VPN client or chat app.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // Another instance is already running and now owns the lock — this one
  // has nothing to do but hand off to it (see 'second-instance' below) and exit.
  app.quit();
} else {
  app.on('second-instance', () => {
    // Fired in the FIRST (already running) process when a second launch
    // attempt happens — e.g. the user double-clicked the desktop icon again
    // while NCDAI was sitting in the tray. Just surface the existing window;
    // its webview never unloaded, so this is instant, not another 5-minute load.
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

function createWindow() {
  // Start hidden when Windows auto-launched us at login (autostart option
  // from the installer) — nobody wants a window popping up on every boot.
  // getLoginItemSettings() reports this based on how THIS process was
  // actually launched (parent process), regardless of how the Run key got
  // there, so it works even though the installer writes it via reg.exe
  // rather than Electron's own setLoginItemSettings API.
  const startHidden = app.getLoginItemSettings().wasOpenedAtLogin;

  win = new BrowserWindow({
    width: 1040,
    height: 800,
    minWidth: 760,
    minHeight: 600,
    frame: false,
    show: !startHidden,
    backgroundColor: '#0a0b0d',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-login.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      // Keep timers/heartbeats/the workspace's own live data running at full
      // speed while the window is hidden in the tray — Chromium throttles
      // them by default for backgrounded windows, which would stall the
      // very thing we're trying to keep warm in the background.
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);

  // Emergency exit, independent of our own HTML-drawn titlebar/close button.
  // If the window ever renders black (GPU/driver glitch) the close button
  // is invisible and unclickable even though it exists in the DOM — this
  // gives the user a way out that doesn't depend on anything being painted
  // on screen, without needing Task Manager.
  globalShortcut.register('Control+Shift+Q', () => {
    isQuitting = true;
    app.quit();
  });

  // Clicking the titlebar X hides the window instead of closing it — the
  // webview (and whatever it already loaded) stays alive in memory, so
  // bringing it back via the tray icon is instant instead of another
  // multi-minute load. The only way to actually quit is the tray's "Exit"
  // item, which sets isQuitting = true first.
  win.on('close', (event) => {
    // Only hide-to-tray if there's actually a tray icon to bring it back
    // from — otherwise (tray creation failed) fall back to a real close, so
    // the user is never left with a vanished window and no way to reopen it.
    if (!isQuitting && tray) {
      event.preventDefault();
      win.hide();
    }
  });

  createTray();

  // TEMPORARY, for diagnostics: open dev tools with F12.
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12') win.webContents.toggleDevTools();
  });

  const savedToken = store.get('token');
  const pendingRegId = store.get('pendingRegistrationId');
  if (savedToken) {
    loadShell();
  } else if (pendingRegId) {
    // The app was restarted while the request was still pending review — don't
    // force the user to log in again, go straight back to the waiting screen
    // and keep polling.
    loadPending();
    pollRegistrationStatus(pendingRegId);
  } else {
    loadLogin();
  }
}

/**
 * The tray icon is what makes "hide instead of close" usable: it's the only
 * remaining way to bring the window back or actually quit once it's hidden.
 * Created once, right after the window, and lives for the whole app session.
 */
function createTray() {
  if (tray) return; // already created (defensive — createWindow only runs once anyway)

  // Defensive: if this ever throws (e.g. a future packaging change drops
  // build/icon.ico from the bundle again), don't let it take the whole
  // startup down with it — "close hides the window with no tray to bring it
  // back" is a much worse failure mode than "no tray icon, but the app and
  // its normal window still work".
  try {
    tray = new Tray(path.join(__dirname, 'build', 'icon.ico'));
  } catch (err) {
    console.warn('Failed to create the tray icon (not critical, the window itself still works):', err.message);
    return;
  }

  tray.setToolTip('NCDAI');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open NCDAI',
      click: () => {
        if (!win) return;
        win.show();
        win.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));

  // Left-click on the icon (Windows default) toggles the window, same as
  // most tray-resident apps.
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });
}

function loadLogin() {
  win.webContents.session.setPreloads([path.join(__dirname, 'preload-login.js')]);
  win.loadFile(path.join(__dirname, 'renderer', 'login', 'login.html'));
  startPingLoop();
}

function loadPending() {
  win.webContents.session.setPreloads([path.join(__dirname, 'preload-login.js')]);
  win.loadFile(path.join(__dirname, 'renderer', 'login', 'pending.html'));
  startPingLoop();
}

function loadShell() {
  win.webContents.session.setPreloads([path.join(__dirname, 'preload-shell.js')]);
  win.loadFile(path.join(__dirname, 'renderer', 'shell', 'shell.html'));
  startPingLoop();
}

/**
 * Refuse to start if there's no install-meta.json next to the exe — this
 * file is only written by the real installer (installer-logic.js) right
 * after copying the files. Without it, running "directly" from a downloaded/
 * extracted folder, bypassing NCDAI-Setup.exe, is blocked — like any serious
 * commercial application, not just a "portable" utility.
 */
function isProperlyInstalled() {
  if (!app.isPackaged) return true; // skip the check in development (npm start)
  const exeDir = path.dirname(app.getPath('exe'));
  return fs.existsSync(path.join(exeDir, 'install-meta.json'));
}

/** Reads install-meta.json and pulls out the scheduled task name used for
 *  silent component installation — if that option was enabled at install
 *  time. Without it (or in development mode) it simply returns null, and
 *  components that need elevated rights are still installed via the normal
 *  UAC prompt (with the component's real name in the window) — a
 *  degradation, not a failure. */
function readElevatedTaskName() {
  if (!app.isPackaged) return null;
  try {
    const exeDir = path.dirname(app.getPath('exe'));
    const meta = JSON.parse(fs.readFileSync(path.join(exeDir, 'install-meta.json'), 'utf8'));
    return meta.elevatedTaskName || null;
  } catch (_err) {
    return null;
  }
}

app.whenReady().then(() => {
  if (!isProperlyInstalled()) {
    dialog.showErrorBox(
      'NCDAI',
      'Please install NCDAI using NCDAI-Setup.exe.\n\nRunning the application without installing it is not supported.'
    );
    app.quit();
    return;
  }

  installId = resolveInstallId();
  osInfo = resolveOsInfo();
  elevatedTaskName = readElevatedTaskName();
  createWindow();
  runStartupTasks();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// SECURITY: without this, the embedded webview (the one loading APP_WEB_URL)
// could navigate anywhere — for example, if the web page itself were
// compromised and tried to lure the user to a fake site. We only allow
// navigation within the same origin as APP_WEB_URL; any links to other sites
// are opened in the user's regular browser instead of an uncontrolled new
// Electron window.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;

  let allowedOrigin;
  try {
    allowedOrigin = new URL(config.APP_WEB_URL).origin;
  } catch (_err) {
    return; // invalid APP_WEB_URL in the config — don't block, but don't check either
  }

  contents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== allowedOrigin) event.preventDefault();
  });

  contents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).origin !== allowedOrigin) {
        shell.openExternal(url);
      }
    } catch (_err) {
      // invalid url — simply don't open anything
    }
    return { action: 'deny' }; // never open a new Electron window
  });
});

// If an optional ("at next restart") update finished downloading while the
// app was running, apply it right as the user quits — matches what we
// promised in the admin panel: optional updates land on the next restart.
app.on('before-quit', () => {
  if (pendingUpdateInstallerPath) {
    spawn(pendingUpdateInstallerPath, [], { detached: true, stdio: 'ignore' }).unref();
  }
  globalShortcut.unregisterAll();
});

async function runStartupTasks() {
  // Fire-and-forget — never blocks the UI, never throws.
  sendHeartbeat({ backendUrl: config.BACKEND_URL, installId, version: app.getVersion(), email: store.get('email'), osVersion: osInfo.osVersion, osLabel: osInfo.osLabel });

  // Check components for ANYONE who installed the app — whether logged in or
  // not. Grants are issued per installId, not per account, so this also works
  // for promos targeting anonymous users. The tier is taken from the saved
  // login if there is one, otherwise it's treated as 'free' — this doesn't
  // affect grants.
  runComponentInstall();

  // If there was no network at startup (or a grant landed after startup),
  // don't wait for the next restart: while the app is open, silently retry
  // the check every COMPONENT_CHECK_INTERVAL_MS. Once the network is back,
  // the component picks itself up. The interval is deliberately short (not
  // 15+ minutes) — the load from such a lightweight request is negligible
  // even with a sizable user base, and a grant in the admin panel is picked
  // up almost immediately.
  //
  // We reuse the same timer to repeat the heartbeat — without this, last_seen
  // would only update on launch, and the admin panel would wrongly show
  // someone as "offline" when they've actually kept the app open for hours.
  const COMPONENT_CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
  setInterval(() => {
    sendHeartbeat({ backendUrl: config.BACKEND_URL, installId, version: app.getVersion(), email: store.get('email'), osVersion: osInfo.osVersion, osLabel: osInfo.osLabel });
    runComponentInstall();
  }, COMPONENT_CHECK_INTERVAL_MS);

  const update = await checkForUpdate({
    backendUrl: config.BACKEND_URL,
    installId,
    currentVersion: app.getVersion(),
  });
  if (!update.available) return;

  notifyUpdateStatus({ state: 'downloading', version: update.version });

  const destPath = path.join(app.getPath('temp'), `NCDAI-Update-${update.version}.exe`);
  try {
    await downloadToFile(update.downloadUrl, destPath);
  } catch (err) {
    console.warn('[updater] update download failed:', err.message);
    notifyUpdateStatus({ state: 'error' });
    return;
  }

  // SECURITY: don't run the downloaded installer until we've confirmed its
  // actual contents match what the server declared.
  const checksumOk = await verifyChecksum(destPath, update.sha256);
  if (!checksumOk) {
    console.warn('[updater] update checksum mismatch — the file will not be run');
    fs.unlinkSync(destPath);
    notifyUpdateStatus({ state: 'error' });
    return;
  }

  if (update.mandatory) {
    // Critical update — install immediately, without asking the user.
    // isQuitting must be set first: otherwise our own 'close' handler would
    // intercept this app.quit() and just hide the window to the tray
    // instead of actually exiting, leaving the old version still running
    // alongside the installer we just launched.
    notifyUpdateStatus({ state: 'installing', version: update.version });
    spawn(destPath, [], { detached: true, stdio: 'ignore' }).unref();
    isQuitting = true;
    app.quit();
  } else {
    // Regular update — silently wait for the next restart (see before-quit above).
    pendingUpdateInstallerPath = destPath;
    notifyUpdateStatus({ state: 'ready', version: update.version });
  }
}

function notifyUpdateStatus(payload) {
  win?.webContents.send('update:status', payload);
}

// ---------- Ping indicator ----------
// We show latency to the internet in general, not to OUR backend — the user
// cares about the quality of their own connection, and pinging specifically
// our server (which may physically be far from the user) wouldn't be
// representative and could show scary high numbers even when the person's
// internet is perfectly fine. So we measure against a fast, geographically
// distributed public endpoint (Google infrastructure, the same one Android/
// Chrome themselves use to check connection quality — generate_204 always
// responds instantly and with almost no data).
let pingTimer = null;
const PING_TARGET_URL = 'https://www.gstatic.com/generate_204';

async function measurePing() {
  const startedAt = performance.now();
  try {
    const res = await fetch(PING_TARGET_URL, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!res.ok) throw new Error('bad status');
    const ms = Math.round(performance.now() - startedAt);
    win?.webContents.send('ping:status', { ok: true, ms });
  } catch (_) {
    win?.webContents.send('ping:status', { ok: false, ms: null });
  }
}

function startPingLoop() {
  if (pingTimer) return; // already running
  measurePing();
  pingTimer = setInterval(measurePing, 5000);
}

// ---------- Registration approval polling ----------
let registrationPollTimer = null;

function stopRegistrationPolling() {
  if (registrationPollTimer) {
    clearInterval(registrationPollTimer);
    registrationPollTimer = null;
  }
}

function pollRegistrationStatus(registrationId) {
  stopRegistrationPolling();
  registrationPollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${config.BACKEND_URL}/api/auth/registration-status/${registrationId}`);
      if (!res.ok) return; // network/server temporarily unavailable — silently retry on the next tick
      const data = await res.json();

      if (data.status === 'approved') {
        stopRegistrationPolling();
        store.delete('pendingRegistrationId');
        store.set('token', data.token);
        store.set('email', data.email);
        store.set('tier', data.tier);
        loadShell();
        sendHeartbeat({ backendUrl: config.BACKEND_URL, installId, version: app.getVersion(), email: data.email, osVersion: osInfo.osVersion, osLabel: osInfo.osLabel });
        runComponentInstall();
      } else if (data.status === 'rejected') {
        stopRegistrationPolling();
        store.delete('pendingRegistrationId');
        win?.webContents.send('registration:status', { status: 'rejected' });
      }
      // status === 'pending' -> do nothing, wait for the next tick
    } catch (err) {
      console.warn('[registration] registration status check failed (will retry later):', err.message);
    }
  }, 5000);
}

/** Runs an installer/exe with silent flags and resolves once it exits. */
function runSilently(exePath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, { windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Installer exited with code ${code}`));
    });
  });
}

/**
 * Same idea as runSilently, but through a scheduled task registered ahead of
 * time (see ncdai-installer/installer-logic.js -> registerElevatedTask).
 * If the component needs elevated rights to install, they're obtained
 * SILENTLY, without a single UAC prompt showing the component's real name,
 * because the task is already configured to "run with highest privileges"
 * when the app is installed.
 *
 * The mechanism works through job files: we write what needs to be run, ask
 * Windows to run the task itself (schtasks /run — this does NOT run exePath
 * directly, it just wakes up the already-registered task), and wait for the
 * result file that elevated-helper.ps1 writes from inside that task.
 */
function runElevatedJobDir() {
  // IMPORTANT: must match what elevated-helper.ps1 reads
  // (ncdai-installer/assets/elevated-helper.ps1 uses $env:LOCALAPPDATA, not
  // app.getPath('appData'), which in Electron points to Roaming — these are
  // different Windows folders. This used to use app.getPath('appData'),
  // which caused the job file to be written somewhere the helper script
  // wasn't looking: the scheduled task would run but not find the job, and
  // the install would silently fall back to a normal run without silent
  // elevation.)
  const dir = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'NCDAI');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function runSilentlyElevated(exePath, args) {
  const jobDir = runElevatedJobDir();
  const jobPath = path.join(jobDir, 'elevated-job.json');
  const resultPath = path.join(jobDir, 'elevated-result.json');

  if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath); // don't read a result left over from a previous run
  fs.writeFileSync(jobPath, JSON.stringify({ exePath, args }), 'utf8');

  await execFileAsync('schtasks', ['/run', '/tn', elevatedTaskName]);

  // The task itself runs asynchronously (Windows returns control right away,
  // without waiting for it to finish) — so we wait for the result file ourselves.
  const deadline = Date.now() + 120000; // 2 minutes — generous headroom for heavy installers
  while (Date.now() < deadline) {
    if (fs.existsSync(resultPath)) {
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      if (!result.ok) throw new Error(result.error || 'elevated install failed');
      if (result.exitCode !== 0) throw new Error(`Installer exited with code ${result.exitCode}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('elevated install: timed out');
}

/** Picks how to launch: via the scheduled task if one exists and is
 *  registered, otherwise the normal way (may show its own system UAC
 *  prompt if that particular component needs it — a degradation, not
 *  an error). */
async function runSilentlyBestEffort(exePath, args) {
  if (elevatedTaskName) {
    try {
      await runSilentlyElevated(exePath, args);
      return;
    } catch (err) {
      console.warn('[elevated] silent install via scheduled task failed, falling back to the normal method:', err.message);
    }
  }
  await runSilently(exePath, args);
}

/**
 * Optional, tier-gated components — not part of the app itself, installed
 * lazily and silently once we know the user's subscription tier (after
 * login). Deliberately reuses the same update:status banner as app updates,
 * so from the user's point of view it just looks like "an update".
 */
let componentInstallInFlight = false;

async function runComponentInstall() {
  if (componentInstallInFlight) return; // previous check hasn't finished yet — don't duplicate it
  componentInstallInFlight = true;
  try {
    // We no longer pass the tier — the server pulls it from the token itself
    // (see components.js on the backend and the comment in dependencies.js).
    const token = store.get('token');
    const { components } = await checkComponents({ backendUrl: config.BACKEND_URL, os: 'win32', installId, token });
    if (!components || components.length === 0) return;

    const installedMap = store.get('installedComponents', {});

    for (const c of components) {
      if (installedMap[c.name] === c.version) continue; // this version is already installed

      notifyUpdateStatus({ state: 'downloading', version: c.version, label: c.name });
      const destPath = path.join(app.getPath('temp'), `${c.name}-${c.version}.exe`);
      try {
        await downloadToFile(c.downloadUrl, destPath);

        // SECURITY: same as with the app's own updates — don't silently run
        // the downloaded component .exe until we've verified its SHA-256.
        const checksumOk = await verifyChecksum(destPath, c.sha256);
        if (!checksumOk) {
          fs.unlinkSync(destPath);
          throw new Error('component checksum mismatch — installation cancelled');
        }

        notifyUpdateStatus({ state: 'installing', version: c.version, label: c.name });
        const args = c.silentArgs ? c.silentArgs.split(' ').filter(Boolean) : [];
        await runSilentlyBestEffort(destPath, args);

        installedMap[c.name] = c.version;
        store.set('installedComponents', installedMap);
        notifyUpdateStatus({ state: 'ready', version: c.version, label: c.name });
      } catch (err) {
        console.warn(`[dependencies] failed to install component "${c.name}":`, err.message);
        notifyUpdateStatus({ state: 'error', label: c.name });
      }
    }
  } finally {
    componentInstallInFlight = false;
  }
}

// ---------- Window chrome ----------
ipcMain.on('window:minimize', () => win?.minimize());
ipcMain.on('window:close', () => win?.close());

// ---------- Auth ----------
ipcMain.handle('auth:login', async (_evt, { email, password, remember }) => {
  if (!email || !password) {
    return { ok: false, error: 'Please enter your username and password' };
  }

  let data;
  try {
    const res = await fetch(`${config.BACKEND_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: email, password }),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data.error || 'Failed to sign in' };
    }
  } catch (err) {
    return { ok: false, error: 'Could not reach the server. Please check your internet connection.' };
  }

  if (remember) {
    store.set('token', data.token);
    store.set('email', data.email);
    store.set('tier', data.tier);
  }

  loadShell();
  sendHeartbeat({ backendUrl: config.BACKEND_URL, installId, version: app.getVersion(), email: data.email, osVersion: osInfo.osVersion, osLabel: osInfo.osLabel });
  runComponentInstall();
  return { ok: true };
});

ipcMain.handle('auth:get-saved-email', () => store.get('email') || '');

// ---------- Registration ----------
// Registration hits BACKEND_URL/api/auth/register: it creates a request with
// status "pending", after which the window switches to the waiting screen
// and starts polling its status.
ipcMain.handle('auth:register', async (_evt, payload) => {
  const { lastName, firstName, username, password, email, phone, company } = payload || {};
  if (!lastName || !firstName || !username || !password || !email || !phone || !company) {
    return { ok: false, error: 'Please fill in all required fields' };
  }

  let data;
  try {
    const res = await fetch(`${config.BACKEND_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || 'Failed to submit the request' };
    }
  } catch (err) {
    return { ok: false, error: 'Could not reach the server. Please check your internet connection.' };
  }

  store.set('pendingRegistrationId', data.registrationId);
  loadPending();
  pollRegistrationStatus(data.registrationId);
  return { ok: true };
});

ipcMain.handle('auth:back-to-login', () => {
  stopRegistrationPolling();
  store.delete('pendingRegistrationId');
  loadLogin();
  return true;
});

ipcMain.handle('auth:logout', () => {
  store.delete('token');
  loadLogin();
  return true;
});

// ---------- Shell helpers ----------
ipcMain.handle('shell:get-app-url', () => config.APP_WEB_URL);

ipcMain.handle('shell:open-external', (_evt, url) => {
  shell.openExternal(url);
});
