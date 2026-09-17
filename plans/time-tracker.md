# Time Tracker — plan

## Goal

A self-hostable, phone-first time tracker for small teams that replaces a per-seat
SaaS tracker (QuickBooks Time) and sends approved time into QuickBooks Desktop.
Employees track time on their phones, online or off; admins review and approve;
approved time lands in the accounting system.

**Constraint:** the repo is backend-agnostic and generically branded. No
organisation's names, hostnames, jobs, people or logos belong in it — all of that
is runtime configuration (environment variables) or admin settings. A
deployment's own notes (hosts, accounts, the company file, rollout) live with the
deployer, not here.

## Environment / context

| Thing | Value |
| --- | --- |
| Repo | `cinderblock/time-tracker` (public), primary branch `master` |
| Runtime | Bun 1.4.2+ (`bun.lock`), React Router 8 SSR, SQLite (`bun:sqlite`) |
| Accounting | The [QB Bridge](https://github.com/cinderblock/quickbooks-desktop-sdk-bridge) (commit `599e5d1` or later), or the QuickBooks Web Connector |
| Deployment | Docker image on GHCR; `deploy.sh` run by a self-hosted runner on the host; a reverse proxy in front (the container binds to `127.0.0.1`) |
| Deployment notes | Kept privately by the deployer |

## Decisions already made (don't re-ask)

1. **Accounting: the QB Bridge first, the Web Connector as the alternate.** Both
   are built behind one interface. The bridge already reads and writes QuickBooks;
   it was extended (2026-09-16) with the entities time tracking needs, and the app
   uses its REST entity routes (see Findings).
2. **Public and generic.** Branding (name, short name, colour) is an admin setting,
   with `APP_NAME` / `APP_SHORT_NAME` / `APP_THEME_COLOR` only as first-run
   defaults.
3. **Offline = cached shell + outbox queue.** Not a full local-first replica. The
   service worker caches the app shell and the user's own working set; every
   mutation is an idempotent operation written to IndexedDB and replayed when the
   backend returns. Running timers are local timestamp math, so a backend outage is
   invisible while clocked in.
4. **Latest majors of everything:** React Router 8, Mantine 9, Vite 8,
   TypeScript 7, SimpleWebAuthn 14, React 19.
5. **Route modules use the generated `./+types/<route>` types.** Not hand-written
   parameter types. This is not stylistic — see the `MetaArgs` finding below, where
   a hand-rolled signature type-checked cleanly and silently broke the page title.
6. **`react-dom/server.browser` is imported explicitly** in `app/entry.server.tsx`
   rather than using the bare `react-dom/server`. See the Bun/Windows finding below;
   the rationale is also written into the file itself.
7. **Report costs are bill rates** (2026-09-16): a job's rate beats a person's.
8. **Every note sent to QuickBooks ends with `[ref …]`** (2026-09-16), so a record
   whose answer was lost is found again rather than sent twice.
9. **Hosting shape:** the app runs where it can reach the bridge over the LAN (plain
   HTTP to the bridge machine's IPv4 address) and is itself served over HTTPS (the
   Web Connector refuses anything else).

## Stack

- **Bun** runtime, `bun.lock`, `bun install --frozen-lockfile` in CI.
- **React Router v8** framework mode (SSR + hydration).
- **Mantine v9** for UI — mobile-first components, good date/calendar primitives
  for the admin weekly view.
- **TypeScript 7** (the native compiler) and **Vite 8**.
- **`bun:sqlite`** with hand-rolled forward-only migrations. Single file on a
  bind-mounted host volume.
- **`@simplewebauthn/server` + `/browser`** for passkeys.
- **`idb`** (thin IndexedDB promise wrapper) for the client cache + outbox.
- **`fast-xml-parser`** for qbXML and the Web Connector's SOAP.
- **Docker** image to GHCR, deployed by a repo-scoped self-hosted runner.

## Architecture

### Backend-agnostic accounting layer

Everything QuickBooks-shaped hides behind one interface. The app core knows about
*jobs*, *people*, *service items*, and *pushing approved time* — not about qbXML.

As built (Phase 5–6):

```
src/accounting/
  types.ts          SyncRequest / SyncResult and the AccountingBackend interface
  qbxml.ts          qbXML 13.0 encoder and parser (Web Connector), shared QB helpers
  none.ts           standalone; nothing is sent
  qb-bridge.ts      push: the bridge's REST entity routes (docs/qb-bridge.md)
  webconnector.ts   poll: the /qbwc SOAP handler, sessions, the .qwc file
  index.ts          picks one from config; the only place that branches on it
src/sync.ts         what needs doing (derived from the tables), and applying outcomes
src/sync-worker.ts  the send loop for push backends
src/remote-lists.ts pulled lists, and linking people / jobs / items
```

```ts
interface AccountingBackend {
  readonly kind: "none" | "qb-bridge" | "qb-webconnector";
  readonly delivery: "none" | "push" | "poll";
  health(): Promise<BackendHealth>;
  perform(request: SyncRequest): Promise<Performed>; // push delivery only
}
```

Selected by `ACCOUNTING_BACKEND=none|qb-bridge|qb-webconnector`. `none` is the
default so a fresh clone runs with zero external dependencies — important for both
the generic-branding goal and for local development.

### Our DB is the richer record

QuickBooks `TimeTracking` stores **a date and a duration**, plus employee, customer:job,
service item, payroll item, billable flag, and a note. It has **no concept of start
and stop times, pauses, GPS, or approval state.**

So: start/stop timestamps, pause segments, location fixes, notes-before-rollup, edit
history and approval workflow live **only in our SQLite**. QuickBooks receives the
daily aggregate. This is a feature, not a limitation — it is also why the local DB
matters for "redundancy, audits, backups".

Corollary: **our DB is the source of truth for everything except the jobs/people
lists**, which QuickBooks owns. Never round-trip time data out of QB.

### Data model (SQLite)

Forward-only numbered migrations.

```
users               id, name, email?, role(admin|employee), category_id?,
                    remote_person_id?, active, created_at
employee_categories id, name (unique, case-insensitive), default_payroll_item?
credentials         WebAuthn: user_id, credential_id, public_key, counter,
                    transports, nickname, created_at, last_used_at
sessions            id, user_id, created_at, expires_at, user_agent
registrations       one-time invites: token_hash, role, created_by, expires_at,
                    used_at, user_id

jobs                id, name, parent_id?, remote_id?, remote_full_name?,
                    provisional(bool), active, created_by, created_at
                      -- remote_id IS NULL  => provisional, invented in this app
                      -- an admin later LINKS it to the real QB job; entries
                      --   already booked against it follow the link.
service_items       id, name, remote_id?, active
rates               scope(user_job|job|user|category|global), user_id?, job_id?,
                    category_id?, hourly_rate, effective_from (work date),
                    created_by, created_at, deleted_at   -- never edited in place

time_entries        id(uuid v7, CLIENT-generated), user_id, job_id,
                    service_item_id?, work_date, duration_seconds,
                    note, billable, rate_snapshot, approved_at?, approved_by?,
                    source(timer|manual|note_rollup),
                    status(open|draft|submitted|approved|synced|sync_failed),
                    remote_txn_id?, remote_edit_sequence?,
                    device_id, created_at, updated_at, deleted_at
time_segments       id, entry_id, started_at, ended_at?   -- pause/resume
day_notes           id, user_id, at, text, job_id?, rolled_into_entry_id?
locations           id, entry_id?, segment_id?, note_id?, at, lat, lon,
                    accuracy_m, kind(start|stop|periodic|note)

applied_ops         op_id PRIMARY KEY, user_id, actor_user_id, type, device_id,
                    client_time, applied_at, payload_json, ok, result_json
                      -- idempotency ledger; actor differs from user when an
                      -- admin changed someone else's time
audit_log           id, actor_user_id, at, entity, entity_id, action,
                    before_json, after_json, device_id   -- append-only
sync_attempts       id, entry_id, backend, at, ok, request, response, error
settings            key, value
```

Notes on specific columns:

- **`time_entries.id` is a client-generated UUID v7.** An entry created offline must
  keep its identity when it syncs; a server-assigned autoincrement cannot do that.
  v7 sorts by creation time, which is handy for the timeline.
- **`deleted_at` (soft delete), never hard delete.** This is what makes "simple quick
  undo" safe and what makes the audit trail honest.
- **`rate_snapshot`** freezes the rate that applied when the entry was approved, so
  changing a rate later doesn't silently rewrite history.
- **`applied_ops`** is the idempotency ledger. Replaying an op whose `op_id` is
  already present returns the stored result instead of applying it twice.

### Rate resolution

Most specific wins: `user+job` → `job` → `user` → `category` → global default
(`src/rates.ts`). Job rates cover sub-jobs; within a scope the nearest job up the
tree wins. Each rate has an effective-from date and the latest one on or before
the work date applies, so a future-dated rate doesn't hide an older, broader
one. Setting a rate for the same target and date replaces it (old row kept,
marked deleted). Resolved at approval time and frozen into `rate_snapshot`;
reports cost unapproved time at the rate currently in effect.

### Offline model

**Client → server is a stream of operations, not REST writes.**

```ts
type Op = {
  op_id: string;        // uuid v7, generated on the device
  device_id: string;    // stable per install
  client_time: number;  // device clock at the moment of the action
  type: "timer.start" | "timer.pause" | "timer.resume" | "timer.stop"
      | "entry.create" | "entry.update" | "entry.delete" | "entry.restore"
      | "note.create"  | "note.update"  | "note.delete"
      | "rollup.commit";
  payload: unknown;
};
```

- Every user action writes an `Op` to IndexedDB **and** optimistically updates the
  local cache, then attempts `POST /api/ops`.
- Offline or failed → the op stays queued; a `sync` loop drains the queue in order on
  reconnect, on visibility change, and on a timer.
- The server applies ops in the order received, skipping any `op_id` already in
  `applied_ops`, and returns authoritative entity state.
- **Clock skew:** durations are computed from *client* timestamps (the device is the
  only thing that knows when the timer actually started), but the server also records
  its own receive time. Entries whose skew exceeds a threshold get flagged for admin
  review rather than silently corrected.

**Service worker** (`public/sw.js`, hand-written, no Workbox):

- Content-hashed build assets → cache-first (they are immutable).
- Document requests → network-first with a cached app-shell fallback, so launching
  the installed app offline still boots.
- `/api/*` → never cached; the client reads its own IndexedDB instead.
- Also hosts Web Push.

**Route data** uses React Router `clientLoader` reading IndexedDB first and
revalidating from the network in the background, so client-side navigation works with
no server at all. Server `loader`s remain for the first paint.

### Recording modes

1. **Timer** — start / pause / stop, persisted as `time_segments` so a pause is a real
   gap rather than a subtracted number. Per-job or global setting can require a note
   before a stop is accepted.
2. **Sporadic notes → daily rollup** — `day_notes` captured freely through the day,
   then a review screen (end of day, or next morning) groups them into `time_entries`.
   The rollup is a *proposal* the user edits and commits; committing is one op.
3. **Manual** — type a duration, or a start and stop time. Same `time_entries` row,
   `source='manual'`.

**Phase 2 design details** (decided while building it):

- **All tracking writes are ops from day one.** Phase 2 already sends every change
  as an `Op` to `POST /api/ops`, applied through the `applied_ops` idempotency
  ledger. Phase 3 then only has to put an IndexedDB outbox in front of the same
  endpoint — no rewrite of the write path. Payloads are validated with zod (v4);
  the schemas live in a dependency-free module the browser also imports.
- **Entry and note ids are UUID v7, generated on the device.**
- **Timer state machine.** An entry with `status='open'` is a running or paused
  timer (paused = no open segment). The partial unique index guarantees at most one
  per person. Starting a timer while another is open *switches*: the old one stops
  at the same instant. Stop moves it to `draft`.
- **Required notes** (global setting or per-job `requires_note`) are enforced on
  every stop, including the implicit stop of a switch. The server answers with a
  `note_required` code and the client asks for the note, rather than the server
  silently letting it through.
- **Deleting a running timer and undoing it** resumes it seamlessly if nothing else
  was started in between; if something was, the restored timer comes back stopped
  at the moment it was deleted. Deletion is always soft.
- **A timer's work date is the date it started.** An overnight shift is booked to
  the start date. Splitting at midnight is deliberately not done: QuickBooks
  aggregates per day, and splitting would invent two entries the person never made.
- **Rollup algorithm.** Notes are sorted by time; each note says "from here on I'm
  doing X", so a note's line runs until the next note, and the last one until an
  end time the person confirms. Consecutive notes on the same job merge into one
  line. Lines without a job must be given one (or dropped) before committing.
- **Ops are rejected, never silently corrected**, when they don't make sense (a
  stop for a timer that isn't running, an end before a start). Rejections are
  stored in the ledger too, so a replay gets the same answer; unexpected server
  errors are not stored, so the client retries them.

### Undo

Delete is immediate and unconfirmed, as requested. It sets `deleted_at` and shows a
toast with **Undo** for ~10 seconds (`entry.restore` op). Deleted rows remain visible
to admins in a trash view and in the audit log. Nothing is ever hard-deleted, so the
"accidentally started a timer for a minute" case costs one tap and leaves a clean
record.

### Auth

Passkey-only. Details below are the Phase 1 design.

- **One registration mechanism, three purposes.** A `registrations` row is a one-time
  link: `bootstrap` (first admin), `invite` (new person, role chosen by the admin), or
  `add_device` (an existing person on a new phone — the lost-phone path). Only the
  SHA-256 of the token is stored.
- **First run.** While no active admin exists, every server start revokes any unused
  `bootstrap` link and prints a fresh one to the log. (A link printed
  only once would be lost with that log line.) A setup screen open to
  whoever arrives first was rejected: on a public URL that is a race to become admin.
- **Recovery / ops:** `bun run admin-link` (works inside the container via
  `docker exec`) mints a one-time admin link on demand — for a missed log line, or for
  recovery if every admin has lost their passkey. The e2e test uses the same command.
- **The link is consumed only when a passkey is actually registered.** Opening it, or
  cancelling the Face ID prompt, does not burn it. `/join/:token` moves the token into
  a short-lived signed cookie and redirects, so it doesn't sit in history.
- **Users are created at verify time, not when the link is opened.** The WebAuthn user
  handle is 32 random bytes (`users.webauthn_user_id`), never the row id.
- **Discoverable passkeys, user verification required.** No usernames at sign-in.
- **Unknown passkey at sign-in** (deleted server-side) → the client calls the WebAuthn
  Signal API (`sendSignal('unknownCredential')`, new in SimpleWebAuthn 14) so the
  phone's passkey manager hides it, rather than leaving a dead passkey to be tapped
  forever.
- **Sessions:** random token in a signed, HTTP-only, `SameSite=Lax` cookie; the DB
  stores only its SHA-256. 180-day *sliding* expiry, refreshed at most daily — a field
  employee who opens the app weekly is never logged out, while a lost phone's session
  dies after six months of disuse. Deactivating a person revokes all their sessions.
- **Auth runs as React Router 8 middleware** on the root route, placing the current
  user (or null) in a typed router context. Loaders read it; `requireUser` /
  `requireAdmin` redirect or 403.
- **State-changing API calls check `Origin`** against `PUBLIC_BASE_URL`, on top of
  `SameSite=Lax`.
- **Guards:** the last active admin cannot be demoted or deactivated; a person cannot
  remove their own last passkey (that is a lockout — an admin mints an `add_device`
  link instead).
- **Everything security-relevant is audited** — person created, role/active changes,
  passkey added/removed/renamed, sessions revoked, links minted/revoked/consumed.
- **Migration `001_initial` is edited in place for this**, not followed by a `002`:
  nothing has been deployed, so there is no database to migrate. **From the first
  deploy onward, `001` is frozen.**

### Admin (Phase 4, as built)

- **Approval is the gate to sync.** Entries are `draft` until an admin approves
  them (per person per week, or per entry); approval freezes `rate_snapshot` and
  locks the entry — for admins too, until they explicitly *reopen* it. Running
  timers can't be approved. Phase 5 pushes only approved entries. There is no
  employee "submit" step for now: QuickBooks Time's own approval is admin-side,
  and a submit step can be added later without changing the model.
- **Weeks start on a configurable weekday** (`week_starts_on` setting, default
  Sunday) because payroll weeks differ; the day screen's week strip and every
  admin week use it.
- **Rates:** one hourly rate concept used for costing in reports. Most specific
  wins — person+job, job, person, category, organisation default — and each rate
  has an *effective-from date*, so a raise applies from its date without
  rewriting history. Reports treat them as bill rates (decision 7).
- **Categories** group people (e.g. "Field", "Shop") for filtering and a default
  rate.
- **Admins act on someone's day with the same tracking screen**, in an
  "acting for" mode: ops go to `POST /api/admin/people/:id/ops`, applied to
  that person with the admin recorded as actor (a new `applied_ops.actor_user_id`
  column; migration `001` is still unfrozen). This path is online-only and
  bypasses the outbox, whose queue belongs to the signed-in person.
- **Views:** a people × days grid (totals and approval state per cell, approve a
  person's week in one tap), a week calendar of entries as time blocks, and a
  reports page (date range; by person, job, category; hours and cost; CSV).

As built:

| Page | Route | What it does |
| --- | --- | --- |
| Timesheets | `/admin/timesheets?week=&category=` | People × days (`h:mm` per day, shaded when approved, outlined while a timer runs); approve or reopen a person's week; approve everyone shown. Rows become cards on phones. |
| Calendar | `/admin/calendar?week=&person=&category=` | One block per segment (pauses are gaps), coloured per person, overlaps side by side (`app/components/calendar-layout.ts`, tested); typed-in durations listed above the grid; one day at a time on phones. Blocks link to that person's day. |
| Reports | `/admin/reports?range=&from=&to=&by=&person=&category=&job=` | Presets (this/last week, this/last month, picked dates, capped at 400 days); group by person, customer (top of the job tree), job, category or day; hours, approved hours, cost, unrated time; inline share bars. |
| CSV | `/admin/reports.csv?…same…` | One line per entry; formula-looking cells are defused with a leading apostrophe; UTF-8 BOM for Excel. |
| Rates & categories | `/admin/rates` | Set/remove rates (scope, target, date), categories (add, rename, delete with a confirmation that spells out the consequences). |
| Settings | `/admin/settings` | The app's name, short name and colour (with a preview; blank goes back to the environment's defaults), and the week-start day. |
| Someone's day | `/admin/people/:id/time/:date?` | The tracking screen in acting-for mode (below). |

- **Acting-for mode** (`TrackerProvider actingFor`): ops go to
  `POST /api/admin/people/:id/ops` directly (never the outbox, which belongs to
  whoever is signed in), are overlaid on screen until a copy fetched after the
  server's confirmation arrives (the same rule as the outbox), carry no location,
  and day links stay under the person's path. A purple banner names whose time it
  is. A failed send is reported and dropped — there's no queue.
- **Locking** lives in `src/entry-status.ts` (browser-safe) and is enforced in
  `entries.ts` and mirrored in the reducer. Locked entries show an "approved"
  badge, no Delete, and aren't tappable.
- **Money** is display-only, in `APP_CURRENCY` (default USD).

### Sync to QuickBooks (Phase 5–6 design)

- **Two transports.**
  - *QB Bridge* — the app uses the bridge's REST entity routes (customers,
    employees, vendors, other-names, items/service, payroll-items/wage,
    time-tracking), listed in `docs/qb-bridge.md`, with a key that reads
    everything and writes only time (and adds customers). The first design
    here was a new raw `/qbxml` passthrough on the bridge; reading the bridge
    showed a generic entity registry with per-key, per-entity permissions, so
    registering three entities was smaller and gave a least-privilege key.
  - *Web Connector* — a SOAP endpoint (`/qbwc`) that QBWC on the QuickBooks
    machine polls, plus a `.qwc` file admins download. Pull-based: work waits
    until QBWC calls, one request per `sendRequestXML`. It speaks qbXML, built
    and parsed once in `src/accounting/qbxml.ts`.
