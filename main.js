const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Store = require('electron-store');
const config = require('./config');
const { resolveInstallId } = require('./lib/install-id');
const { sendHeartbeat } = require('./lib/telemetry');
const { checkForUpdate, downloadToFile } = require('./lib/updater');
const { checkComponents } = require('./lib/dependencies');

const store = new Store({ name: 'ncdai-session' });

let win = null;
let installId = null;
let pendingUpdateInstallerPath = null; // set once an "optional" update has finished downloading

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    frame: false,
    backgroundColor: '#0a0b0d',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-login.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.setMenuBarVisibility(false);

  const savedToken = store.get('token');
  const pendingRegId = store.get('pendingRegistrationId');
  if (savedToken) {
    loadShell();
  } else if (pendingRegId) {
    // Приложение перезапустили, пока заявка ещё не рассмотрена — не заставляем
    // логиниться заново, сразу возвращаем на экран ожидания и продолжаем опрос.
    loadPending();
    pollRegistrationStatus(pendingRegId);
  } else {
    loadLogin();
  }
}

function loadLogin() {
  win.webContents.session.setPreloads([path.join(__dirname, 'preload-login.js')]);
  win.loadFile(path.join(__dirname, 'renderer', 'login', 'login.html'));
}

function loadPending() {
  win.webContents.session.setPreloads([path.join(__dirname, 'preload-login.js')]);
  win.loadFile(path.join(__dirname, 'renderer', 'login', 'pending.html'));
}

function loadShell() {
  win.webContents.session.setPreloads([path.join(__dirname, 'preload-shell.js')]);
  win.loadFile(path.join(__dirname, 'renderer', 'shell', 'shell.html'));
}

/**
 * Отказываемся запускаться, если рядом с exe нет install-meta.json — этот
 * файл кладёт только настоящий установщик (installer-logic.js) сразу после
 * копирования файлов. Без него запуск "напрямую" из скачанной/распакованной
 * папки, минуя NCDAI-Setup.exe, будет заблокирован — как у любого серьёзного
 * коммерческого приложения, а не только "portable"-утилиты.
 */
function isProperlyInstalled() {
  if (!app.isPackaged) return true; // в разработке (npm start) проверку не делаем
  const exeDir = path.dirname(app.getPath('exe'));
  return fs.existsSync(path.join(exeDir, 'install-meta.json'));
}

app.whenReady().then(() => {
  if (!isProperlyInstalled()) {
    dialog.showErrorBox(
      'NCDAI',
      'Пожалуйста, установите NCDAI с помощью NCDAI-Setup.exe.\n\nЗапуск программы без установки не поддерживается.'
    );
    app.quit();
    return;
  }

  installId = resolveInstallId();
  createWindow();
  runStartupTasks();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// If an optional ("at next restart") update finished downloading while the
// app was running, apply it right as the user quits — matches what we
// promised in the admin panel: optional updates land on the next restart.
app.on('before-quit', () => {
  if (pendingUpdateInstallerPath) {
    spawn(pendingUpdateInstallerPath, [], { detached: true, stdio: 'ignore' }).unref();
  }
});

async function runStartupTasks() {
  // Fire-and-forget — never blocks the UI, never throws.
  sendHeartbeat({ backendUrl: config.BACKEND_URL, installId, version: app.getVersion(), email: store.get('email') });

  // Проверяем компоненты для ЛЮБОГО, кто установил программу — залогинен он или
  // нет. Гранты выдаются на installId, а не на аккаунт, так что это работает и
  // для акций/промо на анонимных пользователей. Тариф берём из сохранённого
  // логина, если он есть, иначе считаем 'free' — на гранты это не влияет.
  runComponentInstall(store.get('tier') || 'free');

  // Если при старте сети не было (или сработал грант уже после старта) — не
  // ждём следующего перезапуска: пока приложение открыто, тихо повторяем
  // проверку каждые 15 минут. Появилась сеть — компонент подтянется сам.
  setInterval(() => {
    runComponentInstall(store.get('tier') || 'free');
  }, 15 * 60 * 1000);

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
    console.warn('[updater] скачивание обновления не удалось:', err.message);
    notifyUpdateStatus({ state: 'error' });
    return;
  }

  if (update.mandatory) {
    // Критическое обновление — ставим немедленно, без вопроса пользователю.
    notifyUpdateStatus({ state: 'installing', version: update.version });
    spawn(destPath, [], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
  } else {
    // Обычное обновление — тихо ждём следующего перезапуска (см. before-quit выше).
    pendingUpdateInstallerPath = destPath;
    notifyUpdateStatus({ state: 'ready', version: update.version });
  }
}

function notifyUpdateStatus(payload) {
  win?.webContents.send('update:status', payload);
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
      if (!res.ok) return; // сеть/сервер временно недоступны — тихо пробуем ещё раз на следующем тике
      const data = await res.json();

      if (data.status === 'approved') {
        stopRegistrationPolling();
        store.delete('pendingRegistrationId');
        store.set('token', data.token);
        store.set('email', data.email);
        store.set('tier', data.tier);
        loadShell();
        sendHeartbeat({ backendUrl: config.BACKEND_URL, installId, version: app.getVersion(), email: data.email });
        runComponentInstall(data.tier);
      } else if (data.status === 'rejected') {
        stopRegistrationPolling();
        store.delete('pendingRegistrationId');
        win?.webContents.send('registration:status', { status: 'rejected' });
      }
      // status === 'pending' -> ничего не делаем, ждём следующего тика
    } catch (err) {
      console.warn('[registration] проверка статуса заявки не удалась (повторим позже):', err.message);
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
      else reject(new Error(`Установщик завершился с кодом ${code}`));
    });
  });
}

