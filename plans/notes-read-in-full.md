# A long note can be read in full

## Goal

Reported 2026-10-04: on submitted time, a note longer than two lines ends in
an ellipsis and there is no way to see the rest. A submitted entry is locked,
so it can't be tapped open in the editor (the only place the full note was
shown), and nothing else expands it.

## Environment / context

- Repo `~/git/Personal Projects/time-tracker` (shared working tree), `master`.
  Checks: `bun run typecheck`, `bun test src/ app/`, `bun run test:e2e`.
- Where notes were cut:
  - `app/tracker/EntryList.tsx` — every entry row, `lineClamp={2}`. For an
    editable row the note sat inside the row's edit button; for a locked row
    (submitted, approved, in accounting, held) it was a dead end.
  - `app/tracker/HeldEntries.tsx` — both sides of the "already in QuickBooks"
    comparison, `lineClamp={4}`, no way to expand either.
- Not cut, left alone: the admin Accounting page's duplicates list (notes run
  inline in full), the entry editor and timer card (text inputs).

## Decisions

1. **Expand in place, everywhere, with a "Show all" / "Show less" control**
   (`app/components/clamped-text.tsx`). It appears only when something was
   actually cut — measured (`scrollHeight > clientHeight`), and re-measured
   on resize, because whether two lines are enough depends on the width. The
   cut keeps its ellipsis so the reader can see there is more.
2. **Not Mantine's `Spoiler`.** It cuts at a pixel height (a line can be
   sliced through) and drops the ellipsis.
3. **Line breaks the person typed are kept** (`white-space: pre-line`); the
   server only trims notes, so a typed newline is in the data.
4. **The note moves out of the row's edit button**, to its own full-width
   line under the row's heading. A button can't hold a button, and the wider
   line fits more of a long note. A tap on the note's words still opens an
   editable entry, as before; the keyboard has the edit button.

## Progress log

- [x] `ClampedText`, used for entry rows (2 lines) and the held comparison
      (4 lines).
- [x] e2e: the submitted-and-locked test seeds a long, two-paragraph note and
      checks it is cut, expands in full with its line break, and collapses
      (`e2e/timesheets.spec.ts`).
- [x] Rebased onto the one-line-per-job-per-day work. A timer now continues
      its job's line, so the only submitted line in the timesheets spec is
      "Framing": the long note moved to it, and the CSV assertion quotes it.
- [x] Checks pass after the rebase: typecheck, 471 unit tests, all 84 e2e
      (screenshots on). Screenshots of the submitted row, cut and whole, and of
      the held comparison, checked by eye (`submitted-note-*.png`,
      `day-held.png`).
- [x] Committed.
- [x] Deployed 2026-10-04: `ea507aa`, image
      `sha256:9b205cee…` (its revision label checked against the commit in
      the registry before pinning), CI run 37239993052 green. No migrations.
      Container healthy; the deployment's `/sw.js` serves build
      `8d2c92a23bb8a717`, and its tracker bundle carries "Show all" / "Show
      less".

## Findings / gotchas

- The first e2e run failed one test unrelated to this change: "a day slides
  its highlight along the strip…" assumed "Previous day" from today stays in
  the same week. On the first day of the week (Sunday, by default) it
  doesn't, so the week strip slid and the test failed — every Sunday. Fixed in
  the test: it now starts midweek, a week back, before stepping a day.

## Things not to do

- Don't put a control for the note back inside the row's edit button.
- Don't decide "is it cut?" from the character count — it depends on width.
