# Tapping a job starts it, and a start can be edited

## Goal

Feedback from use (2026-10-05), on writing up a past day in notes mode:

1. The "Started at — When you got onto the job you pick below" field above the
   job picker is confusing. **Tapping a job should start the job**, on a past
   day as on today, with no separate field to fill in first.
2. **"I should also be able to edit my notes."** A job's "Started" line could
   only be removed: its time couldn't be changed except by removing it and
   adding the job again (decision 6 of `plans/notes-by-job.md`, decision 4 of
   `plans/past-day-notes.md`). With the time no longer asked up front, the
   start has to be editable afterwards.

## Environment / context

- Repo `~/git/Personal Projects/time-tracker` (shared working tree), `master`.
  Checks: `bun run typecheck`, `bun test src/ app/`, `bun run test:e2e`
  (through the compute-budget broker).
- Code: `app/tracker/NotesPanel.tsx` — `AddJob`, `NoteRow`.
- Server: `note.update` already takes `at` and `jobId` for a start marker
  (it refuses only `text`), so no server or op change.

## Decisions

1. **Tapping a job adds it at once.** Today, at the moment it's tapped (as
   before). On a past day, at the day's latest note — the exact instant, so
   it sorts after that note (ties break by id, and a new id is later) rather
   than a minute-truncated time landing just before it.
2. **On an empty past day there's no time to go on**, and none is made up
   (`plans/past-day-notes.md` decision 3). Tapping the job shows its card at
   once with "Started at" open and focused; the start is saved when a time is
   given. Cancel drops it.
3. **A start line opens for editing like a note**: tap the row, change its
   time or its job, or remove it. It still has no words of its own.
   Supersedes the "remove and add again" decisions above.

## Progress log

- [x] Plan written.
- [x] `AddJob` without the field; the empty-day card (`WhenStarted`); the
      start opens in the note editor (time and job, "Remove"), and the row's
      separate Remove button is gone.
- [x] e2e updated: the past-day write-up now starts its first job from the
      empty-day card, taps a second job (starting at the day's latest note),
      re-times that start, sees the first job's hours follow it, and removes
      the start from its editor.
- [x] README; `bun run typecheck`, 475 unit, 82 e2e (3 skipped) green.
- [x] Committed. Deploy waits for the user.
- [x] 2026-10-05 — Rebased onto the settled-notes and bug-report work (one
      conflict: the rolled-note badge keeps "kept in accounting" / "left
      out"; one e2e line: the submitted-day test now taps its job instead of
      filling "Started at"). Typecheck, 503 unit, 86 e2e. **Deployed
      `a22d015`** (user: "finish this and deploy it"); image label checked
      against the commit; healthy.

## Open questions for the user

None. (Asked whether "edit my notes" meant notes already turned into hours;
answered 2026-10-05: it meant start times, which decision 3 covers. Rolled
notes stay read-only.)


## Things not to do

- Don't stamp a past day's start with `Date.now()` — it lands on today.
- Don't invent a start time for an empty past day.
