const fs = require('fs');
const http = require('http');
const https = require('https');

/**
 * Asks the backend if a newer version applies to this install.
 * Returns { available: false } on any error — a broken update check
 * must never be treated as "there's an update, go break the app".
 */
async function checkForUpdate({ backendUrl, installId, currentVersion, channel }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const url = new URL(`${backendUrl}/api/updates/check`);
    url.searchParams.set('installId', installId);
    url.searchParams.set('currentVersion', currentVersion);
    if (channel) url.searchParams.set('channel', channel);

    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { available: false };
    return await res.json();
  } catch (err) {
    console.warn('[updater] проверка обновлений не удалась:', err.message);
    return { available: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streams a URL to a local file. Plain http/https — no extra dependency.
 * NOTE for production: verify a checksum/signature on the downloaded file
 * before running it. The backend doesn't currently return one; add a
 * sha512 field to the release record and check it here before relying on
 * this for real deployments.
 */
function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const file = fs.createWriteStream(destPath);
    client
      .get(url, (response) => {
        if (response.statusCode && response.statusCode >= 400) {
          file.close();
          fs.unlink(destPath, () => {});
          reject(new Error(`Скачивание обновления не удалось: HTTP ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => file.close(() => resolve(destPath)));
      })
      .on('error', (err) => {
        file.close();
        fs.unlink(destPath, () => {});
        reject(err);
      });
  });
}

module.exports = { checkForUpdate, downloadToFile };
