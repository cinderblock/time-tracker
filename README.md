# Time Tracker

A self-hosted time tracker for small teams: phone-first, installable, works
offline, and pushes approved time into your accounting system.

Built to replace a per-seat SaaS time tracker. It is deliberately **generic** —
no organisation's name, hostname, colour or job list appears anywhere in this
repository. All of that is deployment configuration.

> **Status: phase 0 (scaffold).** The spine is in place — config, SQLite with
> migrations, the accounting seam, Docker image, CI and deploy. The tracking UI,
> auth and offline support are not built yet. See
> [`plans/time-tracker.md`](plans/time-tracker.md) for the full plan, the
> decisions already taken, and the gotchas found along the way.

## What it will do

- **Passkey-only auth.** First run creates the initial admin; admins mint
  one-time registration URLs for everyone else.
- **Three ways to record time** — start/pause/stop timers, sporadic notes that
  roll up into line items at the end of the day, and plain manual entry.
- **Offline-native.** Installed to a home screen, it keeps working when the
  backend does not: mutations queue locally and replay when the server returns.
- **Location** captured opportunistically at start, stop and notes (a PWA cannot
  track in the background — this is samples, not a breadcrumb trail).
- **Admin views** — a weekly calendar across everyone, plus summaries and
  breakdowns by job, person and category.
- **Jobs from your accounting system**, with locally-invented "provisional" jobs
  that an admin links up once the real job exists.

## Stack

Bun · React Router v8 (SSR) · Mantine v9 · `bun:sqlite` · SimpleWebAuthn · TypeScript 7 · Vite 8 · Docker

## Running locally

```bash
bun install
cp .env.example .env     # then edit: SESSION_SECRET at minimum
bun run dev
```

The defaults run standalone (`ACCOUNTING_BACKEND=none`) — no QuickBooks, no
network dependencies, jobs defined in-app.

```bash
bun run typecheck
bun test src/
bun run build
```

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
app/        React Router routes, UI, server-side loaders/actions
src/        Runtime-only modules (SQLite, accounting backends, pure helpers)
public/     Service worker and icons served at the site root
plans/      The living plan for this project — read this first
```

`src/` is externalized from the SSR bundle and copied into the runtime image
separately, which is why runtime-only code belongs there rather than in `app/`.
