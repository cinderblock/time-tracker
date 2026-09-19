# Jobs under customers; timers or notes as modes

## Goal

Make picking a job to track time against match how the job list is really
shaped — jobs belong to customers — and stop the two note boxes showing at
once. Four things the first real use turned up:

1. The picker should group jobs under their customer, and time must never be
   booked to a customer itself.
2. There was no way to add a job *under* a customer from the tracking screen
   (the "New job…" modal only took a name, so everything it made was top-level).
3. The picker listed every job alphabetically; the recently used ones should
   come first.
4. While a timer ran there were two note boxes on screen (the timer's own note
   and the "jot a note" box). Those are two ways of recording time — live
   timers, or sporadic notes turned into hours later — so they should be two
   modes, one at a time, chosen by the person; and in notes mode a day's notes
   have to become real hours before the next day can start.

## Environment / context

- Repo `cinderblock/time-tracker`, branch `master`, Bun; checks are
  `bun run typecheck`, `bun test src/ app/`, `bun run test:e2e` (builds first;
  run it through `~/.claude/bin/cpu-slots.mjs`, 3 slots).
- Jobs already had `parent_id`; QuickBooks customers arrive as top-level rows
  and customer:jobs as their children (`src/remote-lists.ts`). Reports already
  called the top of the tree the *customer* (`src/reports.ts`, CSV column
  "Customer").
- One schema change: migration `002_tracking_mode` adds
  `users.tracking_mode` (`'timer'` default, or `'notes'`).
- Everything here is generic; nothing organisation-specific belongs in this
  file.

## Decisions already made (don't re-ask)

1. **Terminology: "customer"**, not "client" — it is what QuickBooks, the
   reports and the CSV already say. (The request said "clients"; the meaning is
   the same.)
2. **A top-level job is a customer and can't take time**, unconditionally — no
   setting. Anything below the top is a job and can (a job with sub-jobs still
   takes time itself, as in QuickBooks). Applies to every backend, including
   `none`: with in-app jobs the admin makes customers and jobs under them.
3. **Closing a customer closes its jobs** for booking (their own switches stay
   as they are). A job is bookable only if it has a parent and it and every
   ancestor is open, active in the accounting system and not merged away.
4. **"Needs a note" on a customer applies to its jobs** (inherited down the
   tree), so the switch on a customer row means something.
5. **Recents first in the picker** as a "Recent" group at the top of the
   dropdown, then customers alphabetically, each listing its jobs by name. The
   selected value still shows the full "Customer:Job" path in the input.
6. **Anyone can make a new customer provisionally** from the "New job…" modal,
   not only admins — the case is a job at a customer the accounting system
   doesn't have yet; an admin links or creates both later.
