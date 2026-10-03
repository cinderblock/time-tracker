# Moving between days, undo everywhere, side-by-side conflicts, and clean notes

## Goal

Six things from one round of use (2026-10-02):

1. **Stepping between days: the selected day's highlight should slide** along
   the week strip to the new date, rather than the strip cross-fading.
2. **Stepping between weeks: the whole week should slide out and the new one
   slide in**, quickly — a carousel, not the 32px vertical nudge it is now.
3. **Undo, generally.** Today only deletes and discards offer an Undo (a toast).
   Every change on the day screen should be undoable: edits, stops, switches,
   submits, notes, rollups.
4. **The "already in QuickBooks" choice is a flat list of four buttons.** It
   should be the two records side by side with the choices under each, and
   hovering/focusing a choice should show which half is kept and which is let
   go — then animate the keeping and the leaving halves when chosen.
5. **`[ref …]` is showing up on invoices.** QuickBooks copies a time record's
   note onto the invoice line, so the reference this app appended to every
   note sent is on customers' invoices. Not acceptable: it has to go, from
   new sends and from the records already there.
6. **"Some menu items don't work / do anything."** Found by driving the app on
   a phone-sized viewport: tapping the drawer item for the page already shown
   leaves the drawer open and nothing happens. Every other item navigates.

## Environment / context

- Repo `~/git/Personal Projects/time-tracker` (shared working tree), `master`.
  Checks: `bun run typecheck`, `bun test src/ app/`, `bun run test:e2e`.
- The day screen: `app/tracker/` — `DayHeader.tsx` (strip, arrows),
  `day-move.css` / `day-move.ts` (View Transitions), `HeldEntries.tsx`,
  `context.tsx` (`dispatch`, `useUndoToast`), `EntryList.tsx`, `TimerCard.tsx`.
- Changes are ops (`src/ops-schema.ts`), applied through the idempotency ledger
  (`src/ops.ts`) and mirrored in the browser by `app/offline/reducer.ts`.
- Sending time: `src/sync.ts`. `entryRef()` builds the suffix; `recordFor()`
  appends it; `applyCheck()` and `entry.find` match on it.
- Motion scale in `app/motion.ts` (`--motion-*`, `--ease-*`); reduced motion
  respected app-wide (`plans/motion.md`).
- A local production copy for probing: `bun run build && PORT=3177 … bun run start`
  with a throwaway `DATABASE_PATH` (the dev server's first-run dependency
  optimisation produced two React copies and a blank page; the built app is
  what the e2e tests use anyway).

## Decisions already made (don't re-ask)

1. **The reference leaves the note entirely** (reverses `plans/time-tracker.md`
   decision 8, 2026-09-16). An invoice line is the customer's to read. What the
   reference did — find a record whose send had an unknown outcome — is done by
   matching on what was sent instead: same job, same minutes, same note, and
   not already standing for an entry here. That is exact enough for the rare
   case it covers, and the worst outcome of a wrong match is adopting an
   identical record and amending it to the same values.
2. **Records already carrying a reference are cleaned by the sync itself.**
   A migration marks every entry that has a record there as needing an
   amendment; the next passes send `TimeTrackingMod`s with the clean note.
   Nothing is read back from QuickBooks to decide — this app owns the time.
   Invoices already created keep whatever was copied onto them; QuickBooks
   does not re-read the time record.
3. **"Ours" is decided by the tables, not the note.** A record found there is
   this app's if an entry here holds its id. The note-based `sentFromHere`
   goes.
4. **Undo is an inverse op, computed in the browser from the model as it was
   before the change.** No server-side history: the server's rules already
   make every change an op, so the undo of a change is the op that puts things
   back, dispatched like any other. Offline works for free.
5. **A new op, `timer.reopen`,** is the inverse of `timer.stop` (and of the
   stop a `timer.start` implies): it reopens the entry's last segment so the
   timer runs as if never stopped, including the moments since. Refused when
   another timer is open or the entry isn't a stopped timer in draft.
6. **One undo stack per tracking screen**, in memory, with redo. Ctrl/Cmd+Z and
   Ctrl/Cmd+Shift+Z, plus an Undo control in the day header that says what it
   will undo. The delete toasts stay (they are the discoverable face of it)
   and push onto the same stack.
7. **Not undoable**: `duplicate.resolve` (an answer about the books; the admin
   page has "check again"), `job.create` (nothing is lost by a spare job).
8. **Days: the highlight slides; weeks: the strip slides sideways full-width.**
   Both in `--motion-base`. The body and title keep their sideways slide for
   both kinds of move; the vertical variant goes.
9. **The conflict card: two columns, each with its "keep this" under it**, the
   two other choices (different work; check again) below. Hover/focus previews
   which half is kept (`data-keep`), and choosing plays the leave/keep
   animation *before* the op is dispatched, since the model drops the card the
   instant the op is queued.
10. **The drawer closes on any item tap**, not only when the path changes.

## Plan / steps

1. [x] Plan written; probe of the menu done.
2. [x] Menu: close the drawer on tap (`app/routes/_app.tsx`).
3. [x] `[ref …]`: `recordFor` sends the bare note; `entry.find` by day matches
       on job + minutes + note among unclaimed records, skipping any the
       person said were different work; `applyCheck` holds every unclaimed
       record on the job (no silent adoption); migration `008_clean_notes`
       adds `remote_stale_at` and marks sent entries for amendment; tests
       (sync, web connector, e2e accounting) updated; both plans' decisions
       reversed; README.
