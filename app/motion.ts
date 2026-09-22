/**
 * One motion language for the whole app, defined once.
 *
 * Durations and easings live here as numbers because two things need them in
 * JavaScript — Mantine's modal transition, and the hours flight's wait for
 * that transition to finish (`app/tracker/flight.tsx`) — and everything else
 * needs them in CSS. `motionCss` below is injected into the document head, so
 * stylesheets read the same values through custom properties rather than
 * keeping a second copy that can drift out of step.
 *
 * Reduced motion is honoured in two places, for the same reason it always is:
 * `respectReducedMotion` on the theme covers Mantine's own transitions, and
 * the media query below zeroes the durations that hand-written CSS uses.
 * Easings are left alone — a zero-length animation doesn't care about them.
 */
export const MOTION = {
  /** Something under the finger: a control answering a tap. */
  fast: 120,
  /** The everyday one: a dialog, a panel, a row arriving. */
  base: 200,
  /** Something crossing the screen. */
  slow: 320,
  /**
   * The landing flash on a row that has just received time: long enough to be
   * seen without being asked to watch for it. Deliberately *not* zeroed under
   * reduced motion — it is a fading ring, not movement, and it is the whole
   * of what someone who asked for no motion gets in place of the flight.
   */
  flash: 900,
  /**
   * Decelerating — quick away, settling at the end. What arriving feels like,
   * and what the hours flight has always used.
   */
  entrance: "cubic-bezier(0.22, 0.7, 0.2, 1)",
  /** Accelerating. What leaving feels like: get out of the way. */
  exit: "cubic-bezier(0.4, 0, 1, 1)",
} as const;

/** The same values as custom properties, for stylesheets. */
export const motionCss = `
:root {
  --motion-fast: ${MOTION.fast}ms;
  --motion-base: ${MOTION.base}ms;
  --motion-slow: ${MOTION.slow}ms;
  --motion-flash: ${MOTION.flash}ms;
  --ease-entrance: ${MOTION.entrance};
  --ease-exit: ${MOTION.exit};
}
@media (prefers-reduced-motion: reduce) {
  :root {
    --motion-fast: 0ms;
    --motion-base: 0ms;
    --motion-slow: 0ms;
  }
}
`.trim();
