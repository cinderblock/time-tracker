import { MOTION } from "../motion.ts";

/**
 * Which way a navigation moves the day, written where CSS can see it.
 *
 * Moving between days is a move sideways and moving between weeks is a move
 * up or down, so the animation in `day-move.css` needs to know which of the
 * four it is. React Router starts the view transition as it commits the
 * navigation, and a link's `onClick` runs before that — so this is set from
 * the click, and the attribute is already on `<html>` by the time the old
 * frame is captured.
 */

export type DayMove = "day-later" | "day-earlier" | "week-later" | "week-earlier";

/** Which way a day-at-a-time move goes. */
export function towards(from: string, to: string): DayMove {
  return to > from ? "day-later" : "day-earlier";
}

let clearing = 0;

/**
 * Clearing the attribute afterwards is tidiness only: every navigation that
 * animates sets it first, so a stale value can never be read by the next one.
 */
export function markDayMove(move: DayMove): void {
  document.documentElement.dataset.dayMove = move;
  window.clearTimeout(clearing);
  clearing = window.setTimeout(() => {
    delete document.documentElement.dataset.dayMove;
  }, MOTION.slow + 200);
}
