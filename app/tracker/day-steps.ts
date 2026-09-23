import { addDays, weekStartOf, weekdayOf } from "../../src/time.ts";

/**
 * Where the day header's four arrows go, and which of them have anywhere to
 * go at all. Kept away from the component so the rules can be read — and
 * tested — on their own.
 */

export interface DaySteps {
  previousWeek: string;
  previousDay: string;
  /** Null when there is no forward move: today, or a day holding you there. */
  nextDay: string | null;
  nextWeek: string | null;
}

/**
 * Forward stops at today — a day that hasn't happened can't be tracked — and
 * in notes mode a day whose notes haven't become hours holds you on it until
 * they have.
 *
 * A week forward lands on **today** rather than refusing when the same
 * weekday in that week is still to come: from last Friday a week on is this
 * week, and this week's Friday may be days away. It is only unavailable once
 * the week on screen is the one today is in, which is what "you can't go past
 * this week" means.
 */
export function daySteps(opts: {
  workDate: string;
  today: string;
  /** First day of the week the strip is showing — it also says which weekday weeks start on here. */
  weekStart: string;
  /** Notes mode: this day's notes have to become hours before moving on from it. */
  heldHere: boolean;
}): DaySteps {
  const { workDate, today, weekStart, heldHere } = opts;
  const forward = workDate < today && !heldHere;
  const thisWeekStart = weekStartOf(today, weekdayOf(weekStart));
  const aWeekOn = addDays(workDate, 7);
  return {
    previousWeek: addDays(workDate, -7),
    previousDay: addDays(workDate, -1),
    nextDay: forward ? addDays(workDate, 1) : null,
    nextWeek: forward && weekStart < thisWeekStart ? (aWeekOn > today ? today : aWeekOn) : null,
  };
}
