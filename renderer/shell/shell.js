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
    loading.querySelector('p').textContent = 'Не удалось загрузить NCDAI. Проверьте подключение к интернету.';
  });

  window.ncdai.getAppUrl().then((url) => {
    webview.src = url;
  });

  const banner = document.getElementById('update-banner');
  const bannerText = document.getElementById('update-banner-text');
  const messages = {
    downloading: (v, label) => (label ? `Загружается ${label} ${v}…` : `Скачивается обновление до версии ${v}…`),
    installing: (v, label) =>
      label ? `Устанавливается ${label} ${v}…` : `Устанавливается обновление ${v}, приложение сейчас перезапустится…`,
    ready: (v, label) => (label ? `${label} ${v} установлен` : `Обновление ${v} готово — применится при следующем перезапуске`),
    error: () => 'Не удалось выполнить обновление',
  };
  window.ncdai.onUpdateStatus(({ state, version, label }) => {
    banner.hidden = false;
    banner.className = `update-banner is-${state}`;
    bannerText.textContent = messages[state] ? messages[state](version, label) : '';
  });
})();
