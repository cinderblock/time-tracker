import { describe, expect, test } from "bun:test";
import {
  addDays,
  decimalHours,
  durationSeconds,
  formatClock,
  formatDuration,
  formatDurationHuman,
  formatWorkDate,
  weekdayOf,
  workDateOf,
  zonedTimeInput,
  zonedTimeToInstant,
} from "./time.ts";

describe("workDateOf", () => {
  test("books late-evening work on the local day, not the UTC one", () => {
    // 2026-03-10 22:30 America/Los_Angeles is 2026-03-11 05:30 UTC. Naively
    // slicing an ISO string would book this on the 11th — a whole day of
    // payroll on the wrong date.
    const instant = Date.parse("2026-03-11T05:30:00Z");
    expect(workDateOf(instant, "America/Los_Angeles")).toBe("2026-03-10");
    expect(workDateOf(instant, "UTC")).toBe("2026-03-11");
  });

  test("handles the spring-forward transition", () => {
    // 2026-03-08 is the US DST change; 03:30 local exists on both sides of it.
    const instant = Date.parse("2026-03-08T11:30:00Z");
    expect(workDateOf(instant, "America/Los_Angeles")).toBe("2026-03-08");
  });
});

describe("durationSeconds", () => {
  const base = Date.parse("2026-09-15T16:00:00Z");

  test("sums closed segments", () => {
    expect(
      durationSeconds([
        { startedAt: base, endedAt: base + 60_000 },
        { startedAt: base + 120_000, endedAt: base + 300_000 },
      ]),
    ).toBe(240);
  });

  test("counts an open segment up to now", () => {
    expect(durationSeconds([{ startedAt: base, endedAt: null }], base + 90_000)).toBe(90);
  });

  test("ignores a segment whose clock went backwards", () => {
    // A phone that resyncs its clock mid-timer can produce end < start.
    // Contributing negative time would silently shrink the day's total.
    expect(durationSeconds([{ startedAt: base, endedAt: base - 60_000 }])).toBe(0);
  });

  test("is zero for no segments", () => {
    expect(durationSeconds([])).toBe(0);
  });
});

describe("formatDuration", () => {
  test("omits the hour field under an hour", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(65)).toBe("01:05");
  });

  test("shows hours once there are any", () => {
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(5025)).toBe("1:23:45");
  });

  test("clamps negatives rather than printing a minus sign", () => {
    expect(formatDuration(-10)).toBe("00:00");
  });
});

describe("formatDurationHuman", () => {
  test("drops empty fields", () => {
    expect(formatDurationHuman(1800)).toBe("30m");
    expect(formatDurationHuman(7200)).toBe("2h");
    expect(formatDurationHuman(5025)).toBe("1h 24m");
  });

  test("carries instead of printing 60m", () => {
    // 1h 59m 45s rounds the minutes to 60; that must become 2h.
    expect(formatDurationHuman(7185)).toBe("2h");
  });
});

describe("decimalHours", () => {
  test("rounds to hundredths, the payroll convention", () => {
    expect(decimalHours(3600)).toBe(1);
    expect(decimalHours(5400)).toBe(1.5);
    expect(decimalHours(1000)).toBe(0.28);
  });
});

describe("zone-aware conversions", () => {
  const LA = "America/Los_Angeles";

  test("round-trip a wall-clock time through an instant", () => {
    const t = zonedTimeToInstant("2026-09-16", "14:30", LA);
    expect(new Date(t).toISOString()).toBe("2026-09-16T21:30:00.000Z");
    expect(zonedTimeInput(t, LA)).toBe("14:30");
    expect(formatClock(t, LA)).toBe("2:30 PM");
    expect(workDateOf(t, LA)).toBe("2026-09-16");
  });

  test("a time the spring-forward gap skips lands just after the gap", () => {
    // 2026-03-08 02:30 doesn't exist in Los Angeles.
    const t = zonedTimeToInstant("2026-03-08", "02:30", LA);
    expect(zonedTimeInput(t, LA)).toBe("03:30");
  });

  test("a time the fall-back hour repeats resolves to the first occurrence", () => {
    // 2026-11-01 01:30 happens twice; the first is still daylight time.
    const t = zonedTimeToInstant("2026-11-01", "01:30", LA);
    expect(new Date(t).toISOString()).toBe("2026-11-01T08:30:00.000Z");
  });

  test("works for zones ahead of UTC and half-hour zones", () => {
    expect(new Date(zonedTimeToInstant("2026-09-16", "00:15", "Asia/Kolkata")).toISOString()).toBe(
      "2026-09-15T18:45:00.000Z",
    );
    expect(zonedTimeToInstant("2026-09-16", "09:00", "UTC")).toBe(Date.parse("2026-09-16T09:00:00Z"));
  });

  test("calendar helpers", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(formatWorkDate("2026-09-16")).toBe("Wed, Sep 16");
    expect(formatWorkDate("2026-09-16", { withYear: true })).toBe("Wed, Sep 16, 2026");
    expect(weekdayOf("2026-09-20")).toBe(0);
  });
});
