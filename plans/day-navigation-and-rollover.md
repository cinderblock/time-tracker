# Moving between days: rollover, arrows, a steady header, and a slide

## Goal

Four things the day screen gets wrong, all of them about *which day you're
looking at*:

1. **Midnight doesn't reach the screen.** A page left open says "Today" about
   the day it was loaded on, forever. Left open two days, it still calls
   Monday today, and the week strip still rings Monday.
2. **The arrows are confusing.** `‹` / `›` are text glyphs at text size, and a
   day at a time isn't what a pair of arrows next to a week strip suggests.
   Wanted: a week button *and* a day button in each direction, with the
   forward pair disabled when there's nowhere forward to go.
3. **The header changes height between Today and any other day**, so the whole
   page shifts a few pixels as you move — which the slide below would make
   worse.
4. **Nothing moves when the day changes.** Days should slide sideways, weeks
   vertically.

## Environment / context

- Repo `~/git/Personal Projects/time-tracker` (shared working tree), branch
  `master`. Checks: `bun run typecheck`, `bun test src/ app/`,
  `bun run test:e2e`.
- The screen: `app/tracker/DayHeader.tsx` (title, arrows, week strip),
  `app/tracker/TrackerScreen.tsx` (the two columns),
  `app/tracker/context.tsx` (`TrackerProvider`, `model`, `hrefFor`).
- `model.today` comes from the loader and nothing refreshes it:
  `app/routes/_app._index.tsx` (`/` = today) and
  `app/routes/_app.day.$date.tsx` (`/day/<date>`), both with a `clientLoader`
  that falls back to the device's copy (`app/offline/loaders.ts`).
- Motion is defined once in `app/motion.ts` and read from CSS as
  `--motion-*` / `--ease-*`. Reduced motion is respected app-wide
  (`plans/motion.md`).
- Mantine 9, React Router 8.4 (`viewTransition` on `<Link>` and
  `useViewTransitionState` are both available). No icon library, and none is
  wanted — `NotesPanel.tsx` already draws its pencil as inline SVG.
- The week strip covers the week containing `workDate`, starting on whichever
  weekday the organisation set (`src/settings.ts`, `weekStartsOn`). The
  browser can read that back off `model.week[0]`.

## Decisions already made (don't re-ask)

1. **The loader stays the only thing that decides what today is.** Rollover is
   handled by *asking for a fresh copy*, not by patching `today` in the
   browser. On `/` the fresh copy is the new day; on `/day/<date>` it's the
   same day with a corrected `today`, which is all the labels need. One source
   of truth, no split brain, and no flash of the screen disagreeing with
   itself while a revalidation is in flight.
2. **Offline is covered by the same path.** `loadDayWithFallback` already
   answers from the device when the server can't be reached, and its offline
   copy derives `today` from the device clock in the organisation's timezone.
   So a rollover offline corrects itself too.
3. **Woken by a timer aimed at the boundary, plus the tab coming back.** A
   sleeping laptop fires its timers late and a background tab has them
   throttled, so `visibilitychange` and `focus` re-check as well. Capped
   retries, so a device whose clock is a day out doesn't poll the server
   forever.
4. **Four buttons: week, day, day, week.** Icon-only, chevron and
   double-chevron, drawn as inline SVG at 20px — no icon dependency for four
   glyphs.
5. **Forward is disabled, not hidden.** A button that disappears moves
   everything next to it, which is exactly the shifting this plan is trying to
   stop. The existing code already renders a real `disabled` button rather
   than a link for this reason (a "disabled" link still navigates).
6. **"Next week" lands on today when the same weekday hasn't happened yet.**
   From last Friday with today on Wednesday, a week forward is this week —
   so it goes to today rather than refusing. It's disabled only when the week
   shown already contains today. Notes mode's "finish this day first" rule
   blocks both forward buttons, as it already blocks the day one.
7. **The header's subtitle line is one fixed height** for both faces — the
   date on today, the "Back to today" button on any other day — so nothing
   shifts as you move between days.
8. **The slide is the View Transitions API**, driven by React Router's
   `viewTransition` prop, with a direction written to `<html data-day-move>`
   at click time and the animations in one plain stylesheet. Not a library,
   and it degrades to a plain navigation where the API is missing.
9. **The week strip and the day's body are the two things that move.** The
   arrows and the title bar stay put: they're the frame, not the picture.

## Plan / steps

1. [x] Plan written.
2. [x] Measured the height difference between Today and another day.
3. [x] Rollover: `app/tracker/rollover.ts`, called from `TrackerProvider`.
4. [x] `app/components/chevron.tsx`; `DayHeader` rebuilt with four buttons on
   `app/tracker/day-steps.ts`. `WeekNav`'s arrows took the same icon.
