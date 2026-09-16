# Time Tracker

A self-hosted time tracker for small teams: phone-first, installable, works
offline, and pushes approved time into your accounting system.

Built to replace a per-seat SaaS time tracker. It is deliberately **generic** —
no organisation's name, hostname, colour or job list appears anywhere in this
repository. All of that is deployment configuration.

> **Status: phase 3 (offline) done.** Passkey sign-in, people management and
> time tracking work end to end, online or off. The admin reports and the
> accounting sync are not built yet. See
> [`plans/time-tracker.md`](plans/time-tracker.md) for the full plan, the
> decisions already taken, and the gotchas found along the way.

## What it does

- **Passkey-only auth.** No passwords, no usernames — Face ID, Touch ID or the
  device's screen lock. First run creates the initial admin; admins hand out
  one-time links (as a QR code, share sheet or copied URL) to invite people or to
  enrol someone's new phone. Admins can change roles, deactivate people (which
  signs them out everywhere), remove a lost phone's passkey, and see each person's
  devices and history. Everyone can manage their own passkeys and signed-in devices.

- **Three ways to record time.**
  - *Timers* — start, pause, resume, stop. Switching jobs is one tap on a recent
    job and stops the old timer at the same instant. A job (or the whole
    organisation) can require a note before a timer stops.
  - *Notes* — jot what you're doing as you go; at the end of the day (or the next
    morning) review them as proposed time entries, fix them up, and add them.
  - *Manual entry* — a start and end time (overnight shifts included) or just a
    duration, on any past day.
- **No "are you sure?".** Discarding an accidental timer or deleting an entry is
  one tap, with an Undo. Nothing is ever really deleted.
- **Jobs** can be created on the spot while tracking; admins open, close and
  rename them and choose which need notes.
- **Location**, if a person turns it on for their device, is recorded with timer
  starts, stops and notes — samples at those moments, not a trail.

- **Works offline.** Installed to a home screen, the app starts and tracks time
  with no connection, or while the server is down. Changes are kept on the device,
  shown immediately, and saved in order when the server is reachable again; the
  header says how many are waiting. A change the server refuses once it arrives
  is reported, never silently dropped. Signing out with unsaved changes warns
  first and keeps them for the next sign-in on that device.

## What it will do

- **Admin views** — a weekly calendar across everyone, plus summaries and
  breakdowns by job, person and category.
- **Jobs from your accounting system**, with jobs created here first staying
  "provisional" until an admin links them to the real one.

## Stack

Bun · React Router v8 (SSR) · Mantine v9 · `bun:sqlite` · SimpleWebAuthn · TypeScript 7 · Vite 8 · Docker

## Running locally

Requires **Bun 1.4.2 or newer**. Older Bun on Windows cannot load React's
production server build, so `bun run start` dies at import there (`bun run dev`
still works).

```bash
bun install
cp .env.example .env     # then edit: SESSION_SECRET at minimum
bun run dev
```

The defaults run standalone (`ACCOUNTING_BACKEND=none`) — no QuickBooks, no
network dependencies, jobs defined in-app.

```bash
bun run typecheck
bun test src/        # unit tests, including real passkey ceremonies
bun run test:e2e     # builds, then drives the app in Chromium
bun run build
```

The unit tests exercise the passkey flows against a software authenticator
([`src/testing/soft-authenticator.ts`](src/testing/soft-authenticator.ts)) that
produces genuine attestations and signatures. The end-to-end tests
([`e2e/`](e2e/)) use Chromium's virtual authenticator. Install the browser once
with `bunx playwright install chromium`.

## First run

With no admin yet, the server prints a one-time setup link to its log every time
it starts; open it to create the first admin and their passkey. If the log line
is gone, print a fresh link on demand:

```bash
bun run admin-link                       # locally
docker exec <container> bun run admin-link
```

Once an admin exists the same command prints an *admin invite* instead — the
recovery path if every admin loses their passkeys. Setup links stop working the
moment any admin exists.

## How changes reach the server

