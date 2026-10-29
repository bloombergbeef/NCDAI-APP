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
    console.warn('Failed to read install-meta.json, falling back to generated installId:', err.message);
  }

  let devId = devStore.get('devInstallId');
  if (!devId) {
    devId = crypto.randomUUID();
    devStore.set('devInstallId', devId);
  }
  return devId;
}

/**
 * The installer writes osVersion ('10' | '11' | 'other' | 'unknown') and
 * osLabel (e.g. "Windows 11 (build 22631)") into install-meta.json. Reading
 * them here lets the app re-send them on every heartbeat, so the admin
 * panel's OS filter stays correct even if the one-time install event from
 * the installer never reached the backend (e.g. no internet during setup).
 */
function resolveOsInfo() {
  try {
    const exeDir = path.dirname(app.getPath('exe'));
    const metaPath = path.join(exeDir, 'install-meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.osVersion || meta.osLabel) {
        return { osVersion: meta.osVersion || 'unknown', osLabel: meta.osLabel || 'Unknown Windows version' };
      }
    }
  } catch (err) {
    console.warn('Failed to read OS info from install-meta.json:', err.message);
  }
  return { osVersion: 'unknown', osLabel: 'Unknown Windows version' };
}

module.exports = { resolveInstallId, resolveOsInfo };
