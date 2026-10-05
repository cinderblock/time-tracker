# Settled notes: kept in accounting, or left out

## Goal

A bug report from use (2026-10-05, marked serious): the day screen said an
earlier, submitted day "isn't finished — it still has 5 notes to turn into
hours", and offered to turn them into hours. Those notes' time was already in
the accounting system, already invoiced and paid. Turning them into hours
again would have made a second copy of billed time.

Fixing that, three follow-ups were asked for (2026-10-05): a submitted day
takes no new notes or hours until it's taken back; submitting a day with
notes not yet hours asks first; and notes can be *left out* — billed some
other way, or not work.

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
duplicate check (the accounting record is still nobody's here) — a second
line of defence, but one asking the same question about time already settled.

## Decisions already made (don't re-ask)

1. **Settled is a state of the note**: `day_notes.settled_as`
   (`kept_in_accounting` | `left_out`) and `settled_at`, not something on the
   deleted entry. The entry's own state can't carry it safely: marking its
   `duplicate_check` resolved would make a restored entry sendable without a
   hold. A settled note is not pending, and can't be edited, re-timed, moved,
   deleted or turned into hours — the same freeze as a note in an entry.
2. **Kept in accounting**: set by the `discard` answer. Restoring the entry
   clears it (its notes are its own again, and a later ordinary delete frees
   them). It can't be "brought back" by itself.
3. **Left out**: the person's choice, per job section ("Leave out"), with an
   undo and a "Bring back". All or nothing per op, on server and reducer
   alike. Allowed on a submitted day — it changes no time.
4. **A submitted day** (every entry signed off) takes no new jobs, notes or
   "Turn into hours" until taken back; the panel says so. Client-side only,
   like the hold: the server already handles a rollup onto a locked line.
5. **Submitting asks** when the day has notes not yet hours ("Submit anyway"
   / "Not yet"); "submit them all" for earlier days asks the same when any of
   them has some (`unsubmittedWithNotes` on the day model).
6. **Existing data is repaired by migration `012_settled_notes`**: notes
   rolled into an entry deleted by a `duplicate_discard` (audit time equal to
   the deletion time) are marked kept in accounting. Migration `012` has not
   run anywhere yet, which is why its first version (a single
   `kept_in_accounting_at` column, commit `4fa8d29`) could be reworked.

## Plan / steps

1. [x] Migration `012_settled_notes` with the backfill.
2. [x] Server: `discard` settles the entry's notes; `restoreEntry` clears
   them; `notes.leave_out` / `notes.bring_back` ops; `pendingNotesBefore`,
   `datesWithPendingNotes`, the note freeze and `DayNote.settled`.
3. [x] Client: `NoteView.settled`, `isPendingNote`; the panel (Leave out,
   Bring back, badges, the submitted-day lock); SubmitDay asks; the day
   header and callouts mention leaving out; reducer, undo, sync badge.
4. [x] Tests: sync (discard settles; restore frees), tracking (leave out /
   bring back, audit, all-or-nothing), migration backfill, reducer mirrors,
   undo, and an e2e walk through submit-asks / submitted lock / leave out.
5. [x] README.
6. [x] typecheck, unit, e2e; commit; deployed (`1cc0210`).

## Findings / gotchas

- The client mirror already behaved "right" by accident on a discard: it
  removed the entry but left the notes pointing at it, so they looked rolled
  up until the server's next copy freed them.
- A reducer field added to the day model needs `?? []` where the state is
  copied: a copy stored on a device before the field existed has none.
- The submitted-day lock covers notes only; "Add time manually" is still
  offered on a submitted day (unchanged; it makes draft time on that day).
- PowerShell's `[IO.File]` calls resolve relative paths against the process
  directory, not the shell's — use absolute paths or the Edit tool.

## Progress log

- [x] 2026-10-05 — Report read, cause traced to discard + the undo rule,
      confirmed read-only against live data. Plan written.
- [x] 2026-10-05 — **Fix built** (`4fa8d29`): typecheck, 478 unit (the two
      behaviour tests fail with the fix removed), 82 e2e. The backfill's
      selection, run read-only against live data, marks exactly the five
      notes from the report and nothing else.
- [x] 2026-10-05 — **Follow-ups built** (the user's yes to all three):
      settled notes generalised, leave out / bring back, submitted-day lock,
      submit asks. Typecheck, 481 unit, 83 e2e passed (3 skipped:
      screenshot-only), screenshots of the locked day and left-out notes
      checked. Not deployed.
- [x] 2026-10-05 — Also fixed: the end-of-day notes reminder now counts
      pending notes by the same rule (`pendingNotesOn`, `1cc0210`).
- [x] 2026-10-05 — **Deployed** at `1cc0210` (user: "deploy"). Snapshot
      first; image digest checked against its revision label in the
      registry. The hosted-runner outage that day cancelled the build and the
      deploy several times before any step ran; re-run until they went
      through. Live: healthy on the pinned digest, `applying migration
      012_settled_notes` in the log, and the reported day's five notes read
      back as `kept_in_accounting` (read-only query).

## Open questions for the user

None.

## Things not to do

- Don't settle the notes by changing the deleted entry's `duplicate_check`:
  a restored entry would then be sent without a hold.
- Don't make every delete settle notes: deleting an entry is how a rollup is
  undone, and those notes must come back.
- Don't let "Bring back" undo a kept-in-accounting note: its time is the
  accounting record's; restoring the entry is the way back.