5. [x] The steady subtitle line (`DayHeader.module.css`).
6. [x] `app/tracker/day-move.ts` + `day-move.css`, and `viewTransition` on
   every link that changes the day.
7. [x] Tests: `app/tracker/day-steps.test.ts` for the arrow targets and the
   rollover arithmetic; three e2e tests in `e2e/tracking.spec.ts`.
8. [x] typecheck, 338 unit, 67 e2e; screenshots at 1100 and 390 reviewed,
   plus a frame partway through a week slide.

## Findings / gotchas

- **The height difference was 5.7px, and it was the subtitle line.** Measured
  on the real build before touching anything: the band between the day's name
  and the week strip was 32.3px on today and 38px everywhere else, so the
  record beside it — and everything under it — sat at y=223 on today and
  y=229 on any other day. Today's second line is `<Text size="sm">` (a 20px
  line box); every other day's is a `compact-sm` `<Button>Back to today</Button>`
  at 26px. Nothing in the week strip differed: every cell measured 63.89px,
  today's ring included, because it was already drawn as a 1px border with a
  transparent counterpart on the others.
- **`useNow` is already ticking every 30s in the header** for the running
  timer's contribution to the week totals, so rollover could have ridden on
  it. Decided against: a 30s poll is up to 30s late at the one moment
  precision is visible, and the boundary is exactly computable with
  `zonedTimeToInstant(addDays(today, 1), "00:00", tz)`.
- **Don't correct for the server's clock skew.** It is tempting to derive a
  better "now" from `generatedAt - fetchedAt`. The offline path already
  trusts the device clock outright, so a second, cleverer notion of now could
  only disagree with it. The capped retry is what covers a device that's
  genuinely wrong, and `rolloverCheck` waits two seconds past the boundary so
  a browser milliseconds ahead of the server can't ask for "today" and be
  handed yesterday again.
- **Set the direction from the click, not from an effect.** React Router calls
  `document.startViewTransition` as it commits the navigation, and an effect
  runs after that — by which time the old frame has been captured. The link's
  `onClick` runs first, so that is where `data-day-move` goes.
- **Naming a part is what keeps it out of the root snapshot.** Proved by
  reading `document.getAnimations()` frame by frame across a navigation: on a
  day move the browser ran `tt-day-move-in/out` on `tt-day-title` and
  `tt-day-body` and its own `-ua-view-transition-fade-*` on `tt-week-strip`
  and `root`; on a week move the strip took the slide too. That readout is now
  the e2e test, so the arrows can't start flying about unnoticed.
- **Don't screenshot without waiting for the transition to end.** A view
  transition's frames are static images captured at the old size, so a
  screenshot taken mid-flight — or worse, after resizing the viewport
  mid-flight — shows a stretched snapshot of the previous layout and looks
  like a layout bug that isn't there. The probe waits for
  `document.getAnimations()` to drain of `::view-transition` entries first.
- **Mantine's `compact-sm` height isn't readable from outside a button.** It
  is set as `--button-height-compact-sm` on the Button's own class, not on
  `:root`, so the steady subtitle line writes `calc(1.625rem * var(--mantine-scale))`
  out with a comment rather than referencing it.
- The old "Next week" button in `WeekNav` was a `<Button component={Link}>`
  with `disabled`, which renders an `<a>` — it took the same treatment as the
  day header's: a real disabled `<button>` when there is nowhere to go.

## Progress log

- 2026-09-23 — Plan written, measured, then all four changes built and
  verified in one pass. Rollover asks the loader for a fresh copy; the header
  carries week/day/day/week chevrons with both forward buttons disabled at the
  edge; the subtitle line is one height for both faces, so the record sits at
  the same y on every day; days slide sideways and weeks vertically through
  the View Transitions API. `bun run typecheck`, 338 unit tests (15 of them new) and 67 e2e
  green. Not yet deployed — ops pins the digest, and that needs its own
  approval.

## Open questions for the user

1. The slide is 200 ms (`--motion-base`) with a 32px shift. If it reads as
   fussy, `--day-move-shift` in `app/tracker/day-move.css` is the one number
   to turn; if it reads as too subtle, `--motion-slow` is the other.

## Things not to do

- Don't patch `today` in the browser and leave the loader's copy saying
  something else — decision 1. The two disagreeing is what produces a screen
  that flickers between a past day and today at midnight.
- Don't hide the forward buttons when they're unusable (decision 5).
- Don't pull in an icon library for four chevrons.
- Don't slide the whole page: the arrows you just pressed shouldn't fly away.
