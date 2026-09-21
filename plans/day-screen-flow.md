# The day screen's two columns, and the flow between them

## Goal

The tracking screen is two columns: what you're doing (a timer, or the day's
notes) on the left, the hours recorded for the day on the right. Read cold,
the two look like one undifferentiated wall of cards, and nothing says that
the left side *becomes* the right side. Two changes:

1. **Separate the columns** so it's obvious they're two different things.
2. **Show the flow**: turning a job's notes into hours should visibly move
   from the left column to the right, rather than silently appearing there.

## Environment / context

- Repo `cinderblock/time-tracker`, primary branch `master`. Same checks as
  `plans/time-tracker.md`: `bun run typecheck`, `bun test src/ app/`,
  `bunx playwright test`.
- The screen is `app/tracker/TrackerScreen.tsx`: a Mantine `Grid`, two
  `Grid.Col span={{ base: 12, md: 6 }}`. Left holds `TimerPanel` and/or
  `NotesPanel` plus the mode hint; right holds `EntryList`.
- Headings live inside the panels ("Start a timer", "Notes", "Time"), not in
  the screen.
- The commit path: `HoursDialog` in `NotesPanel.tsx` dispatches
  `rollup.commit` with an `entryId` it makes itself, so the destination row's
  id is known before the row exists.
- No animation library. Mantine 9 + the Web Animations API is what's here, and
  that's enough — see the decisions.

## Decisions already made (don't re-ask)

1. **The left column is a tinted surface, the right is the plain page.** The
   left is the workbench (what you're doing now), the right is the record.
   Light and dark both, via `light-dark()` (postcss-preset-mantine is
   configured). No extra vertical rule on top of the tint — one boundary
   marker is enough.
2. **The "Time" heading gains a caption naming where its hours come from**,
   worded per tracking mode. That, not a third block of prose, is what says
   the left becomes the right.
3. **Committed hours fly from the job's notes card to their new row.** The
   ghost is a small pill carrying the duration; it flies to the row, which
   then flashes once. The flight starts *after* the dialog has closed, so it
   isn't hidden under the modal overlay.
4. **Every way work becomes hours flies the same way** (2026-09-21): a job's
   notes rolled up, a timer stopped, and a timer switched away from. The
   timer's row already exists while it runs (an open entry is listed, with a
   "running" badge), so nothing appears there on stop — but the card on the
   left *goes*, and the pill is what says where its time went.
5. **Web Animations API, not a library.** One `element.animate()` call for the
   ghost and a CSS keyframe for the landing flash.
6. **`prefers-reduced-motion` skips the flight**; the row still flashes, since
   a colour fade isn't motion.

## Plan / steps

1. [x] Plan written.
2. [x] Column separation: a tinted, rounded, padded surface for the left
   column; the "Time" caption; spacing checked on a phone and wide.
3. [x] `app/tracker/flight.tsx`: context (`flyToEntry`, `landed`) and the
   layer that measures, scrolls if needed, animates and flashes.
4. [x] Wire it: `JobSection` passes its card's rect to `HoursDialog`;
   `EntryRow` carries `data-entry-id` and the landing class.
5. [x] Tests: e2e sees the ghost on commit; the existing notes-mode flow
   stays green.
6. [x] typecheck, unit, e2e; screenshots at 1100 and 390 wide reviewed.

## Findings / gotchas

- **Verifying while the checkout is shared.** Two other sessions were working
  in this tree, one of them with `typecheck` red mid-change, and one about to
  run its own e2e. Build and test results from that tree would have been
  neither mine nor theirs. What worked: `git worktree add --detach <tmp> HEAD`,
  copy in only my files, and run there — the shared checkout is never touched.
  `E2E_PORT=3240` moves all five e2e servers off 3140-3144 so both runs can
  proceed. Stage across the two trees with
  `git hash-object -w <worktree copy>` + `git update-index --cacheinfo`, which
  commits *my* version of a file the other session has since added to, leaving
  their edit in the working tree, unstaged and intact.
- **Don't share `node_modules` with the other checkout by junction.** Vite
  writes its loaded config to `node_modules/.vite-temp/…timestamp-*.mjs` and
  imports it back by absolute path: through a junction that path lands in the
  *other* tree, and the build dies with "Cannot find module". A peer building
  there at the same time can also sweep the file mid-load. Give the worktree
  its own `bun install` — 28s with a warm cache.

- **Take the source's position before the change, not after.** Stopping a
  timer unmounts the card it was on, and React empties that ref *before*
  `dispatch` resolves (the outbox applies the change optimistically on
  enqueue), so reading `ref.current` afterwards gives `null` — and a detached
  element measures 0×0 anyway. `whereItIs()` snapshots the point up front, in
  **document** coordinates, so the scroll that brings the row into view can't
  strand it; the flight converts back to the viewport once that scroll has
  settled. Caught by the e2e test for the timer flight, which found no pill.
- The destination row can be off screen on a phone (the Time column is below
  the notes). Scroll it into view first, then wait for the rect to stop
  moving — a smooth scroll's duration is the browser's business, so measure
  by comparing successive frames rather than by a fixed delay. `block:
  "nearest"`, so stopping a timer doesn't throw the screen away from the
  button just tapped.
- A running timer is *already* a row in the right column (an open entry is
  listed, with a "running" badge), so stopping one makes nothing appear
  there. The flight still earns its place: the card on the left goes, and the
  pill is what says where its time went.
- Mantine's `Modal` fades out over ~200ms. Starting the flight immediately
  puts the ghost under a dissolving overlay; it waits for the close instead.
- The optimistic model already holds the new entry by the time
  `dispatch("rollup.commit")` resolves (the outbox applies it on enqueue), so
  the row exists before the flight looks for it.

## Progress log

- 2026-09-21 — Deployed. The deployer pinned the digest built from the commit
  that carries this work; the live build id matches the one the pre-publish
  build produced, so what was verified is what is serving.

- 2026-09-21 — Both changes built and verified, in a throwaway worktree
  because the shared checkout had two other sessions mid-change: typecheck,
  273 unit tests, 45 chromium e2e (one throwaway spec drove a commit and
  caught the pill in flight and the landing ring), screenshots at 1100 and
  390 wide plus the flight frame by frame. Committed as `dabb3a3`; the
  worktree and its install were removed afterwards.

## Open questions for the user

None. The timer's flight was asked for and built (decision 4), and the
scroll that brings an off-screen row into view uses `block: "nearest"` so
stopping a timer doesn't throw the screen away from the button just tapped.

## Things not to do

- Don't put the flight behind a library — one `animate()` call is the whole
  of it.
- Don't animate anything the person can't see: if the destination is off
  screen, bring it into view first.
- Don't let the ghost outlive its row. A failed commit shows no flight.
