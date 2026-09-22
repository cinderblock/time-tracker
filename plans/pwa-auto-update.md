# The installed app replaces itself

## Goal

A deploy should reach an installed copy of the app without anyone being told to
force-reload. Today it does not: a phone that has the app on its home screen can
keep running a release-old bundle indefinitely, and nothing on screen says so.

The symptom that started this (user, 2026-09-21): after a deploy, the app looked
completely alive — right hours, right jobs, no errors — but the new features
were missing. A force reload fixed it.

## Environment / context

- Repo: `~/git/Personal Projects/time-tracker`, branch `master`.
- Checks: `bun run typecheck`, `bun test src/ app/`, `bun run test:e2e`.
- Deployed to `https://time.twilltech.com` on steamboat by an ops-owned,
  pinned-digest deploy — see the TWILL deployment plan in
  `playgrounds/qb-time/plans/twill-time-tracker-deployment.md`. Nothing here
  touches deployment; this is app code.
- The pieces already in place before this work:
  - `public/sw.js` — the service worker, served unbundled at the site root.
  - `scripts/finalize-build.ts` — stamps a build id and the asset list into
    `sw.js` after every build, so the worker's bytes change per release.
  - `app/root.tsx` — registered `/sw.js` once, in a mount effect.

## Why it was stale — the three gaps

1. **Nothing re-checked for a new worker while the app was open.** The browser
   re-fetches `/sw.js` on a *document* navigation in scope. This app is a single
   page with `routeDiscovery: { mode: "initial" }` (`react-router.config.ts`),
   so moving between days is client-side and there is no such navigation. An
   installed copy resumed from the home screen keeps one document alive for
   days. The only `register()` call ran once, at mount. The new worker was never
   even fetched.

2. **Nothing reloaded the page when a new worker did take over.** `sw.js` calls
   `skipWaiting()` on install and `clients.claim()` on activate, so a newly
   installed worker takes control immediately — but the running document keeps
   executing the JavaScript modules it already loaded. There was no
   `controllerchange` or `updatefound` listener anywhere in the repo.

3. **The staleness was invisible, which is what made it bite.** `/api/` and
   `.data` are deliberately never cached (`public/sw.js`), so loader data comes
   fresh off the new server. The screen looks correct and current; only the code
   behind it is old. It is also a version-skew hazard — old client code reading
   a new server's `.data` shapes.

## Decisions already made (don't re-ask)

1. **Silent, immediate reload** on handover (user, 2026-09-21), chosen over a
   "New version — Reload" prompt and over check-but-never-reload. The app is
   never knowingly stale. The accepted cost: unsaved text in an open dialog is
   lost when a deploy lands mid-edit. Tracked time itself is safe — it is in the
   IndexedDB outbox before any of this can happen.
2. **`skipWaiting()` stays.** With a silent reload there is no reason to hold a
   worker in `waiting` and no moment to hand the user.
3. **The client does the checking**, on the events that matter for an installed
   PWA: resume from background, reconnect, and a slow timer while open. A
   service worker cannot check for its own replacement.
4. **The decision logic is a separate, injectable unit** (`createUpdater`) in
   the shape `app/offline/sync.ts` already uses, so the "should this reload?"
   rules have real unit tests rather than only a browser test.
5. **`sw.js` gets an explicit `Cache-Control: no-cache`** from the server. The
   browser already bypasses its HTTP cache for the top-level worker script
   (`updateViaCache` defaults to `"imports"`), so this changes no browser
   behaviour — it is for proxies in between, which do not know that rule.

## When a handover means "reload"

The rule that took the most thought, because getting it wrong either reloads
every first-time install or leaves force-reloaded pages stale forever. A page
should reload on `controllerchange` exactly when a *newer* worker took over:

| The page at load | A controller change means | Reload? |
| --- | --- | --- |
| Controlled by a worker | A new worker activated and claimed it | yes |
| Uncontrolled, but a worker was already installed (a force reload bypasses the worker) | Only a newly activated worker can claim it | yes |
| Uncontrolled, no worker installed — the first-ever install | The worker this page just installed, built from the same release as the code already running | no |

So: track whether the page is controlled, from `navigator.serviceWorker.controller`
at start *or* `registration.active` after `register()` resolves, and treat the
first handover on a never-controlled page as the install rather than an update.
After that first handover the page *is* controlled, so a later one reloads.

