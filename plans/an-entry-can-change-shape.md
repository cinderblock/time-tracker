# An entry can change shape

## Goal

Let a stopped timer entry become a plain duration, and a plain duration become
a start-and-end span — from the same "Edit entry" dialog, with the same
Start & end / Just a duration toggle that creating an entry already offers.

The want behind it: "I ran the timer but the times are wrong; I just want to
say 2h." Today that means deleting the entry and re-adding it, which loses the
note, the job and the entry's identity.

## Environment / context

- Repo: `~/git/Personal Projects/time-tracker` (shared working tree — other
  Claude threads commit here; re-read `HEAD` before amending).
- Checks: `bun run typecheck`, `bun test src/ app/`, `bun run test:e2e`.
- The three layers that must agree about an entry's shape:
  - `src/entries.ts` — `updateEntry`, the server's rules.
  - `app/offline/reducer.ts` — the browser's optimistic mirror of those rules.
  - `app/tracker/EntryEditor.tsx` — the dialog.
- An entry's shape is "has `time_segments` rows" vs "doesn't". A duration-only
  entry carries `duration_seconds` and `work_date` directly; a timed one has
  its duration recomputed from its segments (`recomputeDuration`).

## Decisions already made (don't re-ask)

1. **The conversion is explicit, not inferred.** `entry.update` takes a new
   optional `convertTo: "duration" | "times"`. Without it, the existing
   guards stand untouched:
   > This entry has start and end times; change those instead.

   Inferring the conversion from "a `durationSeconds` arrived for a timed
   entry" would mean a stale or buggy client silently destroying an entry's
   segments. That guard exists for a reason; this adds a door rather than
   removing the wall.
2. **A running timer can't be converted.** Stop it first. The dialog says so
   where the toggle would be, matching the existing "stop it to set an end
   time" hint.
3. **Converting to a duration deletes the segments**, pauses and all. That is
   the point of the conversion — the times were wrong. The dialog warns first
   when there were pauses to lose, and the audit row holds the before/after.
4. **`source` is not rewritten.** An entry that came from a timer keeps
   `source: 'timer'` after becoming a duration. It *did* come from a timer;
   the audit trail shouldn't be made to lie for tidiness.
5. **Location fixes survive.** `locations.segment_id` is `ON DELETE CASCADE`,
   so deleting segments would take the start/stop fixes with them. The
   conversion nulls `segment_id` first, keeping the rows on `entry_id`. A fix
   has its own `at`; it's still true after the times are gone.
6. **Converting to times invents nothing.** The start and end fields open
   empty and are required. Guessing a span from the duration would put times
   in the record that nobody witnessed.
7. **The work date follows the start**, as it already does when a timed
   entry's start is edited (`updateEntry`) and when one is created
   (`createManualEntry`).

## Plan / steps

1. [x] Plan written.
2. [x] `convertTo` in `src/ops-schema.ts`, with a refine per direction
   requiring the fields that shape is made of.
3. [x] `updateEntry` in `src/entries.ts`: the two conversions, the
   running-timer refusal, the location detach.
4. [x] Unit tests in `src/tracking.test.ts` — both directions, the refusals,
   a paused timer's segments going, and that the old guards still hold when
   `convertTo` isn't asked for.
5. [x] `app/offline/reducer.ts` mirrors it, checked by `mirror()` in
   `app/offline/reducer.test.ts`, which runs the same ops through the real
   server and the reducer and requires identical day models.
6. [x] `EntryEditor.tsx`: the toggle shows when editing, says what saving will
   replace, and converts on save. Hidden for a running timer.
7. [x] e2e in `e2e/tracking.spec.ts`: a duration takes on times and goes back.
8. [x] README updated; typecheck, 323 unit, 63 e2e green. Committed.

## Findings / gotchas

- `updateEntry`'s existing cross-shape guards are the whole reason this needs
  an explicit opt-in, and they are still there — reached whenever `convertTo`
  is absent. A test holds them (`without asking, the shape still can't be
  changed by accident`).
- **Asking for the shape it already has is an edit, not a conversion.** Both
  the server and the reducer normalise `convertTo` to `undefined` in that
  case. Without it, saving an unchanged timed entry would have inserted a
  *second* segment alongside the first and doubled the entry's duration.
- `recomputeDuration` is a no-op on an entry with no segments — it only
  touches `updated_at` — so the duration written by the conversion survives
  the call at the end of `updateEntry`. Converting the other way it does the
  opposite and useful thing: the new span's length becomes the duration, so
  that isn't written by hand.
- The offline reducer's `entry.update` branched on `e.startedAt != null`.
  The conversion had to be handled *before* that test, not inside either
  branch, since it is precisely the case where the branch is about to be
  wrong.
- `checkSpan` has no future check, so converting to times can book a span
  later today. That matches manual entry, which has always allowed it.
- `listEntriesForDate` sorts by `entryStart` — first segment, else
  `createdAt`. Converting to a duration therefore moves the row to where its
  creation time puts it. Expected, not a bug.

## Progress log

- 2026-09-22 — Plan written after reading the three layers, then built and
  verified in one pass. The one surprise was the same-shape case (see
  findings), caught by writing the "asking for the shape it already has" test
  before trusting the branch. typecheck, 323 unit and 63 e2e green;
  screenshots taken of the toggle, the warning with a pause in it, and the
  empty required time fields on the way back.

## Open questions for the user

1. Decision 3 is the judgement call worth a second look: converting to a
   duration destroys the pause record, and the dialog warns but doesn't ask
   for confirmation. That matches "No “are you sure?”" elsewhere in the app,
   and the audit row holds the before — but it is the one irreversible thing
   in this change.

## Things not to do

- Don't loosen the existing `updateEntry` guards to make the conversion work
  implicitly (decision 1).
- Don't fabricate a start and end from a duration (decision 6).
- Don't rewrite `source` to `manual` on conversion (decision 4).
