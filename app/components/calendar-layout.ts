import { addDays, zonedParts, zonedTimeToInstant } from "../../src/time.ts";

/**
 * Placing time blocks on a day column. Pure, so it's tested directly.
 *
 * Positions are wall-clock minutes of the day (0–1440) in the organisation's
 * zone, so a block at 9:00 sits at the 9:00 line even on a DST-change day.
 * A block that crosses midnight is cut at the day's edges and appears on
 * both days. Blocks that overlap share the width, side by side in lanes.
 */

export interface Span {
  start: number;
  /** Instant it ended; null while running (pass `now`). */
  end: number | null;
}

export interface Placed<T> {
  item: T;
  /** Minutes from the day's midnight. */
  from: number;
  to: number;
  lane: number;
  lanes: number;
}

const DAY_MINUTES = 24 * 60;

function minuteOfDay(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return p.hour * 60 + p.minute + p.second / 60;
}

export function layoutDay<T extends Span>(items: readonly T[], date: string, timeZone: string, now: number): Placed<T>[] {
  const dayStart = zonedTimeToInstant(date, "00:00", timeZone);
  const dayEnd = zonedTimeToInstant(addDays(date, 1), "00:00", timeZone);

  const clipped: Placed<T>[] = [];
  for (const item of items) {
    const end = item.end ?? Math.max(now, item.start);
    if (item.start >= dayEnd || end < dayStart || (end === dayStart && item.start < dayStart)) continue;
    const from = item.start <= dayStart ? 0 : minuteOfDay(item.start, timeZone);
    let to = end >= dayEnd ? DAY_MINUTES : minuteOfDay(end, timeZone);
    // The repeated hour when clocks go back can put the end "before" the start.
    if (to < from) to = from;
    clipped.push({ item, from, to, lane: 0, lanes: 1 });
  }
  clipped.sort((a, b) => a.from - b.from || a.to - b.to);

  // Group transitively overlapping blocks; within a group, each block takes
  // the first lane that's free by its start.
  let group: Placed<T>[] = [];
  let groupEnd = -1;
  let laneEnds: number[] = [];
  const close = () => {
    for (const p of group) p.lanes = laneEnds.length;
    group = [];
    laneEnds = [];
  };
  for (const p of clipped) {
    if (group.length && p.from >= groupEnd) close();
    let lane = laneEnds.findIndex((e) => e <= p.from);
    if (lane < 0) lane = laneEnds.push(0) - 1;
    // Zero-length blocks (a timer that just started) still take up their lane briefly.
    laneEnds[lane] = Math.max(p.to, p.from + 1);
    p.lane = lane;
    group.push(p);
    groupEnd = Math.max(groupEnd, laneEnds[lane]!);
  }
  close();
  return clipped;
}

/** The hours to draw: 7–18 at least, widened to fit every block. */
export function hourRange(placed: readonly Placed<unknown>[]): { first: number; last: number } {
  let first = 7;
  let last = 18;
  for (const p of placed) {
    first = Math.min(first, Math.floor(p.from / 60));
    last = Math.max(last, Math.ceil(p.to / 60));
  }
  return { first: Math.max(0, first), last: Math.min(24, last) };
}
