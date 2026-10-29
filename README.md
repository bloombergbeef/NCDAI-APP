# NCDAI — client application (login + webview)

A thin Electron client: login screen → token storage → window with a web page
(all the app's real logic lives on the server, this is just the "frame").

## Structure

```
ncdai-app/
├── main.js              # windows, IPC, auth stub, token storage
├── preload-login.js      # bridge for the login screen
├── preload-shell.js      # bridge for the webview window
├── config.js             # PLACEHOLDERS: LOGIN_API_URL and APP_WEB_URL — replace with real values
├── renderer/
│   ├── login/             # sign-in screen (email/password, "remember me")
│   └── shell/              # window after login: <webview> with your web page
└── package.json
```

## What already works

- A login screen in the same black-and-amber style as the installer — with a
  "Sign up" link that switches to the registration screen without opening a new window.
- **The registration screen** collects: last name, first name, desired username,
  password (with confirmation), email, phone, company name, and experience in
  the field (a dropdown: "Just starting out" → "More than 5 years"). Required
  field validation and password matching happen on the client (`login.js`).
- **Registration actually talks to the backend** — it isn't a stub: `main.js`
  sends `POST {BACKEND_URL}/api/auth/register`, receives a `registrationId`,
  switches the window to the waiting screen (`renderer/login/pending.html` —
  "don't close this window") and polls `GET /api/auth/registration-status/:id`
  every 5 seconds (`pollRegistrationStatus()` in `main.js`).
  - `approved` status → the app receives a token and tier, saves them, and
    **automatically** switches to the workspace — with no action required
    from the user.
  - `rejected` status → the waiting screen shows the rejection and a
    "Back to sign in" button.
  - If the app is closed and reopened while the request is still pending, it
    returns to the waiting screen on its own and keeps polling
    (`pendingRegistrationId` in `electron-store`), instead of forcing the
    user to register again.
- A request is approved from the **"Requests"** tab in the backend admin
  panel — that's also where you pick the tier the new user will get.
- Authentication is a **stub** (`main.js` → `ipcMain.handle('auth:login', ...)`):
  it accepts any non-empty username/password and returns a fake token. The
  spot to plug in a real request to your API is marked with a `TODO` comment.
- The token and email are saved via `electron-store` in
  `%APPDATA%\ncdai-app\ncdai-session.json` (if "remember me" is checked) —
  login is skipped on the next launch.
- After login, the window switches to `renderer/shell/shell.html`, where the
  `<webview>` loads `config.APP_WEB_URL` (currently `https://app.ncdai.example`
  — a placeholder).
- The "Log out" button clears the token and returns to the login screen.

## Connection to the backend (`ncdai-backend`) — already wired up

This isn't a stub — `lib/telemetry.js` and `lib/updater.js` make real HTTP calls:

- **`lib/install-id.js`** — on startup, reads `install-meta.json`, which
  `ncdai-installer` places next to `NCDAI.exe` (it holds the `installId`
  generated at install time). If the file doesn't exist (e.g. `npm start` in
  development), it generates and saves its own via `electron-store`, so
  repeated dev runs stay stable.
- **`lib/telemetry.js`** — `sendHeartbeat()` fires on every launch
  (`main.js` → `runStartupTasks()`). The install event itself is sent by the
  **installer** (`ncdai-installer/installer-logic.js`), not this app — it's
  the only one that knows for sure that an install just happened.
- **`lib/updater.js`** — `checkForUpdate()` asks `GET /api/updates/check` on
  every launch. If an update is available:
  - `mandatory: true` → downloads and immediately runs the installer,
    closing the current app (`app.quit()` in `main.js`).
  - `mandatory: false` → silently downloads and defers installation until
    the user closes the app themselves (`app.on('before-quit')`).
  - `renderer/shell/` has a thin banner at the top of the window reflecting
    this state ("Downloading…" / "Ready — will be applied on restart").

**How to test this without Electron and without a running backend** — a
small fake HTTP server (using only the built-in `http`, no dependencies)
that replicates the `ncdai-backend` contract, and runs the exact same
`lib/telemetry.js` and `lib/updater.js` files the app itself uses:

```bash
node test/run-integration-check.js
```

This prints out the whole cycle: install event → heartbeat → update check →
file download — for real, over HTTP, using the same code.

Separately — the registration cycle (request → waiting → admin approval → token):

```bash
node test/run-registration-check.js
```

## Silent installation of "tiered" components (`lib/dependencies.js`)

Separate from updating the app itself — components that aren't needed by
every user, only by those whose subscription is at or above a certain tier
(e.g. `pro`). They're deliberately excluded from the main build — installed
lazily, right inside the app, using the same "download → install silently"
pattern as updates.

