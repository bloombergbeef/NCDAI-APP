// Мини-бэкенд на чистом Node http (без npm-пакетов) — повторяет контракт
// ncdai-backend ровно настолько, чтобы прогнать через него настоящие
// ../lib/telemetry.js и ../lib/updater.js без Electron и без реального сервера.
// Запуск: node test/run-integration-check.js
const http = require('http');
const url = require('url');

const releaseFile = Buffer.from('демо-содержимое обновления\n'.repeat(200));
const registrations = new Map();
let nextRegId = 1;

function createFakeBackend(port = 4000) {
  const server = http.createServer((req, res) => {
    const { pathname, query } = url.parse(req.url, true);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      console.log(`> ${req.method} ${pathname}${body ? '  body=' + body : '  query=' + JSON.stringify(query)}`);

      if (pathname === '/api/telemetry/install' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else if (pathname === '/api/telemetry/heartbeat' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else if (pathname === '/api/updates/check' && req.method === 'GET') {
        const payload =
          query.currentVersion === '1.0.0'
            ? {
                available: true,
                version: '1.1.0',
                mandatory: false,
                notes: 'Тестовое демо-обновление',
                fileSize: releaseFile.length,
                downloadUrl: `http://localhost:${port}/api/updates/download/1`,
              }
            : { available: false };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      } else if (pathname === '/api/updates/download/1' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(releaseFile);
      } else if (pathname === '/api/components/check' && req.method === 'GET') {
        const tierQualifies = query.tier === 'pro' || query.tier === 'enterprise';
        const explicitlyGranted = query.installId === 'granted-free-user'; // симулирует ручной грант в админке
        const payload =
          tierQualifies || explicitlyGranted
            ? {
                components: [
                  {
                    id: 1,
                    name: 'advanced-engine',
                    version: '1.0.0',
                    notes: 'Тестовый компонент только для pro/enterprise (или вручную разрешённых пользователей)',
                    silentArgs: '/quiet /norestart',
                    fileSize: releaseFile.length,
                    downloadUrl: `http://localhost:${port}/api/components/download/1`,
                  },
                ],
              }
            : { components: [] };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      } else if (pathname === '/api/components/download/1' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(releaseFile);
      } else if (pathname === '/api/auth/register' && req.method === 'POST') {
        const data = JSON.parse(body || '{}');
        if (!data.username || !data.password || !data.lastName || !data.firstName || !data.email) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Заполните все обязательные поля' }));
          return;
        }
        const id = nextRegId++;
        registrations.set(id, { ...data, status: 'pending', tier: 'free' });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, registrationId: id }));
      } else if (/^\/api\/auth\/registration-status\/\d+$/.test(pathname) && req.method === 'GET') {
        const id = Number(pathname.split('/').pop());
        const reg = registrations.get(id);
        if (!reg) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Заявка не найдена' }));
          return;
        }
        if (reg.status === 'approved') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'approved', tier: reg.tier, token: `fake-user-token-${id}`, email: reg.email }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: reg.status }));
        }
      } else if (/^\/api\/admin\/registrations\/\d+\/approve$/.test(pathname) && req.method === 'POST') {
        const id = Number(pathname.split('/')[4]);
        const reg = registrations.get(id);
        if (!reg) { res.writeHead(404); res.end(); return; }
        const data = JSON.parse(body || '{}');
        reg.status = 'approved';
        reg.tier = data.tier || 'free';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else if (/^\/api\/admin\/registrations\/\d+\/reject$/.test(pathname) && req.method === 'POST') {
        const id = Number(pathname.split('/')[4]);
        const reg = registrations.get(id);
        if (!reg) { res.writeHead(404); res.end(); return; }
        reg.status = 'rejected';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

module.exports = { createFakeBackend };
