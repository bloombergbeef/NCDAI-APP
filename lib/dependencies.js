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
    // Тариф сервер теперь определяет сам по токену (см. комментарий в
    // components.js на бэкенде) — раньше он верил query-параметру ?tier=...,
    // который можно было подделать и получить платные компоненты бесплатно.
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) return { components: [] };
    return await res.json();
  } catch (err) {
    console.warn('[dependencies] проверка компонентов не удалась:', err.message);
    return { components: [] };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkComponents };
