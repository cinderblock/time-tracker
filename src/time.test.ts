import { describe, expect, test } from "bun:test";
import { decimalHours, durationSeconds, formatDuration, formatDurationHuman, workDateOf } from "./time.ts";

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