- **Work is derived from state, not queued separately.** What needs doing is
  read from the tables each time: approved entries not yet sent (add, or mod if
  they were sent before and reopened), deleted entries that exist remotely
  (delete), provisional jobs an admin asked to create remotely (add), and a
  list pull when the last one is stale or was requested. Failures record
  `sync_error` and a backoff time on the row. Nothing can drift out of step
  with a separate queue.
- **One `TimeTracking` record per entry**, not one per (person, day, job): a 1:1
  mapping keeps each entry's note, makes reopening and correcting exact (a
  `TimeTrackingMod` with the stored `EditSequence`, or a `TxnDel`), and needs no
  bookkeeping of which entries make up which remote record. (Changes the
  earlier aggregate-per-day sketch.)
- **Duplicates are impossible to rule out without a key**, because a send can
  succeed in QuickBooks while the answer is lost. Each pushed note ends with a
  short reference (`[ref 1a2b3c4d5e6f]`, the random tail of the entry id); a
  retry after an uncertain outcome first queries that person's records for the
  date and adopts a match instead of adding again.
- **Pull** (hourly while reachable, and on demand): Customers (jobs are
  customers with a parent), Employees, Vendors, Other Names, service items,
  wage payroll items. Customers become `jobs` rows keyed by `remote_id`;
  people and items go to `remote_people` / `remote_items`. Remote names are
  authoritative for remote jobs (no local rename); a job inactive in QuickBooks
  can't take time.
