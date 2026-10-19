const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

/**
 * БЕЗОПАСНОСТЬ: сверяет реальный SHA-256 скачанного файла с тем, что прислал
 * сервер. Если хэш не совпал (файл повреждён при скачивании или подменён) —
 * файл удаляется и НЕ запускается. Если сервер не прислал хэш вообще (старая
 * запись без него) — пропускаем проверку, но это стоит считать временным
 * состоянием, а не нормой: для новых релизов/компонентов хэш есть всегда.
 */
function verifyChecksum(filePath, expectedSha256) {
  return new Promise((resolve, reject) => {
    if (!expectedSha256) {
      resolve(true); // нечего сверять — не блокируем, но и не гарантируем
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
    console.warn('[updater] проверка обновлений не удалась:', err.message);
    return { available: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streams a URL to a local file. Plain http/https — no extra dependency.
 * Контрольная сумма скачанного файла сверяется ВЫЗЫВАЮЩИМ кодом через
 * verifyChecksum() сразу после — см. runStartupTasks()/runComponentInstall()
 * в main.js, которые не запускают файл, пока sha256 не совпадёт.
 *
 * Два отдельных источника проблем, которых тут раньше не было:
 *  - без таймаута: если соединение зависнет (не даст ни данных, ни ошибки —
 *    так бывает при обрыве на уровне сети/прокси), промис никогда не
 *    разрешится, и приложение будет молча ждать вечно;
 *  - без ручной обработки редиректов (3xx): Node's http/https .get() НЕ
 *    идёт по Location-заголовку сам. Если сервер когда-нибудь станет
 *    отдавать ссылку, которая редиректит (например, presigned-URL на S3/CDN),
 *    в destPath сохранится тело самого редиректа (обычно крошечная HTML-
 *    страничка), а не настоящий файл. verifyChecksum() это в итоге поймает
 *    (хэш не совпадёт), но лучше сразу пройти по редиректу правильно.
 */
function downloadToFile(url, destPath, { timeoutMs = 30000, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    function get(currentUrl, redirectsLeft) {
      const client = currentUrl.startsWith('https:') ? https : http;
      const request = client.get(currentUrl, (response) => {
        const status = response.statusCode || 0;

        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume(); // слить тело редиректа, иначе сокет повиснет
          if (redirectsLeft <= 0) {
            reject(new Error('Скачивание не удалось: слишком много редиректов'));
            return;
          }
          const nextUrl = new URL(response.headers.location, currentUrl).toString();
          get(nextUrl, redirectsLeft - 1);
          return;
        }

        if (status >= 400) {
          response.resume();
          reject(new Error(`Скачивание не удалось: HTTP ${status}`));
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

      // БЕЗОПАСНОСТЬ/НАДЁЖНОСТЬ: без этого зависшее соединение держало бы
      // приложение в ожидании бесконечно — см. комментарий выше.
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`Скачивание не удалось: превышено время ожидания (${timeoutMs} мс)`));
      });
    }

    get(url, maxRedirects);
  });
}

module.exports = { checkForUpdate, downloadToFile, verifyChecksum };
