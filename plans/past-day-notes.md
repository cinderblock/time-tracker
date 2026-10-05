# Notes for past days, and an unfinished day that still stands out

## Goal

Two asks from use (2026-10-04):

1. **An unfinished day still gets the warning-coloured callout when the hold
   is off.** Turning "Finish a day's notes before starting the next" off made
   the unfinished day a quiet grey line that was easy to miss. The hold should
   stop *blocking*, not stop *warning*.
2. **Notes can be written on a past day**, for someone who writes a day up
   after the fact (asked for by one person). Until now the note boxes and the
   "add a job" picker were today only.

## Environment / context

- Built in a worktree: `~/git/Personal Projects/time-tracker-past-notes`,
  branch `past-day-notes`, from `0f9c1df`.
- Checks: `bun run typecheck`, `bun test src/ app/`, `bun run test:e2e`
  (through the compute-budget broker).
- The panel: `app/tracker/NotesPanel.tsx` (alerts, `AddJob`, `NoteBox`,
  `NoteRow`, `HoursDialog`). The hold on "Next day": `DayHeader.tsx`
  (`heldHere`). Loader: `app/tracker.server.ts` — `notesToRollUp` is already
  computed relative to the day being viewed, not to today.
- Server: `note.create` already takes any `at` up to a day ahead
  (`instant` in `src/ops-schema.ts`); the note's day is `workDateOf(at)`.
  `note.update` already takes `at`. The reducer drops a note whose `at` is
  off the day shown and sorts notes by time — so no server or op change.

## Decisions already made (don't re-ask)

1. **The callout with the hold off is the same warning colour and title**
   ("<day> isn't finished") as the held one, with a "Go to" button — just no
   "Start today anyway", and wording that says today's notes don't wait.
2. **Past days are open to everyone in notes mode**, not behind a setting:
   nothing is lost by offering it, and the hold still applies (with the hold
   on, an earlier unfinished day blocks a later past day exactly as it blocks
   today). Future days stay closed.
3. **A note on a past day asks for its time.** Its time is what the hours are
   worked out from, so it can't be `Date.now()`. The time field is prefilled
   with the latest time already written on that day (the person's own last
   stated time — nothing invented); on an empty day it starts blank and is
   required. Adding a job on a past day asks "Started at" the same way.
4. **A note's time can be edited** (in the note's own editor, any day), since
   a typed time can be mistyped. Not later than now. A start marker still
   can't be reworded or re-timed — remove it and add the job again (as
   decided in `plans/notes-by-job.md`).

## Plan / steps

1. [x] Callout: warning colour with the hold off; held alert's wording works
   for a past day too ("before notes on Thu, Oct 1 start").
2. [x] Past days: `canAdd` for any day up to today; time field on `AddJob`
   and `NoteBox` on a past day; a pure helper for "date + typed time → instant,
   or why not", unit-tested.
3. [x] Note editor: time field for notes.
4. [x] e2e: past-day notes → hours; the reminder callout; a note re-timed.
5. [x] README; typecheck, unit, e2e; commit. Deploy waits for the user.

## Findings / gotchas

- **A note box's suggested time follows its own job's latest note, not the
  day's.** Notes are boundaries in the timeline: a note under job A timed after
  job B's start means being back on A, and reshapes both jobs' hours. Writing a
  day up job by job, the day's latest time would quietly do exactly that. The
  "Started at" field for a new job does follow the day's latest, since a new
  job usually begins where the day left off.
- **No location on a written-up note.** Where the device is now says nothing
  about where an earlier day was, so past-day notes send `location: null`.
- **No server change was needed**: `note.create` already accepts any past
  `at` and files the note under `workDateOf(at)`; `note.update` already
  takes `at`; the reducer already sorts notes by time and drops one that
  leaves the day shown.
- A full-page Playwright screenshot of a scrolled page draws the sticky app
  header partway down the image. It's the capture, not the layout.

## Progress log

- [x] 2026-10-04 — Asks recorded, plan written.
- [x] 2026-10-04 — **Built.** The unfinished-day callout keeps its warning
      colour and title with the hold off; past days take jobs and notes with
      a time; a note's editor sets its time. `bun run typecheck`, 475 unit
      (4 new in `app/tracker/note-time.test.ts`), 82 e2e green (one new test,
      one updated); screenshots of the callout and a written-up day checked.
- [x] 2026-10-04 — **Deployed** at `8d51384` (image `sha256:16a7cfd1…`,
      revision label checked against the commit from the registry). No
      migrations. The container came up healthy on that digest, and the
      deployment's tracker bundle contains the new past-day wording.

## Open questions for the user

None yet.

## Things not to do

- Don't refuse `note.create` server-side for a held day (see
  `plans/notes-by-job.md`).
- Don't stamp a past day's note with `Date.now()` — it lands on today.
