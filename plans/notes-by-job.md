# Notes mode, by job

## Goal

Present notes mode the way a day actually goes: you start on a job, jot what
you do under it, maybe start a second job later, and at the end of the day
turn each job's notes into billable hours. Replaces the flat "jot a note, pick
a job, roll the whole day up" layout from `plans/jobs-under-customers.md`.

## Environment / context

- Same repo and checks as `plans/jobs-under-customers.md`.
- Builds on: `day_notes` (a note has a time, text and job), `proposeRollup`
  (each note runs until the next; same-job neighbours merge), `rollup.commit`
  (entries from notes, notes frozen), and the notes-mode rule that a day's
  notes must be time before the next day starts.
- One schema change: migration `003_note_kind` adds `day_notes.kind`
  (`'note'` default, or `'start'`).

## Decisions already made (don't re-ask)

1. **Adding a job to the day is a note of kind `start`** at that moment, with
   no words of its own. It is what makes the job's section exist, and it is the
   start of the job's time — the person may work an hour before the first
   written note. Being a note, it is a boundary in the timeline like any other
   (it ends the previous job's run), and it is frozen with the rest when hours
   are made.
2. **Notes are grouped by job, sections in the order the jobs were started.**
   Each section has its own note box (today only). Picking a job that already
   has a section just focuses its box: a note written there means "on this job
   now", which is how a return to an earlier job is expressed.
3. **Hours are made per job: one duration entry per job per day**, with the
   job's pending notes joined as the description. QuickBooks time is a date
   and a duration anyway. The suggested duration comes from the timeline over
   *all* the day's notes (rolled ones included, since they still bound the
   others) — the sum of this job's pending runs — and the person confirms or
   changes it. Only when the day's last note is this job's is a "worked until"
   time asked for.
4. **`rollup.commit` lines may be a duration** (`durationSeconds`) as well as
   a span; the server accepts either per line. Spans stay for the engine and
   for manual entries.
5. **Notes with no job** (old ones, or made through the API) sit in a "No job
   yet" section, editable to give them a job, and can't become hours until
   they have one.
6. **A start marker can be removed but not reworded**; its time is edited by
   removing it and adding the job again.

## Plan / steps

1. [x] Plan written.
2. [x] Migration `003_note_kind`; `NoteKind` in `src/ops-schema.ts`;
   `note.create` takes `kind`, empty text only for a start, a start needs a
   job; `rollup.commit` lines take a span or a duration.
3. [x] `src/rollup.ts`: joins non-empty texts; `rollupProblems` checks
   duration lines. `src/notes.ts`: kind stored, listed, refused for reword;
   `commitRollup` handles duration lines.
4. [x] Model `NoteView.kind`; loader; reducer (start notes, duration lines).
5. [x] `NotesPanel.tsx` rewritten: add-a-job picker, sections by job with note
   boxes, per-job hours dialog; wording in `DayHeader`, the Account page and
   the README.
6. [x] Tests: rollup and tracking unit tests, reducer mirror, e2e notes-mode
   tests rewritten.
7. [x] typecheck, unit (273), e2e (58) green; committed. Deploy (push, CI, pin in ops) waits for the word.

## Findings / gotchas

- The hours dialog computes over *all* the day's notes (rolled ones included) because they still bound this job's runs; only the pending part of a mixed line counts, from its first pending note.
- Playwright: section cards are `role="group"` named by the job's full path ("No job yet" for jobless notes); the hours dialog is `Hours for <full path>`; the commit button reads `Add <duration> to <job name>`.

## Progress log

- 2026-09-19 — Designed and built in one pass: start markers, sections by job, per-job hours dialog, duration lines in rollup.commit, migration 003. Typecheck clean; 273 unit; 58 e2e (first run green). Committed; not yet pushed or deployed.

## Open questions for the user

None.

## Things not to do

- Don't make a second "global" roll-up next to the per-job one; one procedure.
- Don't refuse `note.create` server-side for a held day (see the earlier
  plan): a queued offline note would be dropped.
