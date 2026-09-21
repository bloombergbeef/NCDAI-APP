const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const Store = require('electron-store');

const devStore = new Store({ name: 'ncdai-session' });

/**
 * The installer writes install-meta.json next to NCDAI.exe. That's the
 * source of truth for installId — it's what ties this specific install to
 * its telemetry/update history on the backend. If it's missing (e.g. running
 * via `npm start` in dev, or a manually copied build), fall back to a
 * generated id persisted locally so at least repeated dev runs stay stable.
 */
function resolveInstallId() {
  try {
    const exeDir = path.dirname(app.getPath('exe'));
    const metaPath = path.join(exeDir, 'install-meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.installId) return meta.installId;
    }
  } catch (err) {
    console.warn('Не удалось прочитать install-meta.json, использую резервный installId:', err.message);
  }

  let devId = devStore.get('devInstallId');
  if (!devId) {
    devId = crypto.randomUUID();
    devStore.set('devInstallId', devId);
  }
  return devId;
}

module.exports = { resolveInstallId };