4. [x] Day/week motion: the highlight is its own layer (`data-day-part=
       "selected"`), named only on day moves; week moves slide the strip its
       full width, clipped to its own box; `moveBetween` decides which kind a
       move is (a step off the end of the strip is a week move); e2e probe
       updated, unit tests for `moveBetween`.
5. [x] Conflict card: two columns with "Keep mine" / "Keep QuickBooks'" under
       each, `data-keep` preview on hover/focus, `data-chosen` plays the
       leave/keep animation for `--motion-slow` before the op is dispatched;
       e2e updated.
6. [x] Undo: `timer.reopen` op (server, reducer with `closedInRun`, badge
       words); `undo.ts` (inverse per op, and per batch); stack of 20 in
       `TrackerProvider`, Ctrl/Cmd+Z, `UndoLine` under the header; the delete
       toasts undo the change they announce through the same stack;
       `undo.test.ts` round-trips every inverse through the real server;
       e2e for stop → undo → undo.
7. [x] typecheck, 373 unit, 73 e2e green (three e2e locators had to become
       exact or anchored now that an "Undo …" button is always near);
       mid-transition frames and the held-entry screenshots at 1100 and 390
       reviewed; README.

## Findings / gotchas

- **Dev server, first run:** Vite's dependency optimiser handed out two React
  copies (`react.js?v=97b9…` and `react-dom_client.js?v=b244…`), so every hook
  threw and the shell never hydrated. Probing uses the production build.
- **The drawer bug, proved:** on a 390px viewport, drawer open on `/`, tap
  "Track time": URL unchanged, drawer still open. Any other item: navigates
  and the drawer closes. `useEffect(close, [location.pathname])` only fires
  when the path changes.
- **Identical records defeat content matching unless the answer is kept.**
  The first content-matching test found it: the other tracker's "Framing, 1h"
  and this app's lost send of "Framing, 1h" are indistinguishable, and the
  find adopted the foreign one. The person had already said "different work"
  about it, so the `separate` state now keeps `found` and the find skips
  those ids.
- **A reopened timer is a new segment, not the old one reopened.** The
  server could reopen the last segment, but the device's copy holds no
  segments — only the closed time and the last end — so it couldn't mirror
  that. A new segment from the last end gives the same recorded time, and
  the reducer can produce it from what it has. The undo tests compare what
  the person sees (live seconds at a fixed instant, running or not) rather
  than the segment layout for that reason.
- **The reducer's reopen needs to know the stop was its own.** Re-applying
  queued ops on a server copy that already shows the stop would reopen it a
  second time; `closedInRun` records the timers this run stopped or paused,
  and a reopen only applies to one of those — the same compromise
  `entry.restore` already makes with `deletedEntries`.
- **A zero-length pause is what makes undo exact**, and it tripped
  `updateEntry`: the "end must be after the last resume" check ran even for
  a note-only edit. The time checks now apply only when a time is given.
- **The highlight's layer order.** In the view transition the highlight,
  captured after the strip, was painted over it and hid the number it slid
  to (seen in a mid-transition frame). `z-index: -1` on its group and `-2`
  on root's puts the page under it and the strip's text over it.
- **A probe that slows `--motion-base` also has to slow `markDayMove`'s
  timer**, or the attribute the animations hang off is deleted mid-flight
  and the frames lie (the first week frame showed the new week already in
  place). It now reads the stylesheet's duration.
- **The browser's own fade stays on a snapshot unless the keyframes name
  `opacity`.** Setting `animation` on `::view-transition-old(tt-week-strip)`
  didn't replace `-ua-view-transition-fade-out`; both ran, and the two weeks
  crossed as ghosts. With `opacity: 1` in both keyframes and one easing for
  both directions, only the slide runs and it reads as one strip pulled past
  the window.
- **Notes stay linked to a deleted rollup entry.** `rolled_into_entry_id`
  was read straight off the row, so deleting the hours (undoing a rollup)
  left the notes "added to time" forever. The link now counts only while the
  entry is live (a join in `notes.ts`), so restore re-links for free.

## Progress log

- 2026-10-02 — Read the three earlier plans, the sync, the header, the held
  entries and the undo toast. Probed the menu. Plan written.
- 2026-10-02 — All six built and verified. typecheck clean; 373 unit tests
  (23 new: content-matched lost answers, the clean-note amendment,
  `timer.reopen` on both sides, note un-rolling, `moveBetween`, every undo
  inverse round-tripped through the server); 73 e2e across the four app
  instances. Committed. Not deployed: the deploy carries migration 008,
  which amends every record already in QuickBooks — see the private plan.

## Open questions for the user

None yet.

## Things not to do

- Don't put the reference back in any other field QuickBooks shows: there is
  no custom field on a time record (DataExt doesn't cover TimeTracking).
- Don't fix the invoice problem by stripping the tail at invoice time —
  nothing here touches invoices.
- Don't undo by replaying history on the server; the browser's inverse op is
  the whole design (decision 4).
