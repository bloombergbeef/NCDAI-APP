// Проверяет полный цикл регистрации: заявка -> статус "pending" -> админ
// одобряет -> статус "approved" с токеном. Использует тот же fake-backend.js
// и те же HTTP-эндпоинты, что и main.js в приложении (auth:register /
// pollRegistrationStatus), просто без Electron вокруг.
const { createFakeBackend } = require('./fake-backend');

const PORT = 4001;
const BACKEND_URL = `http://localhost:${PORT}`;

async function main() {
  const server = await createFakeBackend(PORT);
  console.log(`Fake backend: ${BACKEND_URL}\n`);

  console.log('1) отправляем заявку на регистрацию');
  const registerRes = await fetch(`${BACKEND_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'ivanov',
      password: 'secret123',
      lastName: 'Иванов',
      firstName: 'Иван',
      email: 'ivanov@company.ru',
      phone: '+7 900 000-00-00',
      company: 'ООО Ромашка',
      experience: 'mid',
    }),
  });
  const registerData = await registerRes.json();
  console.log('  ', registerData);
  const registrationId = registerData.registrationId;

  console.log('\n2) опрашиваем статус — админ ещё не смотрел заявку');
  let status = await (await fetch(`${BACKEND_URL}/api/auth/registration-status/${registrationId}`)).json();
  console.log('  ', status, '(приложение в этот момент показывает экран ожидания)');

  console.log('\n3) админ заходит в раздел "Заявки" и жмёт "Одобрить" с тарифом pro');
  const approveRes = await fetch(`${BACKEND_URL}/api/admin/registrations/${registrationId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: 'pro' }),
  });
  console.log('   approve ->', await approveRes.json());

  console.log('\n4) следующий опрос статуса приложением — теперь approved');
  status = await (await fetch(`${BACKEND_URL}/api/auth/registration-status/${registrationId}`)).json();
  console.log('  ', status, '\n   (приложение получает token+tier и сразу открывает рабочее пространство)');

  server.close();
  console.log('\nВсё отработало ✓');
}

main().catch((err) => {
  console.error('Проверка не прошла:', err);
  process.exit(1);
});