7. **Timers and notes are two modes, one active at a time, the person's own
   choice** (the user, 2026-09-19, replacing an earlier "hide the jot box while
   a timer runs"). Stored on the user (`tracking_mode`), set on the Account
   page, so every device agrees. Timer mode: timers offered; notes shown only
   as leftovers from before a switch (still roll-up-able). Notes mode: the jot
   box and the roll-up; no timer offered, though a running one is still shown
   so it can be stopped. Manual entry works in both.
8. **In notes mode, a day's notes must become time before the next day
   starts.** Today shows a yellow card naming the earlier day and linking to
   it instead of the jot box; on that day "Next day" is a real disabled button
   (a "disabled" link would still navigate). Enforced in the UI only: a
   server-side refusal would drop a note queued offline, which loses the
   person's words.
9. **A provisional job (one with a parent) can only be linked to a QuickBooks
   job, not a customer**, since its time would land where time can't be booked.

## Plan / steps

1. [x] Plan written.
2. [x] `src/jobs.ts`: `open`, `bookable`, `customerId` and the effective note
   rule (`noteRequired`) computed with the ancestor chain; `requireBookableJob`
   refuses customers and jobs under a closed customer; `recentJobIds` returns
   bookable jobs only; `listJobs()` lists open rows including customers.
3. [x] `src/entries.ts` `noteRequiredFor` inherits; `src/remote-lists.ts`
   `linkJob` refuses job→customer links; `src/sync.ts` names blocked jobs by
   their full path.
4. [x] Tracker model + pure `app/tracker/job-groups.ts` (grouping, recents,
   relative names) with unit tests; loader and offline reducer follow.
5. [x] `JobPicker.tsx`: grouped, recents-first `JobSelect`; `NewJobModal` with
   an existing/new customer switch; recent-job buttons show job over customer.
6. [x] `TimerCard.tsx`: job name as the heading, customer under it.
7. [x] Modes: `src/tracking-mode.ts`, migration 002, `users.trackingMode` +
   `setTrackingMode`, `notes.pendingNotesBefore`, `DayModel.mode` /
   `notesToRollUp`, `TrackerScreen` (mode-aware column + hint), `NotesPanel`
   (jot box / held-by card), `DayHeader` (disabled forward), Account page
   radio.
8. [x] Admin Jobs page: customers with their jobs nested; new customer at the
   top; "Add a job" inside each customer; closed customers in their own section.
9. [x] Admin Accounting page: link options for a job exclude customers.
10. [x] Tests updated (unit fixtures book time on jobs under a customer; e2e
    set-ups make a customer first) and new tests for every rule above.
11. [x] README and `plans/time-tracker.md` (decisions 12–13) updated.
12. [x] typecheck, unit (270), e2e (58) green; committed.

## Findings / gotchas

- Mantine `Select` throws on duplicate values, so the "Recent" group can't
  reuse a job's id. Recent options carry a `recent:` prefix that `onChange`
  strips; the `value` prop is always the plain id, which resolves to the
  option inside the customer group (so the input shows the full path).
- Mantine's default option filter matches on `label`, and the input shows the
  selected option's `label` — so labels are full "Customer:Job" paths and
  `renderOption` draws the short name inside a customer group. With
  `renderOption` the check mark must be drawn by hand (`CheckIcon`).
- `ComboboxData` is a readonly type: build the grouped data as a plain
  mutable array and pass it in.
- Playwright's `getByRole("option", { name, exact: true })` matches the
  rendered text: the short name under a customer group, the full path under
  "Recent". Tests pick by short name; `addTime("Phase 2")`, not
  `"Acme:Phase 2"`.
- **A Select's dropdown covers whatever sits below it.** The first modal put a
  "New customer…" button under the customer Select, and autofocused the
  Select — its open dropdown intercepted every tap on the button (Playwright:
  "subtree intercepts pointer events", 57 retries; a person would need two
  taps). The existing/new choice is now a `SegmentedControl` *above* the
  field, and the Select isn't autofocused.
- Nested Mantine `Card`s break `locator(".mantine-Card-root", { hasText })`
  (the customer card matches too). Customer cards and job rows on the admin
  page are `role="group"` elements named by their full path; tests use
  `getByRole("group", { name })` (exact for the customer).
- A Mantine `Button component={Link} disabled` still navigates on click; the
  day header renders a real `<button disabled>` when there's no way forward.
- Serial e2e files stop at the first failure and the rest "did not run" — they
  aren't in the passed/failed/skipped counts. Read the `x` lines, not just the
  totals.
- The calendar's untimed-block label and the CSV's Job column carry the full
  path now ("Customer:Job"); the customer column is the root's name.
- The sync overview's "made here" reason named the job's bare name; it now
  names the full path, as the Jobs page does.

## Progress log

- 2026-09-19 — Plan; jobs under customers end to end (rules, picker, modal,
  admin pages, accounting links); notes panel first hidden while a timer ran,
  then — on the user's direction — replaced by the two tracking modes with the
  roll-up-before-next-day rule. Typecheck clean; 270 unit tests pass. First
  full e2e run: 48 passed, 3 failed (the offline sign-out test still jotted a
  note in timer mode; the calendar label carries the customer prefix; the
  New-job modal's dropdown covered its "New customer…" button — a real UX bug,
  fixed by moving the choice above the field). Second run: 55 passed, 2 failed
  (the Account radio was fully controlled from loader data, so a click reverted
  until revalidation — now optimistic; the offline sign-out test started from a
  stale copy showing a timer the server had stopped — it reloads first). Third
  run: **58 passed, 2 skipped (screenshot-only), 0 failed.** Committed.
- Next for a deployment: CI builds the image on push; pin the printed digest.
  Migration 002 applies itself on first start (`ALTER TABLE users`).

## Open questions for the user

None blocking. Worth a look:

1. "Customer" vs "client" in the UI — say the word if "client" is wanted
   everywhere (reports, CSV and QuickBooks all say customer).
2. Should admins be able to set a person's mode (People page), or only the
   person themselves? Today: only the person, on their Account page.

## Things not to do

- Don't add a setting to allow booking to customers; the rule is unconditional
  by decision 2.
- Don't reuse a job id as a Recent option value (duplicate-value error).
- Don't nest `Card`s on the admin Jobs page (breaks the e2e locators).
- Don't put anything tappable directly under an autofocused Select in a modal.
- Don't refuse `note.create` server-side for a held day (decision 8): a queued
  offline note would be dropped.
- Don't edit migration `001_initial` or `002_tracking_mode` once deployed —
  the app refuses to start on an edited applied migration.
