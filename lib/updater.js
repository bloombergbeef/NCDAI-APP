const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

/**
 * SECURITY: compares the actual SHA-256 of the downloaded file against the
 * one the server sent. If the hash doesn't match (the file was corrupted
 * during download or tampered with), the file is deleted and NOT run. If
 * the server didn't send a hash at all (an old record without one), the
 * check is skipped — but that should be treated as a temporary state, not
 * the norm: new releases/components always have a hash.
 */
function verifyChecksum(filePath, expectedSha256) {
  return new Promise((resolve, reject) => {
    if (!expectedSha256) {
      resolve(true); // nothing to compare — don't block, but no guarantee either
      return;
    }
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex') === expectedSha256));
    stream.on('error', reject);
  });
}

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
    console.warn('[updater] update check failed:', err.message);
    return { available: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streams a URL to a local file. Plain http/https — no extra dependency.
 * The checksum of the downloaded file is verified by the CALLING code via
 * verifyChecksum() right after — see runStartupTasks()/runComponentInstall()
 * in main.js, which don't run the file until the sha256 matches.
 *
 * Two separate issues that didn't exist here before:
 *  - no timeout: if the connection hangs (gives neither data nor an error —
 *    which happens with network/proxy-level drops), the promise would never
 *    resolve, and the app would silently wait forever;
 *  - no manual handling of redirects (3xx): Node's http/https .get() does
 *    NOT follow the Location header itself. If the server ever starts
 *    returning a link that redirects (e.g. a presigned S3/CDN URL), destPath
 *    would end up holding the body of the redirect itself (usually a tiny
 *    HTML page), not the actual file. verifyChecksum() will eventually catch
 *    this (the hash won't match), but it's better to follow the redirect
 *    correctly right away.
 */
function downloadToFile(url, destPath, { timeoutMs = 30000, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    function get(currentUrl, redirectsLeft) {
      const client = currentUrl.startsWith('https:') ? https : http;
      const request = client.get(currentUrl, (response) => {
        const status = response.statusCode || 0;

        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume(); // drain the redirect body, or the socket will hang
          if (redirectsLeft <= 0) {
            reject(new Error('Download failed: too many redirects'));
            return;
          }
          const nextUrl = new URL(response.headers.location, currentUrl).toString();
          get(nextUrl, redirectsLeft - 1);
          return;
        }

        if (status >= 400) {
          response.resume();
          reject(new Error(`Download failed: HTTP ${status}`));
          return;
        }

        const file = fs.createWriteStream(destPath);
        response.pipe(file);
        file.on('finish', () => file.close(() => resolve(destPath)));
        file.on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      });

      request.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });

      // SECURITY/RELIABILITY: without this, a hung connection would keep the
      // app waiting forever — see the comment above.
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`Download failed: timed out (${timeoutMs} ms)`));
      });
    }

    get(url, maxRedirects);
  });
}

module.exports = { checkForUpdate, downloadToFile, verifyChecksum };
