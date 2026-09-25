(() => {
  document.getElementById('btn-min').addEventListener('click', () => window.ncdai.minimize());
  document.getElementById('btn-close').addEventListener('click', () => window.ncdai.close());

  window.ncdai.getSavedEmail().then((email) => {
    if (email) document.getElementById('email').value = email;
  });

  const form = document.getElementById('login-form');
  const btn = document.getElementById('btn-login');
  const btnLabel = btn.querySelector('.btn-label');
  const btnSpinner = btn.querySelector('.btn-spinner');
  const errorMsg = document.getElementById('error-msg');

  function setLoading(loading) {
    btn.disabled = loading;
    btnLabel.textContent = loading ? 'Вход…' : 'Войти';
    btnSpinner.hidden = !loading;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorMsg.textContent = '';
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const remember = document.getElementById('remember').checked;

    setLoading(true);
    const result = await window.ncdai.login({ email, password, remember });
    // On success, main process swaps the window content to the shell —
    // no need to do anything further here. On failure, show the error.
    if (!result.ok) {
      setLoading(false);
      errorMsg.textContent = result.error || 'Не удалось войти. Попробуйте ещё раз.';
    }
  });

  // ---------- Switching between login and registration ----------
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');

  document.getElementById('link-to-register').addEventListener('click', (e) => {
    e.preventDefault();
    loginForm.hidden = true;
    registerForm.hidden = false;
  });
  document.getElementById('link-to-login').addEventListener('click', (e) => {
    e.preventDefault();
    registerForm.hidden = true;
    loginForm.hidden = false;
  });

  // ---------- Registration ----------
  const regBtn = document.getElementById('btn-register');
  const regBtnLabel = regBtn.querySelector('.btn-label');
  const regBtnSpinner = regBtn.querySelector('.btn-spinner');
  const regError = document.getElementById('register-error');

  function setRegLoading(loading) {
    regBtn.disabled = loading;
    regBtnLabel.textContent = loading ? 'Регистрация…' : 'Зарегистрироваться';
    regBtnSpinner.hidden = !loading;
  }

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    regError.textContent = '';

    const payload = {
      lastName: document.getElementById('reg-lastname').value.trim(),
      firstName: document.getElementById('reg-firstname').value.trim(),
      username: document.getElementById('reg-username').value.trim(),
      password: document.getElementById('reg-password').value,
      passwordConfirm: document.getElementById('reg-password-confirm').value,
      email: document.getElementById('reg-email').value.trim(),
      phone: document.getElementById('reg-phone').value.trim(),
      company: document.getElementById('reg-company').value.trim(),
      experience: document.getElementById('reg-experience').value,
    };

    if (payload.password !== payload.passwordConfirm) {
      regError.textContent = 'Пароли не совпадают';
      return;
    }

    setRegLoading(true);
    const result = await window.ncdai.register(payload);
    // On success, main process swaps the window content to the shell, same as login.
    if (!result.ok) {
      setRegLoading(false);
      regError.textContent = result.error || 'Не удалось зарегистрироваться. Попробуйте ещё раз.';
    }
  });

  // ---------- Ping ----------
  const pingDot = document.getElementById('ping-dot');
  const pingValue = document.getElementById('ping-value');
  window.ncdai.onPingStatus(({ ok, ms }) => {
    if (!ok) {
      pingDot.className = 'ping-dot is-red';
      pingValue.textContent = 'нет связи';
      return;
    }
    const level = ms <= 20 ? 'green' : ms <= 100 ? 'orange' : 'red';
    pingDot.className = `ping-dot is-${level}`;
    pingValue.textContent = `${ms} мс`;
  });
})();