### The handover nobody heard

`controllerchange` is an event, so a page that wasn't listening yet misses it
outright. The gap is real: the listener goes on during hydration, and *another
tab* can trigger the update — the worker activates and claims every client in
scope, this one included, before its own listener exists. There is then no
second event to wait for, and the page sits on old code until it is closed:
precisely the bug this work exists to remove.

The state it leaves behind is visible, though. `registration.active` and
`navigator.serviceWorker.controller` are normally the same worker, because this
one claims as it activates; a page that has a controller *and* sees a different
worker as active has already been passed over. That comparison runs once at
startup and before every update check, and reloads through the same one-shot,
loop-guarded path as the event.

## Plan / steps

1. [x] Plan written.
2. [x] `app/pwa/auto-update.ts` — `createUpdater(deps)` (the rules above, the
   missed-handover check, the check throttle, the reload-loop guard) and
   `startAutoUpdate()` (wires the real browser: register with
   `updateViaCache: "none"`, `controllerchange`, `visibilitychange`,
   `pageshow`, `online`, a 20-minute interval).
3. [x] `app/pwa/auto-update.test.ts` — unit tests for the table above, the
   throttle and the loop guard.
4. [x] `app/root.tsx` calls `startAutoUpdate()` in place of the inline
   `register()`.
5. [x] `server.ts` — `Cache-Control: no-cache` on `sw.js`.
6. [x] README: the offline paragraph says the app replaces itself.
7. [x] `bun run typecheck` clean; `bun test src/ app/` 309 pass / 0 fail (12 of
   them new); `bun run test:e2e` 61 passed, 2 skipped (the pre-existing
   screenshot skips). Committed as `4f743e7`, unpushed at the time of writing.
8. [x] Deployed 2026-09-22 as `f105b31` (image `sha256:1a010bb2…`, ops pin
   `f75b21a`). Container healthy on steamboat; `https://time.twilltech.com/sw.js`
   serves `Cache-Control: no-cache` and build `0d1b0c2842c471b3`.
9. [ ] **Confirm on a real phone at the *next* deploy**: install, deploy a
   change, background the app, reopen, see the new feature without touching
   anything. This cannot be proven by the deploy that introduced it — every
   installed copy was running pre-fix code that has no way to update itself,
   so each device needed one last manual force reload to pick up the updater.
   It is also the only step that proves the thing works: the unit tests cover
   the rules, and the e2e suite never changes build mid-run, so neither has
   ever seen a real second release arrive.

## Findings / gotchas

- **`register()` itself performs an update check** when a registration already
  exists, so there is no need to call `registration.update()` immediately at
  start — the interval and the resume/reconnect handlers cover the rest.
- **A hidden tab's `setInterval` is throttled hard** (and frozen outright in a
  backgrounded PWA on iOS). The timer is therefore the least important of the
  three triggers; `visibilitychange` to `visible` is the one that actually
  catches a resumed home-screen app, and `pageshow` covers a bfcache restore
  where `visibilitychange` may not fire.
- **The checks are throttled to one a minute**, because `visibilitychange`,
  `pageshow` and `online` all fire together when a phone comes back from sleep
  on a different network.
- **The reload-loop guard is a `sessionStorage` timestamp**, not an in-memory
  flag: an in-memory flag cannot survive the reload it is guarding. Two update
  reloads within ten seconds are a broken worker, so the second is refused and
  logged instead.
- **`controllerchange` alone is not enough**, because a page can miss it — see
  "The handover nobody heard" above. That was found while reviewing the first
  version of this, not from a failure, and it is the reason `createUpdater`
  has two ways in to one `applyUpdate`.
- The e2e suite is unaffected: the build does not change mid-run, so the only
  handover a test sees is the first-ever install, which by the table above does
  not reload.

## Things not to do

- **Don't reload on every `controllerchange`.** It reloads every first-time
  install — visibly, right after sign-up — and the e2e offline suite installs
  the worker in its first test.
- **Don't drop `skipWaiting()`** without replacing it with a prompt and a
  `SKIP_WAITING` message; on its own it means a new worker sits in `waiting`
  until every tab is closed, which is *worse* than today for an installed app
  that is never closed.
- **Don't cache `/sw.js` in the worker's own fetch handler.** It is already
  excluded there, and a worker that can serve its own stale bytes can never be
  replaced.