- **Linking.** People: an admin picks each person's QuickBooks name (Employee,
  Vendor or Other Name). Provisional jobs: an admin either *links* one to an
  existing QuickBooks job — the provisional job is merged into it (entries,
  notes, rates and sub-jobs move; the old id forwards via `merged_into`, so a
  phone still holding it offline keeps working) — or asks to *create* it in
  QuickBooks.
- **What a pushed record carries:** date, person, job, duration (to the
  minute), note, service item (entry's job or the nearest parent with one, else
  the organisation default), payroll wage item (Employees only: the person's,
  else their category's, else the organisation default), and billable status
  (billable only with a job and a service item).
- **Not ready yet** is a state with a reason, not an error: person not linked,
  job provisional, job inactive in QuickBooks. The Accounting page lists them
  with the fix.
- **Reopening sent time** is allowed: the entry goes back to draft keeping its
  remote id; re-approving sends a Mod, deleting sends a delete. Until then
  QuickBooks still has the old values, and the Accounting page says so.
- **Standalone (`none`)**: approved is final; nothing is sent.
- Every attempt is recorded in `sync_attempts` with the full request and
  response. QuickBooks being unreachable is normal and never blocks tracking.

## Plan / steps

- **Phase 0 — Scaffold.** ✅ *done.* Repo, Bun + React Router + Mantine skeleton,
  config module, SQLite + migrations, Docker/compose/deploy.sh, CI workflows.
- **Phase 1 — Auth.** ✅ *done.* Passkeys, first-admin bootstrap, one-time invite and
  device links, sessions, people admin, account page.
- **Phase 2 — Core tracking (online).** ✅ *done.* Jobs (incl. provisional), timers with
  segments, manual entries, notes, undo. Mobile-first UI.
- **Phase 3 — Offline.** ✅ *done.* Service worker, IndexedDB cache, outbox, op endpoint +
  idempotency ledger, `clientLoader` wiring, PWA manifest and install.
- **Phase 4 — Admin.** ✅ *done.* Weekly calendar across employees, summaries/breakdowns,
  categories, rates, approval workflow.
- **Phase 5 — QuickBooks through the bridge.** ✅ *done.* Client, pulls, pushes,
  linking UI, Accounting page; the bridge's time-tracking support is published.
- **Phase 6 — Web Connector.** ✅ *done.*
- **Phase 7 — First deployment.** ⬅️ *current.* Deployment-specific; tracked in the
  deployer's notes. Freeze migration `001_initial` before a production database
  exists. Unverified until then: a real QuickBooks company file, and passkeys in
  an installed PWA on a real iPhone (17.4+ recommended; 16.4+ for push).

Location capture and note-taking are folded into phases 2–3 rather than being their
own phase; they are properties of the entry UI, not separate features.

## Findings / gotchas

- **QuickBooks is usually unreachable.** A bridge only answers while its process runs
  in a logged-in session on the QuickBooks machine, and the Web Connector only calls
  while it's open; "can't connect" is the normal state, which is why sending is a
  retrying background job that never blocks tracking. **Host reachable ≠ bridge up.**
- **Give the bridge an IPv4 address, not a hostname.** The bridge only accepts
  private source addresses and checks that *before* the API key; a hostname that
  resolves to a public IPv6 address sends traffic out and back over the internet and
  the refusal (`403 FORBIDDEN_IP`) looks like an auth failure.
- **Deploy runners: keep the admin token off the box.** A self-hosted runner for this
  repo is registered with a short-lived registration token minted by a hosted job
  that alone holds the admin PAT; only that token reaches the server. Never treat a
  transient GitHub API error as "the runner is gone".
- **GitHub holds a workflow that hands `toJSON(secrets)` to a step** (2026-09-16).
  The first push to the public repo produced a Deploy run with no jobs, conclusion
  `action_required`, and on its page: "GitHub detected that this workflow file may
  be malicious. It will not run until someone with write access approves it." The
  deploy step got every secret as one JSON blob, on a self-hosted runner — the
  shape of an exfiltration. It's also more than the step needs, so secrets are now
  passed one by one; only non-secret variables still arrive as `ALL_VARS`. The
  REST endpoint for approving a run only works for fork pull requests (403).
- **Bind the container to `127.0.0.1` only.** The reverse proxy
  must be the sole ingress or any `X-Forwarded-For` trust is unsound.
- **iOS PWA limitations that shape the design** (all need verification on a real
  device, Phase 7):
  - No background geolocation. Location can only be sampled while the app is
    foregrounded — so capture fixes at start/stop/note, and be honest in the UI that
    there is no continuous breadcrumb trail.
  - Web Push needs iOS 16.4+ *and* the app installed to the home screen.
  - Safari can evict IndexedDB after ~7 days without use. Call
    `navigator.storage.persist()` and treat the local cache as a cache, never as the
    only copy of an unsynced op — surface a visible "N unsynced" indicator.
  - WebAuthn inside a standalone PWA was unreliable before iOS 17.4.
- **QuickBooks `TimeTracking` has no start/stop times**, only date + duration. Design
  around it (see "Our DB is the richer record"); do not try to encode times into the
  note field.
- **`bun run start` fails on Windows with Bun 1.3.0; `bun run dev` is fine.** Importing
  react-dom's *production* CJS build under Bun 1.3.0 on Windows dies at import:

  ```
  TypeError: Expected CommonJS module to have a function wrapper.
    at node_modules/react-dom/server.browser.js:5:3
  ```

  Narrowed down precisely:

  | | Windows, Bun 1.3.0 | Linux (WSL), Bun 1.4.2 |
  | --- | --- | --- |
  | `NODE_ENV=development` import | works | works |
  | `NODE_ENV=production` import | **fails** | works |
  | `bun run dev` | works | works |
  | `bun run build` / `typecheck` / `test` | works | works |
  | `bun run start` | **fails** | works |

  So it is a Bun-on-Windows bug against React 19's minified CJS, not a problem with
  this app. **Production is unaffected** — the image is `oven/bun:1` on Linux, and a
  clean install + build + run there was verified end to end (migration applied,
  branding honoured, `GET / 200`).

  **Confirmed fixed in Bun 1.4.2 on Windows (2026-09-16).** Tested with a standalone
  1.4.2 binary unpacked to a temp dir and put first on `PATH`, leaving the installed
  1.3.0 untouched: `bun run start` served the production build (`GET / 200`, correct
  `<title>`). So the fix is `bun upgrade` on this workstation. It is still a
  machine-wide toolchain change that touches every other project here, so it is left
  for the user to run; `package.json` now declares `engines.bun >= 1.4.2` to record
  the floor. Until then, develop with `bun run dev`.

  Changing the entry point does **not** work around it: the failure follows whichever
  react-dom production CJS file gets loaded (`server.bun.js` and `server.browser.js`
  both fail identically). The explicit `react-dom/server.browser` import in
  `app/entry.server.tsx` is still right — it is the correct Web Streams build for a
  Bun server — it just isn't a fix for this.
- **Vite's dev server binds `localhost`, which can be IPv6-only here.** Curling
  `http://127.0.0.1:<port>` returns nothing while `http://localhost:<port>` works.
  Cost half an hour of chasing a phantom startup failure; use `localhost` when
  smoke-testing dev.
- **Migration notes from the move to current majors** (all applied, all verified):
  - **`MetaArgs` gives `loaderData`, not `data`.** The old hand-written signature
    `meta({ data }: { data?: ... })` still *compiled* — because the parameter type
    was self-declared, TypeScript happily checked it against a shape nothing
    produces — and every page silently rendered the fallback `<title>`. Caught only
    because the generated manifest showed the right name while the title did not.
    **This is why route modules must use the generated `./+types/<route>` types**:
    `Route.MetaArgs` and `Route.ComponentProps` are derived from the real module, so
    the same mistake becomes a compile error.
  - **`AppLoadContext` is gone** from `react-router`; the server entry's fifth
    argument is now `RouterContextProvider`, the middleware context object.
  - **TypeScript 7 removed `baseUrl`** (`error TS5102`). `paths` entries resolve
    relative to `tsconfig.json`, so the `./app/*` prefix carries the meaning
    `baseUrl: "."` used to.
  - **Vite 8 resolves tsconfig `paths` natively** via `resolve.tsconfigPaths: true`,
    and warns that `vite-tsconfig-paths` is redundant. The plugin is dropped.
  - **Vite 8 bundles config with rolldown, which rejects malformed JSON outright** —
    a stray trailing comma in `package.json` fails the build with an
    `UNHANDLEABLE_ERROR` pointing at rolldown's issue tracker rather than at the
    comma. Read past the stack trace to the `JSONError` line, which names the file,
    line and column.
  - The five `v8_*` future-flag warnings are gone; those behaviours are now default.
- **Server code leaking into the browser bundle kills hydration silently.** A page
  component imported `NAME_MAX_LENGTH` from `src/users.ts`; that module imports the
  database and `config`, so `config` ran *in the browser*, threw
  `Missing required environment variable: PUBLIC_BASE_URL`, and React never
  hydrated. The page still rendered (SSR) and looked fine — the only symptom was a
  button that stayed disabled after typing. Found by capturing `pageerror` in
  Playwright. **Fix, and the guard against recurrence:** `src/db.server.ts` and
  `src/config.server.ts` carry the `.server` suffix, so React Router now *fails the
  build* ("Server-only module referenced by client") if any client code reaches
  them, directly or transitively. Values the browser needs live in dependency-free
  modules (`src/limits.ts`). When a component needs a constant from `src/`, put the
  constant somewhere with no server imports.
- **The one-time link reveal must be the whole screen on a phone.** As a centred modal
  the URL ran off the edge and a success toast covered its Done button. Now
  `fullScreen` below 36em, the URL wraps, and link actions return no toast — the
  dialog is the confirmation. Found by screenshotting at iPhone 15 size.
- **Setup links outliving setup were an admin backdoor.** The startup bootstrap link
  stayed valid (and listed) after the first admin existed, so anyone who could read
  the server log could make themselves an admin. Now: bootstrap links are unusable
  whenever an active admin exists, completing one revokes the rest, and the "no admin
  yet" check is repeated *inside* the enrollment transaction so two setup links
  finished at once can't both succeed. Covered by unit and e2e tests.
- **Git Bash strips `TZ` before starting Windows programs** (`TZ=... bun -e` prints
  `undefined`). A server started from Git Bash therefore reports UTC. Not an app bug;
  pass `TZ` via PowerShell, a Node `spawn` env, or Playwright's `webServer.env`.
- **Git Bash also rewrites `/mnt/c/...` arguments to `wsl`** into Windows paths
  (`C:/Program Files/Git/mnt/c/...`). Invoke `wsl` from PowerShell instead.
- **The Write tool turned `\u0000`-style escapes inside regex/string literals into
  real control characters** (twice: `safe-redirect.ts`, `small-units.test.ts`),
  producing "binary" source files and a regex parse error. Build such characters
  with `String.fromCharCode` or char-code checks so the source stays plain text.
- **Passkeys are tested two ways, both real.** Unit tests use
  `src/testing/soft-authenticator.ts` — a software P-256 authenticator producing
  genuine CBOR attestations and signed assertions that SimpleWebAuthn verifies — so
  the flows' transactional edge cases (link races, wrong origin, replayed ceremony)
  run in milliseconds without a browser. `e2e/` drives the production build in
  Chromium with a CDP virtual authenticator for the browser half.
- **A save-on-blur that marks the screen busy eats the next tap.** Typing a note
  and tapping Stop: the textarea's blur fired an `entry.update`, `pending` went
  true, React disabled Stop before the click event arrived, and the tap did
  nothing — the note saved, the timer kept running. Found by the e2e test; a real
  phone user would hit it every time. Fix: `dispatch(…, { background: true })`
  for side-effect saves, which don't count toward `pending`.
- **Dialogs must not rebuild their form on every data refresh.** The entry
  editor and the rollup review reset their state in an effect that depended on
  model arrays; any revalidation (e.g. creating a job from inside the dialog)
  gives those arrays a new identity and would wipe what the person typed. They
  now reset only when opened, reading defaults through a ref.
- **Mantine 9 specifics met in Phase 2:** `Grid` takes `gap`, not `gutter`; a
  searchable `Select` has the ARIA role `combobox`; a required field's `<label>`
  text includes the asterisk ("Start *") while its accessible name doesn't, so
  e2e tests locate inputs with `getByRole(…, { name, exact: true })`.
- **A route's `meta` replaces its parents' entirely** (React Router 8), so the
  root's branded title vanished on every child page. `app/meta.ts`'s
  `pageTitle(matches, "Page")` reads the app name from the root match.
- **ICU versions disagree on the space before AM/PM** (a narrow no-break space in
  newer builds). `formatClock` normalises it; otherwise server- and
  browser-rendered times differ and React reports a hydration mismatch.
- **Offline design as built (Phase 3).**
  - *Screen = server copy + pending ops.* `applyPending(snapshot, ops)` runs on
    every render with the outbox's ops. It must match the server exactly, so
    `app/offline/reducer.test.ts` runs the same ops through the real server code
    and the reducer and compares whole day models — it found four real
    divergences on its first run (restore end time, recent jobs after rollup and
    job change, entry ordering). Recent jobs are the one deliberate
    approximation (a subset check).
  - *One ordering rule for both sides:* timed entries by start, untimed by UUID v7
    id, ties by id compared as plain strings (SQLite's order).
  - *Confirmed ops stay applied until a copy fetched after the confirmation
    arrives* (`reflect(fetchedAt)`), and the reducer skips anything a copy
    already shows — so there's no flicker between "confirmed" and "refreshed".
  - *Client loaders run during hydration* (`clientLoader.hydrate = true`)
    because the page itself may be a service-worker copy: the device's copy wins
    if the server produced it later (`generatedAt`, server clock). The worker
    marks pages it serves from its store (`<meta name="tt-kept-copy">`) so the app
    shows "Offline" and keeps retrying.
  - *A day never opened on this device* is synthesized from the latest copy (jobs,
    settings, running timer) and says it doesn't know that day's time, rather
    than claiming it's empty.
  - *Queued ops are tagged by person* and only sent while that person is signed
    in; sign-out warns when changes are unsent, keeps them, and clears the
    person's cached days and kept pages.
- **Two sync-engine concurrency bugs, found by running the tests on Linux.**
  (1) `await flush()` called mid-send resolved when the *earlier* send finished,
  not after a send that included the caller's ops — now a request made mid-send
  gets a follow-up. (2) Worse: `reload()` stored its result even if a different
  person had signed in while it was reading, so one person's send could pick up
  another's queue and the server would book it to whoever is signed in now.
  Now a stale read is discarded and every batch is filtered to the sending
  person. Both have deterministic tests, each confirmed to *fail* against the
  broken code (a first attempt at each test passed either way — it didn't force
  the interleaving — and was rewritten until it did).
- **Test-writing traps met in Phase 3:** the e2e user "Olive Offline" matched a
  check for the word "Offline"; with a timer running, "Note" names two fields;
  sign-out is now async (it clears device data first), so tests must wait for
  the sign-in page; going back online syncs immediately, so a simulated outage
  must be in place *before* reconnecting.
- **Phase 4 traps.**
  - *The build is the only thing that catches a server module in a page.*
    Typecheck passed while the rates page imported a constant from `rates.ts`
    (which reaches `db.server.ts`) and the reports page one from
    `admin.server.ts`; `react-router build` refused both ("Server-only module
    referenced by client"). Fix pattern: move the constant into a
    dependency-free module (`src/rate-scopes.ts`, `app/report-ranges.ts`) and
    re-export it from the server module. Run the build, not just typecheck,
    after touching page imports.
  - *Spreading a helper's result into a loader can shadow a field.*
    `calendarWeek()` returns `people`; spreading it after `people:
    peopleOptions()` silently replaced the picker options. Typecheck caught it
    only through the component's use; name loader fields distinctly.
  - *The Write tool turns `\u` escapes into the literal character* — a
    `"\uFEFF"` BOM landed in the source as an invisible real BOM. Use
    `String.fromCharCode(...)`; the pre-commit control-character scan now also
    looks for U+FEFF.
  - *Git Bash heredocs containing backticks fail to parse in this harness*
    ("unexpected EOF while looking for matching `'`"), even when quoted. Write
    edit scripts to a file first.
  - *Playwright full-page screenshots draw the fixed header mid-page.* It's an
    artifact of stitching, not a layout bug.
- **The QB Bridge, as found (2026-09-16).** It already read *and* wrote QuickBooks: a
  registry of entities (`qb/entities.py`) generates list/get/create/update/delete
  routes (`api/routes/crud.py`) with per-key, per-entity permissions. Missing for
  time tracking were the TimeTracking, OtherName and PayrollItemWage entities, and
  TimeTracking queries differ from other transactions (no RefNumber, no line items,
  `TimeTrackingEntityFilter` instead of `EntityFilter`). All added and tested in the
  bridge (commit `599e5d1`). Its README said `uv sync --group dev`; the dev tools are
  an optional extra (`--extra dev`), also fixed there.
- **Phase 5–6 findings.**
  - *`src/` is bundled into the server build.* A change in `src/` did nothing to a
    running `bun run start` until `bun run build` — the Dockerfile comment saying
    Vite externalizes `src/` was wrong and is fixed. Always rebuild before e2e.
  - *A toast owned by a row that the change removes never shows.* Linking or
    creating a job removes its row on revalidation, and the row's
    `useFetcher`/`useActionFeedback` went with it — flaky, depending on whether
    the data and the revalidation landed in one render. Rows that can vanish now
    use their parent's fetcher (jobs page, categories, provisional jobs).
  - *Mantine `Select` deselects when the chosen option is clicked again*
    (`allowDeselect` defaults to true). The time editor preselects the last job,
    so tapping that job cleared a required field. `JobSelect` now sets
    `allowDeselect={!required}`.
  - *`formatRelative` said "just now" for times in the next minute.* It now says
    "in under a minute".
  - *The Accounting page's health check is itself a request*, so a test's
    "refuse the next request" was spent on it. Inject failures after the page
    loads.
  - *`provisional` is stored from the config at creation*, so tests with an
    injected backend but `ACCOUNTING_BACKEND=none` create non-provisional jobs.
    Readiness uses `remote_id`, which is what matters.
  - *A toast is not proof that this click finished.* On GitHub's runner the
    linking test's "Send now" check was satisfied by the previous test's
    identical "Sent 1 request." toast, still on screen, and the bridge showed one
    record instead of two (passed locally, where the old toast had faded).
    `sendNow` now waits for its own POST answer and checks the message in it.
  - *UUID v7 ids made in the same millisecond sorted at random.* The rest of the
    id was fresh randomness, so "v7 sorts by creation time" only held across
    milliseconds: 4,980 of 10,000 same-millisecond pairs came out reversed.
    Sending (`ORDER BY work_date, id`) and the untimed-entry order depend on it;
    a Web Connector test that assumed the first-made entry goes first failed on
    GitHub's faster runner. `uuidv7()` now counts up by a random step within a
    millisecond (RFC 9562 §6.2); a time passed in is always kept as given.
  - *fast-xml-parser leaves numeric character references alone* unless
    `htmlEntities: true`; QuickBooks uses them for non-ASCII.
  - *Harness traps:* the Bash tool rewrites `\t`, `\b` and similar escapes even
    inside quoted heredocs, and fails on heredocs containing backticks; the Write
    tool turns `\uXXXX` into the literal character. Edit files with the Edit tool
    or scripts written with Write, use `String.fromCharCode` for odd characters,
    and scan for control characters before committing.
- **React inserts `<!-- -->` between adjacent JSX text expressions.** Grepping
  rendered HTML for `computed in America/Los_Angeles` finds nothing, because the
  markup is `computed in <!-- -->America/Los_Angeles`. Not a bug — but it will fool
  a naive HTML assertion, so match on the value alone.

## Progress log

- [x] 2026-09-15 — **Phase 0 complete.** Bun + RR7 + Mantine skeleton; `src/config.ts`
      (env-driven); `src/db.ts` (both since renamed `.server.ts`) with migration `001_initial` covering the
      whole data model; `src/time.ts` + 12 passing tests; the `AccountingBackend`
      seam with a working `none` implementation; generated PWA manifest and
      placeholder icons; service worker (installability only); Dockerfile,
      compose, `deploy.sh`, CI and deploy workflows; README.
      Verified: `typecheck` clean, `bun test src/` 12/12, `bun run build` clean,
      `bun run dev` serves on Windows, and a clean Linux install/build/run works.
- [x] 2026-09-15 — Moved the whole dependency set to current majors (React Router 8,
      Mantine 9, Vite 8, TypeScript 7, SimpleWebAuthn 14) at the user's direction.
      Four migration fixes applied; re-verified on Linux end to end, including that
      the page title now reflects `APP_NAME` again.
- [x] 2026-09-16 — Confirmed Bun 1.4.2 fixes `bun run start` on Windows (isolated
      binary; installed 1.3.0 untouched). `engines.bun >= 1.4.2` recorded.
- [x] 2026-09-16 — **Phase 1 complete.** Passkey registration and sign-in
      (SimpleWebAuthn 14), one-time `bootstrap` / `invite` / `add_device` links,
      sliding hashed sessions, React Router middleware auth, same-origin checks,
      audit log, People and person pages (role, deactivate, device links, passkeys,
      sessions, history), account page (rename, add/rename/remove passkeys, sign out
      other devices), `bun run admin-link`, service worker registration.
      Verified: typecheck clean; 107 unit tests (real WebAuthn via the software
      authenticator); 11 Playwright e2e tests against the production build in
      Chromium; phone and desktop screenshots reviewed and fixed. E2E runs in CI and
      gates deploys.
- [x] 2026-09-16 — **Phase 2 complete.** Tracking domain (`src/entries.ts`,
      `jobs.ts`, `notes.ts`, `rollup.ts`, `settings.ts`), the op protocol
      (`src/ops-schema.ts` zod schemas shared with the browser, `src/ops.ts` ledger
      applier, `POST /api/ops`), and the tracking screen (`app/tracker/`): timer
      with pause/resume, one-tap switching from recent jobs, required notes asked
      for inline (and on switch), discard/delete with undo, manual entries by
      times (overnight-aware) or duration, entry editing, quick notes and the
      rollup review, day navigation with a week strip, job creation on the spot,
      admin Jobs page (open/closed, needs-a-note, global note rule, backend
      status), per-device location opt-in. Job ids became client UUIDs; the ledger
      keeps every op's payload. Every page title is now "Page · App".
      Verified: typecheck clean, 147 unit tests, 22 Playwright e2e tests (11 auth
      + 11 tracking), phone and desktop screenshots reviewed.
- [x] 2026-09-16 — **Phase 3 complete.** Offline-first tracking:
      `app/offline/` — IndexedDB outbox and day snapshots (`storage.ts`), the sync
      engine (`sync.ts`: ordered batches, backoff retries, Web Locks across tabs,
      BroadcastChannel results, per-person queues, rejection reporting), a pure
      reducer mirroring the server (`reducer.ts`) so changes show instantly,
      client loaders with device fallbacks (`loaders.ts`), header sync status and
      a guarded sign-out. Service worker precaches every build asset (stamped per
      build by `scripts/finalize-build.ts`), keeps the tracking pages, marks kept
      copies, treats 502–504 as down. `routeDiscovery: "initial"`.
      Verified: 176 unit tests (incl. 15 reducer-vs-server mirror tests and 14
      sync-engine tests with discriminating race tests), 30 Playwright e2e (8 new
      offline: track offline, relaunch offline, unseen day, resync, app down with
      network up, late rejection, sign-out with unsynced changes and recovery on
      sign-in), Linux build and serve.
- [x] 2026-09-16 — **Phase 4 complete.** Categories (`src/categories.ts`),
      dated rates with most-specific resolution (`src/rates.ts`), approval with
      rate freezing and locking (`src/approvals.ts`, `src/entry-status.ts`),
      report lines / summaries / timesheet grid / week calendar / CSV
      (`src/reports.ts`), configurable week start, admin acting-for ops with the
      actor recorded in `applied_ops` and the audit log, and five admin pages
      (timesheets, calendar, reports + CSV, rates & categories, someone's day),
      plus a category picker and time links on the person page and an "Admin"
      section in the navigation.
      Verified: typecheck clean; 208 unit tests (21 new server tests, 2 new
      reducer mirror tests for locking and week start, 4 calendar-layout tests, 5
      report-query tests); 42 Playwright e2e (11 new in `timesheets.spec.ts`:
      permissions, rates, categories, grid + filter + approval, locked entries,
      calendar blocks, acting-for stop/delete/undo, reports + frozen cost + CSV,
      reopen, week start, phone screenshots); production build; phone and
      desktop screenshots reviewed and three phone layouts fixed.
- [x] 2026-09-16 — **Phases 5–6 complete (app side).** Two transports: the QB
      Bridge (`qb-bridge.ts`) and the Web Connector (`webconnector.ts`, `/qbwc` + `/qbwc/support` + the
      `.qwc` download). Sync work derived from the tables (`src/sync.ts`): pulls,
      job creation, adds, amends after reopening, deletes, finding a record after
      a lost answer via the `[ref …]` note suffix, backoff, the admin overview.
      Pulled lists and links (`src/remote-lists.ts`): people, merged-in
      provisional jobs (old ids forward), service and payroll items with
      job / category / person / default precedence. Accounting admin page; jobs
      page marks QuickBooks jobs; send loop (`ACCOUNTING_SYNC_EVERY_SECONDS`, 0 =
      manual); deploy.sh passes and checks the new settings.
      Verified: typecheck clean; 246 unit tests (10 qbXML, 20 sync end to end
      through the real bridge client and a pretend QuickBooks, 7 Web Connector
      sessions); 54 Playwright e2e over three app instances (12 new: bridge
      linking/sending/down/refused/create/reopen, Web Connector over HTTP, the
      .qwc download, the endpoint closed when unused, Accounting screenshots;
      the two screenshot tests run only with E2E_SCREENSHOTS set); Linux
      install/typecheck/test/build/serve; Accounting page reviewed on desktop
      and phone.
- [x] 2026-09-16 — **Bridge client on the bridge's REST routes; bridge extended.**
      The QB Bridge gained TimeTracking, OtherName and PayrollItemWage (16 new
      bridge tests, 117 passing) and was published; `qb-bridge.ts` now uses its
      entity routes, and the pretend bridge imitates them over the same pretend
      QuickBooks. `docs/qb-bridge.md` lists the endpoints and the key.
- [x] 2026-09-16 — **Branding is an admin setting.** Settings page (name, short
      name, colour with preview; the week start moved here); header, title, passkey
      prompts, manifest and the Web Connector file follow it; buttons use the chosen
      colour's own shade. Verified: 250 unit tests, 55 Playwright e2e.
- [x] 2026-09-16 — **Published.** History cleaned of deployment-specific notes; this
      plan made generic.
- [ ] Phase 7 — first deployment (deployer's notes). ⬅️

## Open questions for the user

None block the code. Questions about a particular deployment — which people are
Employees in QuickBooks, whether payroll runs from this time, which phones, whether
to import history — belong to that deployment's notes.

## Things not to do

- **Don't commit anything deployment-specific.** No organisation's name, jobs,
  people, customers (test fixtures too), hostnames or addresses — in code, tests,
  plans or commit messages. They come from the environment and admin settings; the
  repo's defaults stay generic.
- **Don't give the bridge a hostname.** IPv4 address only — see gotchas.
- **Don't let a QuickBooks outage block time tracking.** The bridge is *usually* down
  (it only answers while its process runs). Sync is always a background retrying queue.
- **Don't hard-delete time entries.** Soft delete only; undo and audit depend on it.
- **Don't add `title=` attributes for tooltips.** They are invisible on touch, and
  this is a phone-first app. Put the information inline or use a tap-to-expand.
- **Don't deploy by hand.** Everything ships through CI.
- **Don't pass the whole `secrets` context to a step** (`toJSON(secrets)`). Name
  each secret; GitHub blocks the workflow otherwise (see gotchas).
- **Don't register a self-hosted runner before fork pull requests need approval.**
  The repo is public; a fork's pull request can bring a workflow that targets the
  runner's labels (README, Deployment).
- **Don't treat a transient GitHub API error as a missing runner** (see gotchas).
- **Don't import from `src/` into a page component unless the module is
  dependency-free.** Server modules in the browser break hydration without an
  error you'd see; the `.server.ts` suffix on `db`/`config` makes the build catch
  it — don't remove it.
- **Don't let the reducer drift from the server.** Any change to
  `src/entries.ts` / `src/notes.ts` semantics needs the matching change in
  `app/offline/reducer.ts`, and a scenario in `reducer.test.ts`.
- **Don't send queued ops without checking whose they are**, and don't trust a
  storage read that started under a different signed-in person.
- **Don't add an entry mutation that skips the lock.** Anything that changes a
  time entry must refuse non-editable states (`isEditable` in
  `src/entry-status.ts`) — admins included — and the reducer must mirror it.
- **Don't route acting-for changes through the outbox.** Its queue belongs to
  whoever is signed in and is replayed as them.
- **Don't import a constant from a server module into a page** even when the
  module "looks" pure — move it to a dependency-free module (see Phase 4 traps).
- **Don't send time without its `[ref …]` suffix**, and don't add a record
  after an uncertain send without looking for it first (`sync_uncertain`).
- **Don't let a bridge or connection failure count against the time being
  sent.** Only QuickBooks' own answer about a record may mark it refused.
- **Don't give the bridge key more than `docs/qb-bridge.md` lists** — read all,
  write time, add customers. It's what limits a leaked key.
- **Don't give a row its own fetcher if the change can remove the row.** Use the
  parent's (see Phase 5–6 findings).
- **Don't edit migration `001_initial` after the first deploy.** It was edited in
  place during Phase 1 only because no database existed anywhere yet.
