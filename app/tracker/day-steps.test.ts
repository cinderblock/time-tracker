import { describe, expect, test } from "bun:test";

import { daySteps } from "./day-steps.ts";
import { rolloverCheck } from "./rollover.ts";

/** Wednesday 23 September 2026, in a week that began on Sunday the 20th. */
const TODAY = "2026-09-23";
const SUNDAY_WEEK = "2026-09-20";

const steps = (workDate: string, extra: { weekStart?: string; today?: string; heldHere?: boolean } = {}) =>
  daySteps({
    workDate,
    today: extra.today ?? TODAY,
    weekStart: extra.weekStart ?? SUNDAY_WEEK,
    heldHere: extra.heldHere ?? false,
  });

describe("daySteps", () => {
  test("on today, neither forward arrow has anywhere to go", () => {
    expect(steps(TODAY)).toEqual({
      previousWeek: "2026-09-16",
      previousDay: "2026-09-22",
      nextDay: null,
      nextWeek: null,
    });
  });

  test("earlier in the week today is in, a day forward works but a week doesn't", () => {
    // Monday: forward a week would be next Monday, which hasn't happened —
    // and this week is already the week on screen, so there is no week to go to.
    expect(steps("2026-09-21")).toMatchObject({ nextDay: "2026-09-22", nextWeek: null });
  });

  test("a week forward lands on today when that weekday is still to come", () => {
    // Friday the 18th, a week on, is the 25th — two days after today. Rather
    // than refuse, it goes as far as it can.
    expect(steps("2026-09-18", { weekStart: "2026-09-13" })).toMatchObject({
      previousWeek: "2026-09-11",
      nextDay: "2026-09-19",
      nextWeek: TODAY,
    });
  });

  test("further back, a week forward is a whole week", () => {
    expect(steps("2026-09-09", { weekStart: "2026-09-06" })).toMatchObject({ nextWeek: "2026-09-16" });
  });

  test("a day holding its notes lets you back out but not on", () => {
    expect(steps("2026-09-18", { weekStart: "2026-09-13", heldHere: true })).toEqual({
      previousWeek: "2026-09-11",
      previousDay: "2026-09-17",
      nextDay: null,
      nextWeek: null,
    });
  });

  test("the week the strip is showing says which weekday weeks start on", () => {
    // The same days, for an organisation whose weeks start on Monday: the
    // week containing today now starts on the 21st, so a Monday-the-21st page
    // still has nowhere to go a week forward...
    expect(steps("2026-09-21", { weekStart: "2026-09-21" })).toMatchObject({ nextWeek: null });
    // ...while the week before it does, landing on the 21st.
    expect(steps("2026-09-14", { weekStart: "2026-09-14" })).toMatchObject({ nextWeek: "2026-09-21" });
  });

  test("a week back crosses months and years without help", () => {
    expect(steps("2027-01-03", { today: "2027-01-05", weekStart: "2027-01-03" })).toMatchObject({
      previousWeek: "2026-12-27",
      previousDay: "2027-01-02",
    });
  });
});

const PT = "America/Los_Angeles";
/** Midnight ending 23 September 2026 in PT (UTC-7 that month), as an instant. */
const NEXT_MIDNIGHT = Date.parse("2026-09-24T07:00:00Z");
/** `rolloverCheck` waits this long past the boundary before asking. */
const SETTLE = 2_000;

describe("rolloverCheck", () => {
  test("mid-morning on the day the copy was made, it sleeps until just past midnight", () => {
    const now = Date.parse("2026-09-23T17:00:00Z");
    expect(rolloverCheck(now, "2026-09-23", PT, 0)).toEqual({
      stale: false,
      nextCheckIn: NEXT_MIDNIGHT + SETTLE - now,
    });
  });

  test("a second before midnight is still the same day, and it waits out the second", () => {
    const now = NEXT_MIDNIGHT - 1_000;
    expect(rolloverCheck(now, "2026-09-23", PT, 0)).toEqual({ stale: false, nextCheckIn: 1_000 + SETTLE });
  });

  test("half a second after midnight, the copy on screen is out of date", () => {
    expect(rolloverCheck(NEXT_MIDNIGHT + 500, "2026-09-23", PT, 0).stale).toBe(true);
  });

  test("a page left open for two days is out of date, and asks again soon", () => {
    const now = Date.parse("2026-09-23T17:00:00Z");
    expect(rolloverCheck(now, "2026-09-21", PT, 0)).toEqual({ stale: true, nextCheckIn: 60_000 });
  });

  test("once it has asked its three times and still been told the old day, it stops until the next midnight", () => {
    const now = Date.parse("2026-09-23T17:00:00Z");
    expect(rolloverCheck(now, "2026-09-21", PT, 3)).toEqual({
      stale: true,
      nextCheckIn: NEXT_MIDNIGHT + SETTLE - now,
    });
  });

  test("a device clock that lags says nothing the loader hasn't", () => {
    // The copy is from the 25th and this device thinks it's the 23rd. Going
    // backwards is never a rollover, so there is nothing to ask for.
    const now = Date.parse("2026-09-23T17:00:00Z");
    expect(rolloverCheck(now, "2026-09-25", PT, 0).stale).toBe(false);
  });

  test("the night the clocks go back is twenty-five hours long, and the wait is too", () => {
    // 4am on 1 November 2026, after PT has fallen back to UTC-8. Midnight is
    // twenty hours away, not nineteen.
    const now = Date.parse("2026-11-01T12:00:00Z");
    expect(rolloverCheck(now, "2026-11-01", PT, 0).nextCheckIn).toBe(
      Date.parse("2026-11-02T08:00:00Z") + SETTLE - now,
    );
  });

  test("and the night they go forward is twenty-three", () => {
    // Noon on 7 March 2026, the day before PT springs forward.
    const now = Date.parse("2026-03-07T20:00:00Z");
    expect(rolloverCheck(now, "2026-03-07", PT, 0).nextCheckIn).toBe(
      Date.parse("2026-03-08T08:00:00Z") + SETTLE - now,
    );
  });
});
