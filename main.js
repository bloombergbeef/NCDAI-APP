const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const Store = require('electron-store');
const config = require('./config');
const { resolveInstallId } = require('./lib/install-id');
const { sendHeartbeat } = require('./lib/telemetry');
const { checkForUpdate, downloadToFile, verifyChecksum } = require('./lib/updater');
const { checkComponents } = require('./lib/dependencies');

const store = new Store({ name: 'ncdai-session' });

let win = null;
let installId = null;
let elevatedTaskName = null; // имя задачи в планировщике для тихой установки компонентов (если включено при установке)
let pendingUpdateInstallerPath = null; // set once an "optional" update has finished downloading

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 800,
    minWidth: 760,
    minHeight: 600,
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

  // ВРЕМЕННО, для диагностики: открыть консоль разработчика по F12.
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12') win.webContents.toggleDevTools();
  });

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

/** Читает install-meta.json и достаёт имя задачи планировщика для тихой
 *  установки компонентов — если при установке эта опция была включена.
 *  Без неё (или в режиме разработки) просто возвращает null, и компоненты,
 *  которым требуются права, по-прежнему ставятся через обычный запрос UAC
 *  (с реальным именем компонента в окне) — деградация, а не поломка. */
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
      'Пожалуйста, установите NCDAI с помощью NCDAI-Setup.exe.\n\nЗапуск программы без установки не поддерживается.'
    );
    app.quit();
    return;
  }

  installId = resolveInstallId();
  elevatedTaskName = readElevatedTaskName();
  createWindow();
  runStartupTasks();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// БЕЗОПАСНОСТЬ: без этого встроенный webview (то, что грузит APP_WEB_URL)
