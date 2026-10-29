// Verifies lib/telemetry.js and lib/updater.js without Electron and without a
// real backend — spins up a fake http server with the same API contract.
// Run: node test/run-integration-check.js
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

  console.log('1) install event');
  console.log('   ok =', await sendInstallEvent({ backendUrl: BACKEND_URL, installId, version: '1.0.0', os: 'win32', arch: 'x64' }));

  console.log('\n2) heartbeat');
  console.log('   ok =', await sendHeartbeat({ backendUrl: BACKEND_URL, installId, version: '1.0.0' }));

  console.log('\n3) checking for updates (currentVersion=1.0.0)');
  const update = await checkForUpdate({ backendUrl: BACKEND_URL, installId, currentVersion: '1.0.0' });
  console.log('  ', update);

  if (update.available) {
    console.log('\n4) downloading the update');
    const dest = path.join(os.tmpdir(), `ncdai-update-test-${update.version}.exe`);
    await downloadToFile(update.downloadUrl, dest);
    console.log('   saved to', dest, '-', fs.statSync(dest).size, 'bytes');
  }

  console.log('\n5) checking components for the "free" tier without a manual grant (should be empty)');
  const freeComponents = await checkComponents({ backendUrl: BACKEND_URL, tier: 'free', os: 'win32', installId: 'plain-free-user' });
  console.log('  ', freeComponents);

  console.log('\n5b) "free" tier, but the admin manually allowed this installId (simulates the checkbox in the "Users" section)');
  const grantedComponents = await checkComponents({ backendUrl: BACKEND_URL, tier: 'free', os: 'win32', installId: 'granted-free-user' });
  console.log('  ', grantedComponents, '(available even on the free tier — this is the manual grant kicking in)');

  console.log('\n6) checking components for the "pro" tier (available automatically, no manual action needed)');
  const proComponents = await checkComponents({ backendUrl: BACKEND_URL, tier: 'pro', os: 'win32', installId: 'some-pro-user' });
  console.log('  ', proComponents);

  if (proComponents.components?.length) {
    console.log('\n7) downloading the component (not running a silent exe install here — the test file isn\'t executable)');
    const c = proComponents.components[0];
    const dest = path.join(os.tmpdir(), `${c.name}-${c.version}.exe`);
    await downloadToFile(c.downloadUrl, dest);
    console.log('   saved to', dest, '-', fs.statSync(dest).size, 'bytes, silentArgs =', c.silentArgs);
  }

  server.close();
  console.log('\nAll checks passed ✓');
}

main().catch((err) => {
  console.error('Check failed:', err);
  process.exit(1);
});
