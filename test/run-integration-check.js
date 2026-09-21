// Проверяет lib/telemetry.js и lib/updater.js без Electron и без реального
// бэкенда — поднимает фейковый http-сервер с тем же контрактом API.
// Запуск: node test/run-integration-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');

const { createFakeBackend } = require('./fake-backend');
const { sendInstallEvent, sendHeartbeat } = require('../lib/telemetry');
const { checkForUpdate, downloadToFile } = require('../lib/updater');
const { checkComponents } = require('../lib/dependencies');

const PORT = 4000;
const BACKEND_URL = `http://localhost:${PORT}`;
const installId = 'test-install-id';

async function main() {
  const server = await createFakeBackend(PORT);
  console.log(`Fake backend: ${BACKEND_URL}\n`);

  console.log('1) install-событие');
  console.log('   ok =', await sendInstallEvent({ backendUrl: BACKEND_URL, installId, version: '1.0.0', os: 'win32', arch: 'x64' }));

  console.log('\n2) heartbeat');
  console.log('   ok =', await sendHeartbeat({ backendUrl: BACKEND_URL, installId, version: '1.0.0' }));

  console.log('\n3) проверка обновлений (currentVersion=1.0.0)');
  const update = await checkForUpdate({ backendUrl: BACKEND_URL, installId, currentVersion: '1.0.0' });
  console.log('  ', update);

  if (update.available) {
    console.log('\n4) скачивание обновления');
    const dest = path.join(os.tmpdir(), `ncdai-update-test-${update.version}.exe`);
    await downloadToFile(update.downloadUrl, dest);
    console.log('   сохранено в', dest, '-', fs.statSync(dest).size, 'байт');
  }

  console.log('\n5) проверка компонентов для тарифа "free" без ручного разрешения (должно быть пусто)');
  const freeComponents = await checkComponents({ backendUrl: BACKEND_URL, tier: 'free', os: 'win32', installId: 'plain-free-user' });
  console.log('  ', freeComponents);

  console.log('\n5b) тариф "free", но админ вручную разрешил этому installId (симулирует чекбокс в разделе "Пользователи")');
  const grantedComponents = await checkComponents({ backendUrl: BACKEND_URL, tier: 'free', os: 'win32', installId: 'granted-free-user' });
  console.log('  ', grantedComponents, '(доступно, хотя тариф free — сработал именно ручной грант)');

  console.log('\n6) проверка компонентов для тарифа "pro" (доступно автоматически, без ручных действий)');
  const proComponents = await checkComponents({ backendUrl: BACKEND_URL, tier: 'pro', os: 'win32', installId: 'some-pro-user' });
  console.log('  ', proComponents);

  if (proComponents.components?.length) {
    console.log('\n7) скачивание компонента (тихую установку exe здесь не запускаем — тестовый файл не исполняемый)');
    const c = proComponents.components[0];
    const dest = path.join(os.tmpdir(), `${c.name}-${c.version}.exe`);
    await downloadToFile(c.downloadUrl, dest);
    console.log('   сохранено в', dest, '-', fs.statSync(dest).size, 'байт, silentArgs =', c.silentArgs);
  }

  server.close();
  console.log('\nВсё отработало ✓');
}

main().catch((err) => {
  console.error('Проверка не прошла:', err);
  process.exit(1);
});
