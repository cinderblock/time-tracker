# Motion: nothing jumps, nothing flickers

## Goal

Two things, one subject.

1. **No flash of the wrong UI when a dialog closes.** Closing "Edit entry"
   shows the "Add time" form for the length of the fade-out. Three dialogs
   have this bug; it is one bug.
2. **Motion that reads as one system.** Today the app has one beautiful
   animation (the hours flight, `app/tracker/flight.tsx`) and then a set of
   hard cuts everywhere else: rows appear instantly, the timer card swaps for
   "Start a timer" with no transition, and nothing but the flight respects
   `prefers-reduced-motion`.

## Environment / context

- Repo: `~/git/Personal Projects/time-tracker` (shared working tree).
- Checks: `bun run typecheck`, `bun test src/ app/`, `bun run test:e2e`.
- Mantine 9. `Modal`'s default transition is `pop` at **200 ms**
  (`node_modules/@mantine/core/esm/components/ModalBase/use-modal-transition.mjs:5`),
  and children stay mounted for all of it.
- `theme.respectReducedMotion` defaults to **`false`** in Mantine
  (`core/MantineProvider/default-theme.mjs:23`) and is not set in
  `app/root.tsx`. So every Mantine transition currently ignores the OS
  setting; only `flight.tsx` checks it, by hand.
- No `browserslist`; Vite's default target. `@starting-style` (Chrome 117,
  Safari 17.5, Firefox 129) is safe here and degrades to "no animation".

## Decisions already made (don't re-ask)

1. **The flash is fixed by holding the value, not by delaying the close.**
   A shared hook keeps the last non-null value for as long as the dialog is
   still on screen. Delaying `setEditing(null)` behind a timer would put a
   race between the close animation and the data in every call site.
2. **One hook, three call sites.** `EntryEditor` (`entry`),
   `SwitchNoteModal` in `TimerCard.tsx` (`job` — its body renders
   "switches to ." during the fade), and `link-reveal.tsx` (`link`). Fixing
   only the one that was reported would leave two known instances of the same
   bug in the tree.
3. **Reduced motion is respected app-wide**, via `respectReducedMotion: true`
   on the theme plus a media query on the hand-written keyframes. The flight's
   own check stays — it guards a whole code path, not just a duration.
4. **Motion is defined once**, as CSS custom properties on `:root`
   (durations and easing), and everything reads them. A per-component
   `200ms ease` sprinkled around is how a UI ends up feeling arbitrary.
5. **Enter animations only, for lists.** A row fading and rising in on mount
   is `@starting-style` and costs nothing. Exit animations need the removed
   item held in state, which means the list can disagree with the model about
   what exists — not worth it for a row that's already gone.

## Plan / steps

1. [x] Plan written.
2. [x] `app/components/use-held-open.ts` — the hook, with the reasoning in its
   comment.
3. [x] Applied at the three call sites.
4. [x] `app/motion.ts` — the scale, injected into the head as custom
   properties from the same constants JavaScript reads;
   `respectReducedMotion: true` on the theme.
5. [x] Modal transitions take their duration and easing from it, as theme
   defaults, so every dialog opens and closes the same way.
6. [x] Entry rows, note rows, note sections, the timer cards and the submit
   panels enter with `@starting-style` (`app/components/appear.module.css`).
7. [~] The timer card swap — see the findings; the replacement card fades in,
   but the column's height still jumps. Deliberate.
8. [x] The landing flash reads `--motion-flash`, and `flight.tsx` takes
   `FLASH_MS` and `MODAL_CLOSE_MS` from the same constants.
9. [x] Proved with a frame probe, then kept as a real test rather than thrown
   away: "the editor keeps its own face all the way through closing" in
   `e2e/tracking.spec.ts`.
10. [x] typecheck, 311 unit, 62 e2e green. Committed.

## Findings / gotchas

- **The flash, proved.** A frame probe logged the dialog's contents every
  animation frame across a close. Before, collapsed to its transitions:

  ```
  === CLOSE (duration-only entry) ===
  Edit entry | -      | delete | Job *, Date *, Time worked *, Note
  Add time   | toggle | -      | Job *, Start & end, Just a duration, Date *, Time worked *, Note
  (no dialog)
  ```

  After: `Edit entry` straight through to `(no dialog)`. Opening never
  flashed — only closing.
- **The fix broke a passing test, correctly.** `auth.spec.ts` asserted that
  the invite label was visible on the page right after clicking Done. With
  the dialog now *keeping* that label through its fade, the locator matched
  twice and Playwright's strict mode failed it. The test wanted "once the
  dialog is gone", so it now waits for that. A test that only passed because
  a dialog went blank was testing the bug.
- `EntryEditor`'s reset effect keys on `[opened, entry]` and returns early
  when `!opened`, so the *fields* already kept their values through a close.
  Only the chrome — title, toggle, Delete, submit label — flipped.
- `respectReducedMotion` is Mantine's own switch and it defaults to **off**
  (`core/MantineProvider/default-theme.mjs:23`); with it on, `useTransition`
  sets the duration to 0 rather than merely shortening it, so the flight's
  separate hand-rolled check still earns its keep — it skips a whole code
  path, not a duration.
- `@starting-style` survives the build and CSS Modules scopes the class
  inside it correctly (`@starting-style{._appear_bvh7t_20{...}}` in
  `build/client/assets/TrackerScreen-*.css`).
- **The remaining jump is height, and it is left alone.** Stopping a timer
  swaps a tall card for a short one; the new card fades in, but the column
  still reflows in one frame. Animating that needs `interpolate-size` /
  `calc-size`, which Safari doesn't have — and this app is used on iPhones.
  Not worth a JS height-measuring harness.

## Progress log

- 2026-09-21 — The flash diagnosed and proved with a frame probe. Two more
  instances of the same bug found by grepping `<Modal`.
- 2026-09-22 — Built and verified in one pass. `use-held-open.ts` at all three
  call sites; `motion.ts` as the single source for durations and easings, read
  by both the theme and the stylesheets; `appear.module.css` on everything
  that arrives on screen; `respectReducedMotion` on. The frame probe became a
  standing e2e test. One existing test corrected (see findings). typecheck,
  311 unit and 62 e2e green.

- 2026-09-22 — **Deployed** at `ba76b12` (image `sha256:4fd1a29d…`, ops
  `ebc9654`), live on time.twilltech.com. CI was red twice on the way, neither
  time for anything in this plan: a real note-box race the app had (see
  `plans/time-tracker.md`) and an exact-float layout assertion.

## Open questions for the user

1. The enter animation is 200 ms with a 6px rise. It is meant to be felt
   rather than watched. If rows arriving still read as abrupt — or as
   sluggish — the numbers to turn are `MOTION.base` and the `translateY` in
   `appear.module.css`, and they move everything together.

## Things not to do

- Don't fix the flash by keeping the dialog mounted with `keepMounted` — it
  changes focus and form-reset behaviour for every dialog to paper over a
  render bug.
- Don't animate list exits by holding removed rows in component state
  (decision 5).
- Don't let `MODAL_CLOSE_MS` in `flight.tsx` drift from the modal's real
  duration.
