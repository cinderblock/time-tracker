# Notes whose time was kept in accounting stay settled

## Goal

A bug report from use (2026-10-05, marked serious): the day screen said an
earlier, submitted day "isn't finished — it still has 5 notes to turn into
hours", and offered to turn them into hours. Those notes' time was already in
the accounting system, already invoiced and paid. Turning them into hours
again would have made a second copy of billed time.

## What happened (the cause, confirmed in live data)

1. The person wrote the day in notes and turned each job's notes into hours:
   three entries, submitted.
2. The other time tracker had already put the same day's time in the
   accounting system. The first send held all three entries as duplicates
   (`plans/duplicates-and-billable.md`).
3. The person answered the holds: "Keep QuickBooks'" for two (the
   `duplicate.resolve` `discard` action, which deletes the entry here) and
   "Keep mine" for the third.
4. A note is part of an entry only while that entry is live
   (`src/notes.ts`, the `COLUMNS` comment). That rule exists so that deleting
   an entry *undoes* a rollup. A discard is not an undo, but it deletes the
   entry too, so the two entries' notes became "not yet hours" again.
5. `pendingNotesBefore` then reported the day as unfinished. The warning had
   been a quiet grey line while the hold was off, until the 2026-10-04 change
   (`plans/past-day-notes.md`) made it the yellow callout, which is what the
   person noticed. The morning "notes still need turning into hours"
   notification reads the same function.

Nothing was double-booked: the notes were never turned into hours a second
time. Had they been, the new entry would have been held again by the
duplicate check (the accounting record is still nobody's here), so the
duplicate check was a second line of defence — but one that asks the person the same question
again, about time they had already settled.

## Decisions already made (don't re-ask)

1. **The settled state lives on the notes**, as `day_notes.kept_in_accounting_at`,
   not on the deleted entry. The entry's own state can't carry it safely:
   marking its `duplicate_check` as resolved would make a restored entry
   sendable without a hold. A note marked this way is not pending, cannot be
   edited, re-timed, moved, deleted or turned into hours — the same freeze as
   a note that is part of an entry.
2. **Restoring the entry clears the mark**: its notes are its own again, and
   a later ordinary delete frees them as before.
3. **Existing data is repaired by the migration**: notes rolled into an entry
   that is deleted and whose audit trail has a `duplicate_discard` are marked,
   with the entry's deletion time.
4. On the day, such a note reads "kept in accounting" where a rolled-up note
   reads "added to time".

## Plan / steps

1. [x] Migration `012_notes_kept_in_accounting` with the backfill.
2. [x] Server: `discard` marks the entry's notes; `restoreEntry` clears them;
   `pendingNotesBefore`, the note freeze, and `DayNote` know the mark.
3. [x] Client: `NoteView.keptInAccounting`; pending checks in the panel and
   the day header; the reducer mirrors discard and restore.
4. [x] Tests: sync (discard settles the notes; restore frees them), migration
   backfill, reducer.
5. [x] typecheck, unit, e2e; commit. Deploy waits for the user.

## Findings / gotchas

- The client mirror already behaved "right" by accident: on a discard it
  removed the entry but left the notes pointing at it, so they looked rolled
  up until the next fresh copy from the server freed them.
- A submitted day with leftover notes still offers "Turn into hours" and
  (since 2026-10-04) new jobs and notes. Not changed here; see open questions.

## Progress log

- [x] 2026-10-05 — Report read, cause traced to discard + the undo rule,
      confirmed read-only against live data. Plan written.
- [x] 2026-10-05 — **Built** on branch `kept-in-accounting-notes`.
      Typecheck clean; 478 unit (3 new: the discard/restore cycle, the
      reducer mirror, the migration backfill), and the two behaviour tests
      fail with the fix removed; 82 e2e passed, 3 skipped. The backfill's
      selection, run read-only against live data, marks exactly the five
      notes from the report and nothing else. Not deployed.

## Open questions for the user

1. Should a submitted day's notes panel ask for the day to be taken back
   before it takes new jobs, notes or "Turn into hours"? Today it allows
   them, making new draft time on a submitted day.
2. Should submitting a day with notes not yet turned into hours warn?
   Today it doesn't, so leftovers are only noticed by the next day's callout.
3. Is a per-job "leave these out" action for notes wanted — time that was
   billed some other way, or wasn't work? Nothing in the app does that today
   but deleting the notes.

## Things not to do

- Don't settle the notes by changing the deleted entry's `duplicate_check`:
  a restored entry would then be sent without a hold.
- Don't make every delete settle notes: deleting an entry is how a rollup is
  undone, and those notes must come back.