**How it works:**
1. On every app launch (`runStartupTasks()`) — **regardless of whether the
   user is logged in or not** — `runComponentInstall(tier)` is called, where
   `tier` is taken from the saved login if there is one, otherwise it's
   treated as `'free'`. Grants are issued per `installId`, not per account,
   so promotional access for anonymous/not-yet-logged-in users also works —
   it's enough to set a grant in the admin panel on the right `installId`
   from the "Users" list; logging in isn't required.
2. If there was no network at startup, the check simply finds nothing and
   quietly finishes (no errors, no immediate retries). But while the app is
   open, a recheck runs every 15 minutes (`setInterval` in `main.js`) — as
   soon as the network comes back, the component picks itself up, with no
   app restart needed.
3. After login (`ipcMain.handle('auth:login', ...)`) — an extra immediate
   check runs with the current tier, so there's no need to wait for the next
   cycle if the user just subscribed.
4. `lib/dependencies.js` asks the backend
   `GET /api/components/check?tier=...&installId=...` which components are
   available (by tier OR by a manual grant).
5. For each missing one (checked against the locally saved list in
   `electron-store`) — it downloads the `.exe`/installer and runs it with
   silent flags (`silentArgs` from the backend's response, e.g.
   `/quiet /norestart`), waiting for exit code `0`.
6. **From the user's point of view this looks like a normal update** — the
   same banner in `renderer/shell/` (visible after login). If a component
   installs before login (the anonymous/promo scenario), it's entirely
   silent, with no indicator at all on the login screen — showing an update
   banner there could confuse someone into thinking something is required
   of them.

Tested with the same `node test/run-integration-check.js` — it includes
steps 5–7, which verify that the `free` tier doesn't see the component while
`pro` does, and downloads it.

**Important for production:** the silent-install arguments (`/quiet`, `/S`,
`/qn`, etc.) depend on what the specific component was built with
(MSI/NSIS/InnoSetup) — these are set per-component in the backend admin
panel, nothing needs to be hardcoded in the app. If a component requires
administrator rights, the silent run will still trigger a UAC prompt — this
is expected and isn't something the client code can work around.

**Don't forget these production details**, which aren't in place yet:
- Checksum/signature verification of the downloaded `.exe` before running
  it — `lib/updater.js` doesn't currently do this (see the `NOTE` comment in
  the file).
- `config.BACKEND_URL` points at `http://localhost:4000` — replace it with
  the real backend address.

## Running it

```bash
npm install
npm start
```

On first launch, the login screen opens — enter anything to check the
transition to the webview screen (it will show a load error until
`APP_WEB_URL` points to a real address — this is expected).

## Building the final .exe

**Option A — automatically, without your own machine.** The project already
has `.github/workflows/build.yml`. Push the folder to a GitHub repository and
push to `main` — the build will run on a real GitHub Windows runner, and the
finished `NCDAI.exe` will appear under **Actions → (latest run) → Artifacts**
within a few minutes. You can also trigger it manually with the "Run
workflow" button.

**Option B — on your own Windows machine:**
```bash
npm run dist
```
This builds `dist/NCDAI.exe` — copy it to
`ncdai-installer/resources/app-payload/NCDAI.exe` (the filename matters, the
installer looks for exactly that one), so the installer deploys the real app
instead of the demo placeholder.

## What to fill in before release

1. **`config.js`** — `BACKEND_URL` (the real `ncdai-backend` address),
   `LOGIN_API_URL` and `APP_WEB_URL`.
2. **`main.js`** — replace the `ipcMain.handle('auth:login', ...)` block with
   a real request to your API (registration is already real — see
   `ipcMain.handle('auth:register', ...)`, which hits
   `BACKEND_URL/api/auth/register` — nothing left to do there).
3. **`lib/updater.js`** — add checksum/signature verification before running
   the downloaded installer (the backend doesn't send `sha512` yet — add the
   field to `releases` and verify it here).
4. **`build/icon.ico`** — currently the same placeholder icon as the installer.
5. After building (`npm run dist`), the finished `NCDAI.exe` goes into
   `ncdai-installer/resources/app-payload/` — this is exactly the file the
   installer deploys to the user, alongside the `install-meta.json` it writes
   with the `installId`.

## What's next

The main pipeline (installer → app → backend → admin panel) is all in place
and actually works. From here it's a matter of taste: polish it for
production (real LOGIN_API_URL/APP_WEB_URL, update signature verification,
HTTPS for the backend), or add something new on top of it (for example,
automatically sending `/api/telemetry/uninstall` from the `Uninstall.bat`
that the installer already writes).