Every change to tracking data — starting a timer, adding a note, deleting an
entry — is an *operation* with an id generated on the device, sent to
`POST /api/ops`. The server applies each at most once and records it (payload,
device and outcome) in a ledger, so a retried request can't double-book time, and
the ledger doubles as a complete audit trail. Entry, note and job ids are also
generated on the device.

Offline, the same operations wait in an IndexedDB outbox
([`app/offline/`](app/offline/)). The screen shows the server's last copy of the
day with the waiting operations applied by a client-side mirror of the server's
rules, which is tested against the real server code. A service worker keeps the
app's files (the list is stamped into it at build time by
[`scripts/finalize-build.ts`](scripts/finalize-build.ts)) and the tracking pages.

## Configuration

Everything comes from the environment; see [`.env.example`](.env.example) for the
annotated list. The ones worth calling out:

| Variable | Why it matters |
| --- | --- |
| `PUBLIC_BASE_URL` | **Required.** The WebAuthn Relying Party origin. If it doesn't match how the browser actually reaches the app, passkey registration fails. No trailing slash. |
| `SESSION_SECRET` | **Required.** Signs session cookies. There is no default on purpose — a generated-at-boot fallback would log everyone out on every deploy. |
| `TZ` | The wall-clock zone that decides which day a piece of work belongs to. QuickBooks stores a bare date with no zone, so a wrong value books evening work onto the following day. |
| `ACCOUNTING_BACKEND` | `none` (default), `qb-bridge`, or `qb-webconnector`. |
| `APP_NAME`, `APP_SHORT_NAME`, `APP_THEME_COLOR` | Branding. Drives the UI theme and the generated PWA manifest. |

## Accounting backends

Everything accounting-shaped sits behind one interface in
[`src/accounting/types.ts`](src/accounting/types.ts). The app core knows about
jobs, people, service items and pushing approved time — never about qbXML.

| Kind | Status | Notes |
| --- | --- | --- |
| `none` | ✅ working | Standalone. Jobs live here, nothing is pushed anywhere. |
| `qb-bridge` | phase 5 | Talks to a REST bridge in front of QuickBooks Desktop. |
| `qb-webconnector` | phase 6 | SOAP endpoint that QuickBooks Web Connector polls. |

**The backend owns the job, person and service-item lists; this app owns
everything about time.** Start and stop times, pauses, locations, notes and
approval state have no representation in QuickBooks — which stores only a date
plus a duration — so they live here and are never read back out.

## Deployment

The image is built and published by CI on every push to `master`, then deployed
to a host by a repo-scoped self-hosted runner running [`deploy.sh`](deploy.sh).
Never deploy by hand.

`deploy.sh` materializes the container's env file fresh on every run from repo
secrets and variables, so no secrets file is ever hand-placed on a host. Set
them with `gh secret set` / `gh variable set`; the script lists exactly what it
needs and fails loudly when something required is absent.

The container binds to `127.0.0.1` only — a reverse proxy is expected to be the
sole ingress.

## Layout

```
app/          React Router routes, UI, server-side loaders/actions
app/tracker/  The time-tracking screen
app/offline/  Outbox, sync engine, device copies, offline loaders
src/          Server-side modules (SQLite, auth flows, accounting backends, helpers)
src/testing/  Test helpers, including the software passkey authenticator
src/cli/      Operator commands (`bun run admin-link`)
e2e/          Playwright end-to-end tests
public/       Service worker and icons served at the site root
scripts/      Build steps
plans/        The living plan for this project — read this first
```

`src/` is externalized from the SSR bundle and copied into the runtime image
separately, which is why runtime-only code belongs there rather than in `app/`.

**Keep server code out of the browser.** `src/db.server.ts` and
`src/config.server.ts` carry the `.server` suffix, so the build fails if any page
component reaches them — even indirectly. Code the browser shares
(`src/limits.ts`, `src/time.ts`, `src/rollup.ts`, `src/ops-schema.ts`,
`src/uuid.ts`) must not import them. (Without that guard, a leaked
import shows up only as a page that renders but never becomes interactive.)
