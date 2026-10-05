# Built-in bug reports and browser error capture

## Goal

When something confuses someone, they press one button, say in a sentence
what they were trying to do, and the app sends everything an agent would need
to find and fix the problem: what was on screen, what they did just before,
what the app knew, what went wrong in the browser. Separately, every error in
a person's browser console reaches the server on its own, grouped, so problems
are seen even when nobody reports them.

The test of done: an agent given one exported report can reproduce or explain
the problem without asking the person anything.

## Environment / context

- Worktree `~/git/Personal Projects/time-tracker-bug-reports`, branch
  `bug-reports`, from `7d36109`.
- Checks: `bun run typecheck`, `bun test src/ app/`, `bun run test:e2e`
  (through the compute-budget broker).
- What exists today (surveyed 2026-10-05): no global error listeners, no
  client-to-server logging, one root ErrorBoundary that reports nothing, no
  screenshot library, no blob storage (SQLite only), IndexedDB `time-tracker`
  v1 with `outbox` + `snapshots`, one BroadcastChannel (`tt-outbox`), build
  id only inside `sw.js` (hash of asset URLs), the git commit only as an
  image label (not visible at runtime).

## Decisions already made (don't re-ask)

From the user (2026-10-05):

1. **Screenshots: both.** The page is drawn into an image automatically when
   the button is pressed (no prompt, works on iPhone); where the browser can,
   the dialog also offers "Capture the real screen" (`getDisplayMedia`).
2. **Destination: in the app.** Admin → Bug reports lists reports and error
   groups; each report downloads as one bundle for an agent; status
   new / fixed / won't fix; admins get a push for new reports. Company data
   never leaves the app (the app repo is public — nothing goes to GitHub).
3. **Automatic errors are grouped**, with a count, who they hit and the latest
   context; admins are pushed only the first time a new kind appears.
4. **Reports include the screen's data**: the day model on screen, pending
   offline changes, sync state. Only admins can read reports.

Mine, following from those:

