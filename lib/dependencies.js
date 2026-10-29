/**
 * Optional, tier-gated components — NOT part of the app itself. A user on a
 * higher subscription tier gets extra components installed silently, lazily,
 * the first time we know their tier (right after login). The install UX is
 * intentionally identical to a normal app update (same banner in the shell).
 */
async function checkComponents({ backendUrl, os, installId, token }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const url = new URL(`${backendUrl}/api/components/check`);
    if (os) url.searchParams.set('os', os);
    if (installId) url.searchParams.set('installId', installId);
    // The server now determines the tier itself from the token (see the
    // comment in components.js on the backend) — it used to trust the
    // ?tier=... query parameter, which could be spoofed to get paid
    // components for free.
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) return { components: [] };
    return await res.json();
  } catch (err) {
    console.warn('[dependencies] component check failed:', err.message);
    return { components: [] };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkComponents };
