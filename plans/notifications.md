# Notifications: reminders and alerts, pushed to each person's devices

## Goal

People find out about problems with their time only by opening the right page.
The trigger (2026-10-02): Chris's entries were held because QuickBooks already
had time for those days, and nothing told him. The user asked for push
notifications, "for end of day if hours weren't entered / notes not
completed", and to **"give lots of options"**.

So: Web Push to every device a person turns it on for, for a set of reminders
and alerts, each one theirs to switch on or off and tune.

## Environment / context

- Built in a **separate worktree**: `~/git/Personal Projects/time-tracker-notifications`,
  branch `notifications`, from `0f0aaf2`. The main checkout
  (`~/git/Personal Projects/time-tracker`) has another session's uncommitted
  work (`plans/move-undo-conflicts-and-clean-notes.md`: migration
  `008_clean_notes`, `src/sync.ts`, the held-entries panel, day-header motion).
  This branch must be rebased onto that once it lands, and its migration
  renumbered after theirs.
- Checks: `bun run typecheck`, `bun test src/ app/`, `bun run test:e2e`.
- Groundwork already in the repo (phase-0 scaffold `1041921`), unused until now:
  `config.push.{vapidPublicKey,vapidPrivateKey,vapidSubject}` from
  `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`
  (`src/config.server.ts`); `.env.example` section; `web-push` in
  `package.json`; `push` and `notificationclick` handlers in `public/sw.js`.
- One time zone for the organisation: `TZ` (`config.timezone`). Work dates are
  `YYYY-MM-DD` in that zone (`src/time.ts`).
- Loops are plain `setInterval` started from `ensureServerInit()`
  (`app/server-init.ts`); domain functions take `now` for tests.
- Deployed on steamboat via ops (`servers/steamboat/stacks/time-tracker/`);
  the VAPID keys will need to reach the container — an ops change, which
  needs the user's per-change yes.

## Decisions already made (don't re-ask)

1. **Web Push, per device.** No email: nothing sends mail and people sign in
   with passkeys, not addresses. (User, 2026-10-02: "Sure" to push.)
2. **Lots of options** (user, 2026-10-02). Every kind of notification can be
   switched off on its own, and the scheduled ones have their own time, days,
   repeat and thresholds. Sensible defaults so turning it on is one tap.
3. **The person's own settings**, kept on the server so every device agrees
   (like tracking mode). Which devices receive them is per device.
4. **Held / failed alerts come from the notification loop polling state**, not
   a hook inside `src/sync.ts`. A hook would need de-duplication anyway
   (`applyCheck` re-holds the same entries on every pass), and polling keeps
   this work out of the file another session is rewriting.
5. **`VAPID_SUBJECT` is the site's URL**, not an email address, so no
   personal address goes to the push services.

## Design

### What can be sent

| Kind | When | Options (defaults) |
| --- | --- | --- |
| **No time entered** (`day_empty`) | At the reminder time on a workday, if the day has less than the minimum | on; minimum hours (any time at all = 0 h) |
| **Notes not turned into hours** (`notes_pending`) | At the reminder time, if today has notes not yet rolled into hours; optionally also the next morning for an earlier day | on; morning check on, at 08:30 |
| **Timer still running** (`timer_running`) | At the reminder time if a timer is running, and/or once it has run longer than N hours | on at reminder time; after 10 h on |
| **Days not submitted** (`unsubmitted`) | Drafts on earlier days: daily at the reminder time, or weekly on a chosen day | weekly, last workday of the week |
| **Time held** (`time_held`) | When QuickBooks turns out to already have time for days you submitted | on |
| **Time refused** (`send_failed`) | When QuickBooks refuses one of your entries | on |
| **Needs an admin** (`admin_attention`, admins only) | Someone's time is held, blocked or refused | on for admins; immediately, or once a day at the reminder time |

Shared options:

- **Workdays**: any set of weekdays (Mon–Fri).
- **Reminder time** (17:00), in the organisation's time zone.
- **Repeat until done**: off / every 30 min / every hour, up to N times (off).
- **Quiet hours** for the immediate alerts: hold them outside a window
  (07:00–20:00) and on non-workdays, and send at the next window start (on).
- **Pause everything until a date** (vacation).
- **Day off**: from a notification's button, or the account page, stops
  today's day reminders.

From the notification itself (platforms that show buttons — not iOS):
"Open the day", "Remind me in an hour", "Day off".

### Delivery

- `push_subscriptions`: one row per browser subscription (endpoint unique),
  owner, keys, a device label from the user agent, created / last sent / last
  failure. 404 or 410 from the push service deletes the row.
- Account page → **Notifications**: turn on for this device (asks the browser
  for permission from the tap), devices that receive them, a test button, and
  all the options above. Explains what to do where push can't work (iPhone
  outside the home-screen app, permission blocked, server has no keys).
- Server never sends when the keys are unset; the section says so.

### Engine

- `src/notifications/prefs.ts` — zod schema with defaults; read/write with
  audit (`entity: "user", action: "notification_prefs"`).
- `src/notifications/rules.ts` — pure: given a person's prefs, state and
  `now`, what is due. All the timing lives here and is unit-tested with a
  fixed clock.
- `src/notifications/log.ts` — `notification_log` table: what was sent to
  whom, for which key (a work date, a set of held entries), how many times —
  de-duplication, repeat counting, day off, snooze, and a "recent" list on the
  account page.
- `src/notifications/send.ts` — `web-push` behind an interface so tests use a
  fake.
- `src/notifications/worker.ts` — every minute; started from
  `ensureServerInit()` only when push is configured.

## Plan / steps

1. Migration: `push_subscriptions`, `notification_log`, `notification_prefs`,
   `notification_days_off`. ✅
2. Prefs schema + read/write. ✅
3. Rules, with unit tests. ✅
4. Subscriptions + sender + worker, with unit tests (fake sender, fixed clock). ✅
5. ⬅️ Routes: subscribe/unsubscribe/test/action endpoints; account page section.
6. Service worker: actions (open / snooze / day off), payload shape.
7. e2e: settings round trip, a subscription posted directly, the test button
   reaching the fake sender.
8. README (configuration, deployment), `.env.example`, app plan.
9. Rebase onto the other session's work once committed; renumber migration.
10. Deploy: VAPID keys into ops (needs the user's yes), pin.

## Findings / gotchas

- **`web-push` works under Bun, end to end** (probe, 2026-10-02): a local
  HTTPS server (openssl self-signed P-256 cert, `NODE_TLS_REJECT_UNAUTHORIZED=0`
  in the sending process) received `201`-answered POSTs with
  `Content-Encoding: aes128gcm`, `TTL`, `Topic`, `Urgency` and a
  `vapid t=…` Authorization header, and `http_ece.decrypt` with the client's
  ECDH key gave back the JSON. So an e2e fake push service can check the real
  encryption path, not just a stubbed sender.
- **Zod 4: `.prefault({})` on an object whose fields use `.catch()`** fails to
  typecheck (the input type still requires every field). Sections use
  `z.preprocess(v => object-or-{}, z.object(...))` instead, which also makes a
  junk stored section read as defaults.
- **A top-level job is a customer** and refuses time ("“Widget” is a customer.
  Pick one of its jobs.") — tests need a customer with a job under it.
- **Fridays fire the weekly "not submitted" reminder by default**, so a test
  of "time entered → no reminder" on a Friday gets that one instead.
- **Headless Chromium keeps `Notification.permission` at `"denied"` even after
  `context.grantPermissions(["notifications"])`**, while
  `navigator.permissions.query({name:"notifications"})` says `"granted"`
  (probe: `[ "denied", "granted" ]`, with and without an origin). The client
  asks the Permissions API first (`notificationPermission()` in
  `app/pwa/push-client.ts`) and falls back to `Notification.permission`.
- **Headless Chromium can't make a real push subscription**, so the e2e spec
  makes up a subscription with real ECDH keys, posts it as the page would, and
  decrypts what the fake push service (`e2e/fake-push-server.ts`, HTTPS with a
  throwaway openssl cert) receives with `http_ece`.
- **`prefs.ts` imports the database**, so the account page's component must
  import from `prefs-schema.ts` (pure) — a value import from `prefs.ts` would
  drag `db.server.ts` toward the client bundle.
- **The other session runs the full e2e suite on the same fixed ports
  (3140–3144) without a compute-budget claim.** Don't start a run while
  theirs is up: "port already used" at best, false timeouts at worst. Wait for
  3140 to be free; `E2E_PORT` moves a run elsewhere when the machine is idle.

## Progress log

- [x] 2026-10-02 — Design written; worktree created.
- [x] Migration `009_notifications` (subscriptions tied to sessions, prefs,
      sent log, days off).
- [x] `src/notifications/`: prefs (zod, audited), rules (pure), state, store,
      send (`web-push` + fake), worker (loop from `ensureServerInit`). 47 unit
      tests pass; typecheck clean.
- [x] Routes + account page UI (`app/notifications/NotificationSettings.tsx`,
      `app/notifications.server.ts`, `api/notifications/action`).
- [x] Service worker buttons (snooze, day off) through the token endpoint.
- [ ] ⬅️ e2e with a fake HTTPS push service: spec written; first test fixed
      (permission quirk); waiting for the other session's e2e run to free the
      ports before re-running.
- [x] README, `.env.example`. App plan (`plans/time-tracker.md`) not touched:
      the other session has it modified; add a pointer after rebasing.
- [ ] Rebase onto the other session's work; deploy.

## Open questions for the user

- (none yet — defaults chosen above; the user can adjust them in the app)

## Things not to do

- Don't edit `src/sync.ts` or the held-entries UI on this branch: another
  session is mid-change there.
- Don't put push keys or endpoints in the audit log.
- Don't use an email address as `VAPID_SUBJECT`.