5. **No `title=` tooltips** (the user's rule): the report button has a
   visible label.
6. **Reports and errors work offline**: queued in IndexedDB (a new store, DB
   version 2) and sent when the connection is back, like the outbox — but on
   their own path, not as ops (ops are the ledgered tracking changes).
7. **Screenshots are stored in SQLite** as BLOBs (WebP where the browser can
   encode it, else PNG), capped in size. One file to back up stays one file.
8. **Typed text is never a breadcrumb.** Breadcrumbs record what was clicked
   (its accessible name), where the person went, what changes were made and
   how the server answered — not what was typed into fields. The day model
   already carries notes and entries.
9. **"Other tabs" means this app's other tabs** — a browser gives a page no
   way to see anything else. Each open tab answers a BroadcastChannel call
   with its URL, build, visibility and recent breadcrumbs.
10. **The agent bundle is a zip**: `report.md` (readable summary + how to use
    the rest), `context.json` (everything collected), the screenshots. Also a
    CLI (`bun run bugs`, `src/cli/bugs.ts`) that lists what's open and writes
    the same bundle to a directory, for an agent with shell access to the host
    (runs inside the container). Read-only: status changes stay on the admin
    page, audited under a person.
11. **Version at runtime**: the page carries the build it was served with
    (build id + git commit) in a meta tag; the server reports its current
    one. A report from a stale tab shows both — itself a clue.
12. **Error reports are accepted signed out too** (sign-in failures matter),
    size-capped, all signed-out senders sharing one rate limit (an address
    header is the sender's to make up); bug reports need a session.
13. **One admin notification kind, `problems`**, with its own switch: a new
    report, or a kind of error seen for the first time (or back after a fix).

## Design

### Client

- `app/bugs/breadcrumbs.ts` — ring buffer (100) of `{at, kind, text, data}`:
  navigation, clicks (role + accessible name), ops dispatched and their
  answers, toasts shown, console errors/warnings, fetch failures, online /
  offline, visibility, update reloads. Kept in sessionStorage so an update
  reload or crash doesn't lose it.
- `app/bugs/errors.ts` — `error`, `unhandledrejection`, and a `console.error`
  wrapper → normalised `{message, stack, source}` → batched, de-duplicated
  per session (with counts) → `POST /api/client-errors`; queued offline.
  Guarded against reporting its own failures.
- `app/bugs/context.ts` — a registry screens add to (`useBugContext("day",
  () => model)`), plus the always-on parts: URL, route, title, builds,
  timestamps and server clock offset, device (UA, viewport, DPR, standalone,
  touch, locale, timezone), online, service worker state, notification
  permission, storage estimate, sync status, queued outbox ops, undo labels,
  recent errors, other tabs.
- `app/bugs/screenshot.ts` — `modern-screenshot` draw of the page, taken
  *before* the dialog opens; `getDisplayMedia` single frame, with the dialog
  hidden while it's taken.
- `app/bugs/ReportBug.tsx` — the header button ("Report a problem", visible
  label; icon-only is not allowed) and the dialog: what were you trying to
  do, what happened instead, screenshot preview (removable), a "what's
  included" list the person can open. Also offered from the root
  ErrorBoundary.

### Server

- Migration `013_bug_reports`: `bug_reports` (+ `bug_report_images`),
  `client_error_groups`, `client_error_events` (capped per group).
- `src/bug-reports.ts`, `src/client-errors.ts` (fingerprint: normalised
  message + top frames' function and file without hash or line).
- Routes: `POST /api/bug-reports`, `POST /api/client-errors`,
  `admin/bugs` (list), `admin/bugs/:id` (detail), image and bundle downloads.
- Notifications: new kinds `bug_report` and `client_error`, admins only,
  with their own switch.

## Plan / steps

1. [x] Version at runtime: `__APP_REVISION__` baked in by Vite, the Docker
   `REVISION` build argument from CI, `build/build-info.json` for the server.
2. [x] Server: migration `013_bug_reports`, `src/bug-reports.ts`,
   `src/client-errors.ts`, `POST /api/bug-reports`, `POST /api/client-errors`,
   size limits (`readJsonLimited`), rate limits; unit tests.
3. [x] Client: breadcrumbs (clicks, navigation, ops, toasts, network,
   connectivity), error capture, the problem queue; unit tests.
4. [x] Context: the `useBugContext` registry (day screen: shown + server
   copy, pending ops, undo labels), device, service worker, storage, sync,
   other tabs (BroadcastChannel roll call), modern-screenshot drawing,
   getDisplayMedia capture.
5. [x] Dialog + header button ("Report a problem") + root ErrorBoundary form.
6. [x] Admin → Bug reports (list, report, error group), zip bundle, image
   route, `bun run bugs`.
7. [x] Notifications: `problems` kind, admin switch, rule tests.
8. [x] e2e (`e2e/bugs.spec.ts`), README; typecheck, 501 unit, 86 e2e.
9. [ ] Commit; deploy waits for the user.

## Findings / gotchas

- **Mantine 9's `Collapse` takes `expanded`**, not `in`.
- **`notifications.show` is read-only**; toasts are recorded by subscribing
  to `notificationsStore` and noting each id the first time it appears.
- **A page answers its own BroadcastChannel roll call**: the listener made
  for the call is a different channel object from the page's answering one,
  and channels deliver to every other object, same page included. Answers
  carrying the asking tab's id are skipped.
- **Reports can't share the outbox's IndexedDB database**: adding a store is
  a version upgrade, which an open tab running older code blocks — taking
  the outbox with it. The queue has its own database (`time-tracker-problems`).
- **`getByText` is a substring match**: "Errors" matched the page's own
  description; and the toast of an earlier test showed up again inside the
  next report's breadcrumbs — the capture working, and a selector trap.
- **e2e under load**: one full run timed out in `accounting.spec.ts` ("a
  refusal is shown, and can be retried"); the project alone passed 10/10 and
  the next full run was all green. Timing, not this change.
- While wiring the `problems` state, the end-of-day notes reminder turned out
  to count notes the old way (left-out notes would still prompt). Fixed on
  `master` (`1cc0210`), shipped with the settled-notes deploy.

## Progress log

- [x] 2026-10-05 — Survey of the codebase; user's four answers; plan written.
- [x] 2026-10-05 — **Built.** Typecheck clean, 501 unit (20 new), 86 e2e
      (3 new) green; screenshots of the dialog and the admin report checked.
      Not deployed.

## Open questions for the user

None yet.

## Things not to do

- Don't send reports anywhere outside the app (public repo; company data).
- Don't record typed field values as breadcrumbs.
- Don't use `title=` tooltips.
- Don't route reports through the ops outbox/ledger.
