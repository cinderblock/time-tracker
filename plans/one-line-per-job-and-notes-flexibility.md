# One line per job per day, and notes that don't hold the next day

## Goal

Four asks from one round of use (2026-10-03):

1. **An unfinished day's notes shouldn't have to hold the next day.** Some
   people are fine finishing old notes later. A per-person setting turns the
   hold off, and is offered right where the hold bites (the "isn't finished"
   alert), not only on the Account page.
2. **Notes can join hours already there.** Turning a job's notes into hours
   when the job already has hours that day made a second line; deleting the
   second line to fix it handed the notes back as unfinished.
3. **One person never has two lines of hours for one job on one day** —
   everywhere, not only in notes mode (user's choice, 2026-10-03). Adding
   time to a job that already has a line that day adds to that line.
   Existing duplicates are **flagged for the person to fix**, not merged
   automatically (user's choice).
4. **"Worked until" goes** from the notes → hours dialog: confusing, and no
   help to the accounting.

## Environment / context

- Built in a worktree: `~/git/Personal Projects/time-tracker-notes`, branch
  `notes-flexibility`, from `64797d3`. The shared checkout may have other
  sessions in it.
- Checks: `bun run typecheck`, `bun test src/ app/`, `bun run test:e2e`
  (through the compute-budget broker; never alongside another session's run
  on the same ports).
- Notes: `src/notes.ts` (`pendingNotesBefore`, `commitRollup`),
  `src/rollup.ts`, `app/tracker/NotesPanel.tsx` (alert, sections,
  `HoursDialog`), loader `app/tracker.server.ts` (`notesToRollUp`).
- Entries: `src/entries.ts` (`startTimer`, `createManualEntry`,
  `updateEntry`, segments in `time_segments`, `recomputeDuration`).
- Every change is an op (`src/ops-schema.ts`, `src/ops.ts`), mirrored in the
  browser by `app/offline/reducer.ts`; undo is the browser computing the
  inverse op from the day before the change (`app/tracker/undo.ts`).

## Decisions already made (don't re-ask)

1. **Scope: everywhere** (user, 2026-10-03). Timers, manual entries and
   notes → hours all add to the person's line for that job and day.
2. **Existing duplicates: flagged for manual fixing** (user, 2026-10-03). The
   day screen marks them and offers a one-tap "combine" the person chooses
   to press; nothing is merged behind anyone's back.
3. **The hold stays the default**; the setting is opt-out, offered in the
   alert and on the Account page. (Mine; it changes nothing for anyone who
   doesn't choose it.)

## Design (phase 2)

**An entry can hold timed and untimed time together.** Today an entry is
either segments (start/stop times) or a typed duration. A line that a timer,
a typed duration and a day's notes all add to needs both, so:
`duration = sum(segments) + untimed_seconds` (new column, migration). Every
existing entry maps exactly: a typed-duration entry has no segments and its
duration untimed; a timed entry has untimed 0.

**Where time lands — "the line" for (person, job, work date):** the live
entry for that person, job and date.

- *Starting a timer* on a job with a line today continues that line: a new
  segment, status open (as resuming after a pause does). Times are kept.
- *A manual entry*: times become a segment on the line (refused if they
  overlap time already on it); a duration adds to its untimed time; the
  notes are joined.
- *Notes → hours*: the dialog shows the line's current hours and asks for the
  **new total**, suggested as current + what the notes add; the notes are
  joined onto the line's description. Leaving the total unchanged is how
  notes are attached to hours already counted.
- *Moving an entry to another job or date* (edit) where that has a line:
  refused with "that job already has hours on that day — add to them
  instead"? or merged — **decide while building; default refuse with a
  clear message**, since a silent merge on edit surprises.
- *The line is signed off*: the person's own submission is taken back first
  (as editing their submitted day already allows) and the day shows it needs
  submitting again; if an admin's approval locks it, refused with who can
  reopen it.

**Offline and ops.** The op still names the new entry id the browser made.
When the server (and the reducer, identically) finds a line already there,
it adds to that line and records an **alias** (new id → line id), so later
ops naming the new id — a stop, an edit — act on the line. A browser that
didn't know of the line (made on another device) gets it from the server on
the next refresh; its queued ops still land through the alias.

**Undo.** Inverses for the merging ops are worked out like the rest, from the
day before the change: a continued timer is stopped at its own start (a
zero-length segment, which the server drops); a manual add or notes → hours
is undone by an op that puts the line's untimed time and description back
and hands the notes back. One new op for that (`line.restore` or similar),
carrying the previous values.

**Flagging existing duplicates.** The day model marks entries that share a
job with another live entry that day; the rows say so, and a "Combine" op
folds them into the earliest (segments moved, untimed added, descriptions
joined, the rest deleted — only when all are editable; otherwise it says to
take the day back first).

## Plan / steps

Phase 1 — small, ships on its own:

1. ✅ Setting "Finish a day's notes before starting the next" (default on):
   migration (users column), `setNotesHoldNextDay`, Account page switch,
   loader skips `notesToRollUp` when off, and a button in the alert
   ("Let me start today anyway") that turns it off. When off, a quiet
   reminder still links to the unfinished day.
2. ✅ Remove "Worked until": the suggestion for a run that reaches the end of
   the day ends now (today) or at the last note (an earlier day); the person
   edits the time worked.
3. ✅ Tests (unit + e2e), README, commit. Deploy waits for the user.

Phase 2 — one line per job per day:

4. ⬅️ Migration: `time_entries.untimed_seconds`, `entry_aliases`.
5. Server: line lookup; `startTimer`, `createManualEntry`, `commitRollup`
   add to the line; alias resolution in `ownLiveEntry`; zero-length segment
   drop; edit-into-another-line rule.
6. Reducer mirror of all of it; `mirror()` tests.
7. Undo inverses for the merging ops; the restoring op.
8. UI: hours dialog asks for the new total; day rows flag duplicates;
   Combine.
9. Sync: an entry with untimed time sends its total (check `recordFor`).
10. Tests, README, plan, commit, deploy (user's yes).

## Findings / gotchas

- **The hold also locks "Next day"** on the unfinished day (`DayHeader`'s
  `heldHere`), not just today's note boxes; the setting turns both off.
- With the hold off, the loader still sends `notesToRollUp`, so the panel
  shows a quiet reminder linking to the unfinished day.

- The hold is UI-only today: the server never refuses a note for a held day
  (deliberately — a queued offline note would be dropped; see
  `plans/notes-by-job.md`). So the setting only changes the loader and the
  panel.

## Progress log

- [x] 2026-10-03 — Asks recorded; scope chosen by the user; plan written.
- [x] 2026-10-03 — **Phase 1 built.** Migration `010_notes_hold`
      (`users.notes_hold_next_day`, default 1); `setNotesHoldNextDay`
      (audited); `DayModel.notesHold`; the alert's "Start today anyway"
      (hidden when an admin acts for someone — the setting is the person's);
      a reminder in its place when off; the Account page switch under "How
      you track time"; "Worked until" gone (today's last run ends now, an
      earlier day's at its last note). Typecheck, 425 unit, 78 e2e green;
      screenshots of the alert and the reminder checked.

## Open questions for the user

None yet.

## Things not to do

- Don't merge existing duplicates automatically (decision 2).
- Don't refuse `note.create` server-side for a held day.
- Don't name any deployment, person or host in this repo's plans (it's
  public); "deployed" notes say what shipped and how it was checked.