// мог бы перейти куда угодно — например, если бы сама веб-страница была
// скомпрометирована и попыталась увести пользователя на поддельный сайт.
// Разрешаем переходы только в пределах того же домена, что и сам APP_WEB_URL;
// любые ссылки на другие сайты открываем в обычном браузере пользователя,
// а не в новом неконтролируемом окне Electron.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;

  let allowedOrigin;
  try {
    allowedOrigin = new URL(config.APP_WEB_URL).origin;
  } catch (_err) {
    return; // некорректный APP_WEB_URL в конфиге — не блокируем, но и не проверяем
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
      // некорректный url — просто ничего не открываем
    }
    return { action: 'deny' }; // никогда не открываем новое Electron-окно
  });
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
  runComponentInstall();

  // Если при старте сети не было (или сработал грант уже после старта) — не
  // ждём следующего перезапуска: пока приложение открыто, тихо повторяем
  // проверку каждые COMPONENT_CHECK_INTERVAL_MS. Появилась сеть — компонент
  // подтянется сам. Значение специально небольшое (не 15+ минут) — нагрузка
  // от такого лёгкого запроса пренебрежимо мала даже при заметном числе
  // пользователей, а грант в админке подхватывается почти сразу.
  //
  // Тем же таймером повторяем heartbeat — без этого last_seen обновлялся бы
  // только при запуске, и админка ошибочно показывала бы "не в сети" для
  // человека, который на самом деле часами держит программу открытой.
  const COMPONENT_CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 минуты
  setInterval(() => {
    sendHeartbeat({ backendUrl: config.BACKEND_URL, installId, version: app.getVersion(), email: store.get('email') });
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
    console.warn('[updater] скачивание обновления не удалось:', err.message);
    notifyUpdateStatus({ state: 'error' });
    return;
  }

  // БЕЗОПАСНОСТЬ: не запускаем скачанный установщик, пока не убедимся, что
  // его реальное содержимое совпадает с тем, что заявил сервер.
  const checksumOk = await verifyChecksum(destPath, update.sha256);
  if (!checksumOk) {
    console.warn('[updater] контрольная сумма обновления не совпала — файл не будет запущен');
    fs.unlinkSync(destPath);
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

// ---------- Ping indicator ----------
// Честный замер задержки: время от отправки запроса до ответа сервера на
// специально лёгкий /api/ping (без обращения к базе — см. server.js), а не
// на "содержательный" эндпоинт, где к сетевой задержке примешалась бы ещё
// и работа самого сервера.
let pingTimer = null;

async function measurePing() {
  const startedAt = performance.now();
  try {
    const res = await fetch(`${config.BACKEND_URL}/api/ping`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('bad status');
    const ms = Math.round(performance.now() - startedAt);
    win?.webContents.send('ping:status', { ok: true, ms });
  } catch (_) {
    win?.webContents.send('ping:status', { ok: false, ms: null });
  }
}

function startPingLoop() {
  if (pingTimer) return; // уже запущен
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
        runComponentInstall();
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
 * То же самое, что runSilently, но через заранее зарегистрированную задачу
 * планировщика (см. ncdai-installer/installer-logic.js -> registerElevatedTask).
 * Если компоненту для установки нужны права — они будут получены ТИХО, без
 * единого окна UAC с настоящим именем компонента, потому что задача уже
 * настроена на "выполнение с наивысшими правами" при установке программы.
 *
 * Механизм — через файлы-задания: записываем, что нужно запустить, просим
 * Windows выполнить саму задачу (schtasks /run — это НЕ запускает exePath
 * напрямую, а лишь будит уже зарегистрированную задачу), и ждём файл с
 * результатом, который напишет elevated-helper.ps1 изнутри этой задачи.
 */
function runElevatedJobDir() {
  // ВАЖНО: должно совпадать с тем, что читает elevated-helper.ps1
  // (ncdai-installer/assets/elevated-helper.ps1 использует $env:LOCALAPPDATA,
  // а не app.getPath('appData'), который в Electron указывает на Roaming —
  // это разные папки Windows. Раньше тут было app.getPath('appData'), из-за
  // чего job-файл писался не туда, где его искал helper-скрипт: задача
  // планировщика отрабатывала, но не находила задание, и установка молча
  // откатывалась на обычный запуск без тихого повышения прав.)
  const dir = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'NCDAI');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function runSilentlyElevated(exePath, args) {
  const jobDir = runElevatedJobDir();
  const jobPath = path.join(jobDir, 'elevated-job.json');
  const resultPath = path.join(jobDir, 'elevated-result.json');

  if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath); // не читать результат от прошлого запуска
  fs.writeFileSync(jobPath, JSON.stringify({ exePath, args }), 'utf8');

  await execFileAsync('schtasks', ['/run', '/tn', elevatedTaskName]);

  // Сама задача выполняется асинхронно (Windows тут же возвращает управление,
  // не дожидаясь её завершения) — поэтому ждём файл с результатом сами.
  const deadline = Date.now() + 120000; // 2 минуты — с большим запасом для тяжёлых установщиков
  while (Date.now() < deadline) {
    if (fs.existsSync(resultPath)) {
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      if (!result.ok) throw new Error(result.error || 'elevated install failed');
      if (result.exitCode !== 0) throw new Error(`Установщик завершился с кодом ${result.exitCode}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('elevated install: превышено время ожидания');
}

/** Выбирает способ запуска: через задачу планировщика, если она есть
 *  и зарегистрирована, иначе — обычный способ (может показать своё
 *  системное окно с правами, если конкретно этому компоненту они нужны —
 *  деградация, а не ошибка). */
async function runSilentlyBestEffort(exePath, args) {
  if (elevatedTaskName) {
    try {
      await runSilentlyElevated(exePath, args);
      return;
    } catch (err) {
      console.warn('[elevated] тихая установка через задачу не удалась, пробуем обычным способом:', err.message);
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
  if (componentInstallInFlight) return; // предыдущая проверка ещё не закончилась — не дублируем
  componentInstallInFlight = true;
  try {
    // Тариф больше не передаём — сервер сам достаёт его из токена (см.
    // components.js на бэкенде и комментарий в dependencies.js).
    const token = store.get('token');
    const { components } = await checkComponents({ backendUrl: config.BACKEND_URL, os: 'win32', installId, token });
    if (!components || components.length === 0) return;

    const installedMap = store.get('installedComponents', {});

    for (const c of components) {
      if (installedMap[c.name] === c.version) continue; // уже стоит эта версия

      notifyUpdateStatus({ state: 'downloading', version: c.version, label: c.name });
      const destPath = path.join(app.getPath('temp'), `${c.name}-${c.version}.exe`);
      try {
        await downloadToFile(c.downloadUrl, destPath);

        // БЕЗОПАСНОСТЬ: как и с обновлениями самой программы — не запускаем
        // тихо скачанный .exe компонента, пока не сверим его SHA-256.
        const checksumOk = await verifyChecksum(destPath, c.sha256);
        if (!checksumOk) {
          fs.unlinkSync(destPath);
          throw new Error('контрольная сумма компонента не совпала — установка отменена');
        }

        notifyUpdateStatus({ state: 'installing', version: c.version, label: c.name });
        const args = c.silentArgs ? c.silentArgs.split(' ').filter(Boolean) : [];
        await runSilentlyBestEffort(destPath, args);

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
  runComponentInstall();
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
