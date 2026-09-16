import { describe, expect, test } from "bun:test";

import { hourRange, layoutDay } from "./calendar-layout.ts";

const TZ = "America/Los_Angeles";
const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);
// 2026-09-16 in Los Angeles is UTC-7.
const nine = at("2026-09-16T16:00:00Z");

const block = (id: string, start: number, minutes: number | null) => ({
  id,
  start,
  end: minutes == null ? null : start + minutes * MIN,
});

const summary = (placed: ReturnType<typeof layoutDay<ReturnType<typeof block>>>) =>
  placed.map((p) => [p.item.id, p.from, p.to, p.lane, p.lanes]);

describe("layoutDay", () => {
  test("wall-clock minutes, lanes for overlaps, and a running block up to now", () => {
    const placed = layoutDay(
      [
        block("a", nine, 60), // 9:00–10:00
        block("b", nine + 30 * MIN, 60), // 9:30–10:30, overlaps a
        block("c", nine + 60 * MIN, 15), // 10:00–10:15, a's lane is free again
        block("d", nine + 3 * 60 * MIN, null), // 12:00, running
      ],
      "2026-09-16",
      TZ,
      nine + 3 * 60 * MIN + 20 * MIN,
    );
    expect(summary(placed)).toEqual([
      ["a", 540, 600, 0, 2],
      ["b", 570, 630, 1, 2],
      ["c", 600, 615, 0, 2],
      ["d", 720, 740, 0, 1],
    ]);
    expect(hourRange(placed)).toEqual({ first: 7, last: 18 });
  });

  test("work past midnight appears on both days, cut at the edges", () => {
    const late = block("x", at("2026-09-17T05:00:00Z"), 120); // 22:00 to midnight
    const overnight = block("y", at("2026-09-17T06:30:00Z"), 60); // 23:30–00:30
    const first = layoutDay([late, overnight], "2026-09-16", TZ, nine);
    expect(summary(first)).toEqual([
      ["x", 1320, 1440, 0, 2],
      ["y", 1410, 1440, 1, 2],
    ]);
    const second = layoutDay([late, overnight], "2026-09-17", TZ, nine);
    // "x" ends exactly at midnight, so it doesn't spill over.
    expect(summary(second)).toEqual([["y", 0, 30, 0, 1]]);
    expect(hourRange([...first, ...second])).toEqual({ first: 0, last: 24 });
  });

  test("blocks on other days are left out", () => {
    expect(layoutDay([block("z", nine, 60)], "2026-09-15", TZ, nine)).toEqual([]);
  });

  test("DST: positions follow the wall clock", () => {
    // 2026-11-01: clocks go back at 02:00 PDT -> 01:00 PST. 03:00 PST is 11:00 UTC.
    const placed = layoutDay([block("w", at("2026-11-01T11:00:00Z"), 60)], "2026-11-01", TZ, 0);
    expect(summary(placed)).toEqual([["w", 180, 240, 0, 1]]);
  });
});
