# Time Tracker

A self-hosted time tracker for small teams: phone-first, installable, works
offline, and pushes approved time into your accounting system.

Built to replace a per-seat SaaS time tracker. It is deliberately **generic** —
no organisation's name, hostname, colour or job list appears anywhere in this
repository. All of that is deployment configuration or an admin setting.

> **Status: feature-complete, not yet in production.** Passkey sign-in, people
> management, time tracking (online or off), approval, rates, reports and sending
> approved time to QuickBooks Desktop (through the
> [QB Bridge](https://github.com/cinderblock/quickbooks-desktop-sdk-bridge) or the
> QuickBooks Web Connector) work end to end against a pretend QuickBooks; the
> first real deployment is under way. See
> [`plans/time-tracker.md`](plans/time-tracker.md) for the full plan, the
> decisions already taken, and the gotchas found along the way.

## What it does

- **Passkey-only auth.** No passwords, no usernames — Face ID, Touch ID or the
  device's screen lock. First run creates the initial admin; admins hand out
  one-time links (as a QR code, share sheet or copied URL) to invite people or to
  enrol someone's new phone. Admins can change roles, deactivate people (which
  signs them out everywhere), remove a lost phone's passkey, and see each person's
  devices and history. Everyone can manage their own passkeys and signed-in devices.

- **Two ways to record time**, each person's own choice (Account → How you
  track time):
  - *Timers* — start, pause, resume, stop. Switching jobs is one tap on a recent
    job and stops the old timer at the same instant. A job, a customer (for all
    its jobs) or the whole organisation can require a note before a timer stops.
  - *Notes* — add the job you're on, then jot what you do under it as you go
    (and add a second job when you move to one). Tap a note to correct it or
    move it to another job. At the end of the day (or the next morning) each
    job's notes become hours: the timeline suggests them, you confirm, and one
    entry per job carries the notes as its description. A day's notes have to
    become hours before the next day's can start.
  - *Manual entry*, either way — a start and end time (overnight shifts included)
    or just a duration, on any past day.
- **No "are you sure?".** Discarding an accidental timer or deleting an entry is
  one tap, with an Undo. Nothing is ever really deleted.
- **Jobs belong to customers.** Time is booked to a job, never to a customer
  itself; the picker lists the jobs used most recently first, then each
  customer's jobs. Jobs — and customers — can be created on the spot while
  tracking; admins open, close and rename them and choose which need notes.
- **Location**, if a person turns it on for their device, is recorded with timer
  starts, stops and notes — samples at those moments, not a trail.

- **Works offline.** Installed to a home screen, the app starts and tracks time
  with no connection, or while the server is down. Changes are kept on the device,
  shown immediately, and saved in order when the server is reachable again; the
  header says how many are waiting. A change the server refuses once it arrives
  is reported, never silently dropped. Signing out with unsaved changes warns
  first and keeps them for the next sign-in on that device.

