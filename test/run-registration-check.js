// Verifies the full registration cycle: request -> "pending" status -> admin
// approves -> "approved" status with a token. Uses the same fake-backend.js
// and the same HTTP endpoints as main.js in the app (auth:register /
// pollRegistrationStatus), just without Electron around it.
const { createFakeBackend } = require('./fake-backend');

const PORT = 4001;
const BACKEND_URL = `http://localhost:${PORT}`;

async function main() {
  const server = await createFakeBackend(PORT);
  console.log(`Fake backend: ${BACKEND_URL}\n`);

  console.log('1) submitting a registration request');
  const registerRes = await fetch(`${BACKEND_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'jsmith',
      password: 'secret123',
      lastName: 'Smith',
      firstName: 'John',
      email: 'jsmith@company.com',
      phone: '+1 555 000-0000',
      company: 'Acme LLC',
      experience: 'mid',
    }),
  });
  const registerData = await registerRes.json();
  console.log('  ', registerData);
  const registrationId = registerData.registrationId;

  console.log('\n2) polling the status — the admin hasn\'t looked at the request yet');
  let status = await (await fetch(`${BACKEND_URL}/api/auth/registration-status/${registrationId}`)).json();
  console.log('  ', status, '(at this point the app shows the waiting screen)');

  console.log('\n3) the admin opens the "Requests" section and clicks "Approve" with the pro tier');
  const approveRes = await fetch(`${BACKEND_URL}/api/admin/registrations/${registrationId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: 'pro' }),
  });
  console.log('   approve ->', await approveRes.json());

  console.log('\n4) the app\'s next status poll — now approved');
  status = await (await fetch(`${BACKEND_URL}/api/auth/registration-status/${registrationId}`)).json();
  console.log('  ', status, '\n   (the app receives token+tier and immediately opens the workspace)');

  server.close();
  console.log('\nAll checks passed ✓');
}

main().catch((err) => {
  console.error('Check failed:', err);
  process.exit(1);
});
