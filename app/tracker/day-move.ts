import { addDays } from "../../src/time.ts";
import { MOTION } from "../motion.ts";

/**
 * Which way a navigation moves the day, written where CSS can see it.
 *
 * Moving within the week shown is a move of the day — the highlight slides
 * along the strip to the new date — and moving to a day outside it is a move
 * of the week, where the whole strip slides out and the new one in. The
 * animation in `day-move.css` needs to know which of the four it is. React
 * Router starts the view transition as it commits the navigation, and a
 * link's `onClick` runs before that — so this is set from the click, and the
 * attribute is already on `<html>` by the time the old frame is captured.
 */

export type DayMove = "day-later" | "day-earlier" | "week-later" | "week-earlier";

/**
 * The move from `from` to `to`, given the first day of the week on screen.
 * A step of one day off the end of the strip is a week move too: the strip
 * has to change, and a highlight sliding from one edge to the other would
 * say the opposite of what happened.
 */
export function moveBetween(from: string, to: string, weekStart: string): DayMove {
  const later = to > from;
  const inWeek = to >= weekStart && to <= addDays(weekStart, 6);
  return `${inWeek ? "day" : "week"}-${later ? "later" : "earlier"}`;
}

let clearing = 0;

/**
 * Clearing the attribute afterwards is tidiness only: every navigation that
 * animates sets it first, so a stale value can never be read by the next one.
 */
export function markDayMove(move: DayMove): void {
  document.documentElement.dataset.dayMove = move;
  window.clearTimeout(clearing);
  // The stylesheet's duration rather than the constant's, so a page that has
  // slowed the motion down (a probe, say) keeps the attribute for the whole
  // of the slide — the animations hang off it, and lose it mid-flight if it
  // goes early.
  const base = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--motion-base")) || MOTION.base;
  clearing = window.setTimeout(
    () => {
      delete document.documentElement.dataset.dayMove;
    },
    Math.max(MOTION.slow, base) + 200,
  );
}