- **Admin views.**
  - *Timesheets* — everyone's week as a people × days grid. Approve a person's
    week in one tap (or everyone's), reopen it to allow changes. Approved time is
    locked for everyone, admins included, and keeps the rate it was approved at.
  - *Calendar* — the week as blocks of time per person, pauses as gaps.
  - *Reports* — hours, approved hours and cost over a date range, grouped by
    person, customer, job, category or day, with a CSV download of every entry.
  - *Someone's day* — admins open any person's day on the same tracking screen to
    fill in or fix it; the change is recorded as made by the admin.
- **Rates and categories.** Hourly rates for everyone, a category, a person, a job
  (and its sub-jobs) or a person on a job — the most specific wins — each starting
  on a date, so a raise doesn't rewrite earlier work. Categories group people for
  filtering and rates. Weeks start on whichever day your payroll week does.
- **Settings.** Admins name the app and pick its colour (the header, the browser tab,
  passkey prompts and the home-screen icon all follow), and choose the first day of
  the week.

- **Sends approved time to QuickBooks Desktop.** Jobs, people and service and
  payroll items come from QuickBooks; each approved entry becomes one QuickBooks
  time record (date, person, job, duration, note, service item, payroll item,
  billable). Jobs made up while tracking are linked to the real job later — their
  time follows — or created in QuickBooks. QuickBooks being closed is normal:
  time waits and goes when it can, a lost answer never makes a duplicate, and
  reopened time amends the record it already made. The Accounting page says what
  is waiting and why, and what was refused.

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
bun run test         # unit tests, including real passkey ceremonies
bun run test:e2e     # builds, then drives the app in Chromium
E2E_SCREENSHOTS=/tmp/shots bun run test:e2e   # ...and saves admin-page screenshots (desktop and phone)
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

An admin changing someone else's time sends the same operations to
`POST /api/admin/people/:id/ops`; the ledger records both whose time changed and
who changed it.

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
| `PUBLIC_BASE_URL` | **Required.** The WebAuthn Relying Party origin. If it doesn't match how the browser actually reaches the app, passkey registration fails. Just the origin — no path or trailing slash; the app won't start otherwise. |
| `SESSION_SECRET` | **Required.** Signs session cookies. There is no default on purpose — a generated-at-boot fallback would log everyone out on every deploy. |
| `TZ` | The wall-clock zone that decides which day a piece of work belongs to. QuickBooks stores a bare date with no zone, so a wrong value books evening work onto the following day. |
| `ACCOUNTING_BACKEND` | `none` (default), `qb-bridge`, or `qb-webconnector`. A QuickBooks backend without its credentials stops the app at start rather than quietly sending nothing. |
| `QB_BRIDGE_URL`, `QB_BRIDGE_API_KEY` | For `qb-bridge`. Use the bridge machine's IPv4 address: bridges that only accept private addresses refuse a hostname that resolves to public IPv6. |
| `ACCOUNTING_SYNC_EVERY_SECONDS` | For `qb-bridge`: how often approved time is sent (default 60). `0` sends only when an admin presses Send now. |
| `QBWC_USERNAME`, `QBWC_PASSWORD` | For `qb-webconnector`: what the Web Connector signs in with. The password is typed into the Web Connector once. |
| `APP_NAME`, `APP_SHORT_NAME`, `APP_THEME_COLOR` | The name and colour until an admin sets them under Settings (they drive the UI theme and the generated PWA manifest). |
| `APP_CURRENCY` | ISO 4217 code rates and costs are shown in (default `USD`). Display only. |

## Accounting backends

Everything accounting-shaped sits behind one interface in
[`src/accounting/types.ts`](src/accounting/types.ts). The app core knows about
jobs, people, service items and pushing approved time — never about qbXML.

| Kind | Status | Notes |
| --- | --- | --- |
| `none` | ✅ working | Standalone. Jobs live here, nothing is pushed anywhere. |
| `qb-bridge` | ✅ built | Uses the [QB Bridge](https://github.com/cinderblock/quickbooks-desktop-sdk-bridge)'s REST routes (a version with time tracking), every `ACCOUNTING_SYNC_EVERY_SECONDS`. Endpoints and the API key's permissions: [`docs/qb-bridge.md`](docs/qb-bridge.md). |
| `qb-webconnector` | ✅ working | `/qbwc` is the SOAP endpoint the QuickBooks Web Connector polls; admins download the `.qwc` file from the Accounting page. Needs HTTPS (the Web Connector refuses anything else except `localhost`). |

The Web Connector backend speaks qbXML 13.0 through
[`src/accounting/qbxml.ts`](src/accounting/qbxml.ts); the bridge writes its own. The
sending logic
([`src/sync.ts`](src/sync.ts)) derives its work from the database each time rather
than keeping a queue, and is tested through both backends against a pretend
QuickBooks that answers qbXML
([`src/testing/fake-quickbooks.ts`](src/testing/fake-quickbooks.ts)). Every
attempt, with the full request and answer, is kept for 90 days.

**The backend owns the job, person and service-item lists; this app owns
everything about time.** Start and stop times, pauses, locations, notes and
approval state have no representation in QuickBooks — which stores only a date
plus a duration — so they live here and are never read back out.

## Deployment

On every push to `master`, CI typechecks, runs the unit and end-to-end tests,
and publishes the image as `ghcr.io/cinderblock/time-tracker:<commit sha>` and
`:latest`, labelled with the commit it was built from
(`org.opencontainers.image.revision`). **That is all this repo does.** It has no
deploy step, no self-hosted runner and no access to any host — a public
repository's Actions logs are public, and anything that can land a commit on
`master` runs in its CI.

Deploying is the deployer's, and wants three things:

- **Pin a digest, not a tag.** `ghcr.io/cinderblock/time-tracker@sha256:…` is a
  specific build; a tag can be moved by anyone who can push packages. Verify the
  image's `revision` label against the commit you meant to ship, and roll back
  by pinning the previous digest.
- **Put the reverse proxy in front.** Bind the container to `127.0.0.1` and
  terminate TLS there: passkeys and the Web Connector both need HTTPS, and
  anything that reaches the app directly makes `X-Forwarded-For` untrustworthy.
  The server believes the proxy's `X-Forwarded-*` headers when the proxy is on
  this host or a private network (`TRUST_PROXY` widens or narrows that, in
  Express's syntax), and treats `PUBLIC_BASE_URL`'s host as the one origin
  allowed to submit forms — so a proxy that forwards nothing still works, and
  a foreign site's form never does.
- **Keep the settings and the database with the deployment**, not here. The
  container reads its configuration from the environment
  ([`.env.example`](.env.example) lists it) and keeps its SQLite database in the
  volume at `/data`; back that up.

At startup the app logs its resolved settings (never the secrets) and, until an
admin exists, a one-time setup link. It refuses to start when a required setting
is missing or wrong: `PUBLIC_BASE_URL`, `SESSION_SECRET`, or the credentials of
the chosen QuickBooks backend. The image's health check makes the first request
within seconds, so that happens without waiting for a visitor.
`docker exec <container> bun run admin-link` prints a fresh admin link at any
time.

## Layout

```
app/             React Router routes, UI, server-side loaders/actions
app/tracker/     The time-tracking screen (also used by admins for someone else's day)
app/offline/     Outbox, sync engine, device copies, offline loaders
src/             Server-side modules (SQLite, auth flows, time, approval, reports, sync)
src/accounting/  Accounting backends and the qbXML encoder
src/testing/     Test helpers: the software passkey authenticator, a pretend QuickBooks and bridge
src/cli/         Operator commands (`bun run admin-link`)
e2e/             Playwright end-to-end tests (three app instances: standalone, bridge, Web Connector)
docs/            Contracts with other systems
public/          Service worker and icons served at the site root
scripts/         Build steps
plans/           The living plan for this project — read this first
```

`src/` is bundled into the server build like `app/` (so a change there needs a
rebuild before `bun run start` sees it), and is also copied into the image because
the operator commands run from source.

**Keep server code out of the browser.** `src/db.server.ts` and
`src/config.server.ts` carry the `.server` suffix, so the build fails if any page
component reaches them — even indirectly. Code the browser shares
(`src/limits.ts`, `src/time.ts`, `src/rollup.ts`, `src/ops-schema.ts`,
`src/uuid.ts`, `src/entry-status.ts`, `src/rate-scopes.ts`, `src/money.ts`) must
not import them. Typecheck doesn't catch a violation; `bun run build` does. (Without that guard, a leaked
import shows up only as a page that renders but never becomes interactive.)

## License

[MIT](LICENSE)
