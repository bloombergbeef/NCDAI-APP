(() => {
  document.getElementById('btn-min').addEventListener('click', () => window.ncdai.minimize());
  document.getElementById('btn-close').addEventListener('click', () => window.ncdai.close());
  document.getElementById('btn-logout').addEventListener('click', () => window.ncdai.logout());

  const webview = document.getElementById('app-webview');
  const loading = document.getElementById('webview-loading');

  webview.addEventListener('did-finish-load', () => {
    loading.style.display = 'none';
    webview.style.display = 'block';
  });
  webview.addEventListener('did-fail-load', (e) => {
    // ignore aborted loads (e.g. about:blank) — real failures still show the loader
    if (e.errorCode === -3) return;
    loading.querySelector('p').textContent = 'Failed to load NCDAI. Please check your internet connection.';
  });

  // Safety net: if the workspace's own renderer process dies while the
  // window was hidden in the tray (crash, out-of-memory, killed by Windows),
  // bring the window back to a black/frozen webview with no obvious way to
  // recover other than restarting the whole app. Reload it automatically
  // instead — the host window and tray icon were never affected, only this
  // one guest page.
  function recoverWebview() {
    webview.style.display = 'none';
    loading.style.display = ''; // falls back to the CSS default (flex) — spinner shows again
    loading.querySelector('p').textContent = 'Restoring NCDAI…';
    webview.reload();
  }
  webview.addEventListener('crashed', recoverWebview); // older Electron
  webview.addEventListener('render-process-gone', (e) => {
    // 'clean-exit' happens on an intentional reload/navigation — nothing to recover from
    if (e.reason && e.reason !== 'clean-exit') recoverWebview();
  });

  window.ncdai.getAppUrl().then((url) => {
    webview.src = url;
  });

  const banner = document.getElementById('update-banner');
  const bannerText = document.getElementById('update-banner-text');
  const messages = {
    downloading: (v, label) => (label ? `Downloading ${label} ${v}…` : `Downloading update to version ${v}…`),
    installing: (v, label) =>
      label ? `Installing ${label} ${v}…` : `Installing update ${v}, the app will restart shortly…`,
    ready: (v, label) => (label ? `${label} ${v} installed` : `Update ${v} ready — it will be applied on the next restart`),
    error: () => 'Failed to apply update',
  };
  window.ncdai.onUpdateStatus(({ state, version, label }) => {
    banner.hidden = false;
    banner.className = `update-banner is-${state}`;
    bannerText.textContent = messages[state] ? messages[state](version, label) : '';
  });

  // ---------- Ping ----------
  // Green — up to 20 ms, orange — up to 100 ms, red — higher (or no connection).
  const pingDot = document.getElementById('ping-dot');
  const pingValue = document.getElementById('ping-value');
  window.ncdai.onPingStatus(({ ok, ms }) => {
    if (!ok) {
      pingDot.className = 'ping-dot is-red';
      pingValue.textContent = 'no connection';
      return;
    }
    const level = ms <= 20 ? 'green' : ms <= 100 ? 'orange' : 'red';
    pingDot.className = `ping-dot is-${level}`;
    pingValue.textContent = `${ms} ms`;
  });
})();
