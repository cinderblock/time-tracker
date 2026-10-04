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

**Refinements settled before building (2026-10-03):**

- `rollup.commit` lines carry the seconds to **add** (0 allowed when the line
  exists: "attach these notes to hours already counted"); the dialog shows
  the line's current total and asks for the new one, sending the difference.
  A new total below the current one is refused there ("edit the hours to
  lower them") — a delta can't go below zero.
- The undo of an add is one new op, `entry.unmerge { entryId,
  removeSeconds?, removeSegment?: {startedAt, endedAt}, note, releaseNoteIds? }`:
  take back exactly what was added and put the description back.
- A continued timer's undo is `timer.stop` at the moment it was continued;
  a segment stopped where it started (zero length) is deleted, not kept.
- Starting a timer on the job that's already running is a no-op (alias only);
  on the open-but-paused one, a resume.
- Aliases: table `entry_aliases(alias_id → entry_id)`; the loader sends the
  day's aliases in the model so the reducer resolves queued ops naming an id
  the server already merged.
- Editing an entry onto another job or date where a line exists: refused,
  with the reason. Entries with no job never merge.
- Mixed lines (times + untimed): the editor's duration edits the **total**
  (untimed = total − timed, never below 0); "convert to duration" drops the
  segments as today.
- `entry.combine { intoEntryId, entryIds }` for old duplicates: only when all
  are editable; not undoable (inverse null), so it's a clear, deliberate
  button.

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

4. ✅ Migration `011_one_line_per_job`: `time_entries.untimed_seconds`,
   `entry_aliases`, a line index.
5. ✅ Server (`src/entries.ts`): `lineFor`, `addToLine`, `continueLine`,
   `unmergeEntry`, `combineEntries`; alias resolution in `ownLiveEntry`;
   deleting by an alias refused; zero-length segment dropped on stop;
   moving onto another line refused; `untimedSeconds` edit. `commitRollup`
   joins lines. New ops `entry.unmerge`, `entry.combine`.
6. ✅ Reducer mirror of all of it, with `mirror()` tests; aliases from the
   server's copy (`DayModel.aliases`).
7. ✅ Undo inverses: continued timer → stop at its own start; joined add →
   `entry.unmerge`; combine → none.
8. ✅ UI: hours dialog asks for the day's total (attach with no time; lower
   refused with a reason); rows say "…, plus 30m without times"; duplicate
   lines tagged, with a Combine alert; editor field for the untimed part;
   the admin calendar lists a mixed line's untimed part.
9. ✅ Sync: duration is the line's total, so `recordFor` needed nothing;
   amendments verified against the pretend QuickBooks in e2e.
10. ⬅️ Full e2e on a quiet machine, commit, push; deploy waits for the user.

## Findings / gotchas

- **The hold also locks "Next day"** on the unfinished day (`DayHeader`'s
  `heldHere`), not just today's note boxes; the setting turns both off.
- With the hold off, the loader still sends `notesToRollUp`, so the panel
  shows a quiet reminder linking to the unfinished day.

- **Undo is offered only after the server takes a change** (`submit` in
  `app/tracker/context.tsx` pushes the inverse once the answer is back). The
  keyboard-undo e2e pressed Ctrl+Z as soon as the screen showed the stop, a
  race that existed before and widened slightly with this work (2 of 5 runs
  failed here; 3 of 3 passed on `727ac7b`). Fixed in the test: wait for
  "Undo stopping the timer" first.
- **Signing out right after a page load skipped the "changes not saved"
  warning**: the status hadn't read the device queue yet, so it said 0. Now
  the button counts from storage (`SyncEngine.queuedFor`). Exposed by the
  offline e2e, deterministic once the timing shifted.
- **Linking a made-up job to a real one can leave two lines for one job and
  day** (the accounting e2e does exactly that). Left as is, per decision 2:
  the day flags them and offers Combine; if both were sent, the person takes
  the day back first.
- **Only one real job in the pretend QuickBooks** (Phase 2), so the
  accounting e2e now checks amendments in place (2h → 2h 30m → 2h 45m, a
  refused amendment and its retry, not billable on an amendment), and the
  "keep QuickBooks' record" test makes its own fresh job.
- **e2e under load**: Defender and the search indexer can pin the CPU at
  100% outside the compute broker; the suite then takes 4–8 minutes instead
  of ~2 and animation-timing tests (the day-slide test) fail. Re-run on a
  quiet machine before believing a failure.

- The hold is UI-only today: the server never refuses a note for a held day
  (deliberately — a queued offline note would be dropped; see
  `plans/notes-by-job.md`). So the setting only changes the loader and the
  panel.

## Progress log

- [x] 2026-10-03 — Asks recorded; scope chosen by the user; plan written.
- [x] 2026-10-03 — **Phase 2 built** (one line per job per day). Commit
      `2d5ccc5` (rule, mirror, undo) plus the UI commit. 458 unit tests;
      e2e green apart from load-induced timing failures, being re-run.
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
