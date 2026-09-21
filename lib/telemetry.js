/**
 * Talks to ncdai-backend's telemetry endpoints. Every call here is
 * best-effort: a failed request must never interrupt the app — the user
 * came here to use NCDAI, not to see a telemetry error.
 */
async function postJson(url, body, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res.ok;
  } catch (err) {
    console.warn(`[telemetry] запрос к ${url} не удался:`, err.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function sendHeartbeat({ backendUrl, installId, version, email }) {
  return postJson(`${backendUrl}/api/telemetry/heartbeat`, { installId, version, email });
}

function sendInstallEvent({ backendUrl, installId, version, os, arch, email }) {
  return postJson(`${backendUrl}/api/telemetry/install`, { installId, version, os, arch, email });
}

module.exports = { sendHeartbeat, sendInstallEvent };