/**
 * Optional, tier-gated components — not part of the app itself, installed
 * lazily and silently once we know the user's subscription tier (after
 * login). Deliberately reuses the same update:status banner as app updates,
 * so from the user's point of view it just looks like "an update".
 */
let componentInstallInFlight = false;

async function runComponentInstall(tier) {
  if (componentInstallInFlight) return; // предыдущая проверка ещё не закончилась — не дублируем
  componentInstallInFlight = true;
  try {
    const { components } = await checkComponents({ backendUrl: config.BACKEND_URL, tier, os: 'win32', installId });
    if (!components || components.length === 0) return;

    const installedMap = store.get('installedComponents', {});

    for (const c of components) {
      if (installedMap[c.name] === c.version) continue; // уже стоит эта версия

      notifyUpdateStatus({ state: 'downloading', version: c.version, label: c.name });
      const destPath = path.join(app.getPath('temp'), `${c.name}-${c.version}.exe`);
      try {
        await downloadToFile(c.downloadUrl, destPath);
        notifyUpdateStatus({ state: 'installing', version: c.version, label: c.name });
        const args = c.silentArgs ? c.silentArgs.split(' ').filter(Boolean) : [];
        await runSilently(destPath, args);

        installedMap[c.name] = c.version;
        store.set('installedComponents', installedMap);
        notifyUpdateStatus({ state: 'ready', version: c.version, label: c.name });
      } catch (err) {
        console.warn(`[dependencies] установка компонента "${c.name}" не удалась:`, err.message);
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
    return { ok: false, error: 'Введите логин и пароль' };
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
      return { ok: false, error: data.error || 'Не удалось войти' };
    }
  } catch (err) {
    return { ok: false, error: 'Не удалось связаться с сервером. Проверьте подключение к интернету.' };
  }

  if (remember) {
    store.set('token', data.token);
    store.set('email', data.email);
    store.set('tier', data.tier);
  }

  loadShell();
  sendHeartbeat({ backendUrl: config.BACKEND_URL, installId, version: app.getVersion(), email: data.email });
  runComponentInstall(data.tier);
  return { ok: true };
});

ipcMain.handle('auth:get-saved-email', () => store.get('email') || '');

// ---------- Registration ----------
// Регистрация ходит на BACKEND_URL/api/auth/register: создаёт заявку со
// статусом "pending", после чего окно переключается на экран ожидания и
// начинает опрашивать её статус.
ipcMain.handle('auth:register', async (_evt, payload) => {
  const { lastName, firstName, username, password, email, phone, company } = payload || {};
  if (!lastName || !firstName || !username || !password || !email || !phone || !company) {
    return { ok: false, error: 'Заполните все обязательные поля' };
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
      return { ok: false, error: data.error || 'Не удалось отправить заявку' };
    }
  } catch (err) {
    return { ok: false, error: 'Не удалось связаться с сервером. Проверьте подключение к интернету.' };
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
