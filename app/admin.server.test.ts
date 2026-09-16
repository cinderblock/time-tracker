import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";

import { setWeekStartsOn } from "../src/settings.ts";
import { freshDb } from "../src/testing/db.ts";
import { reportQuery, weekFromUrl } from "./admin.server.ts";

const url = (query: string) => new URL(`http://test/admin/reports?${query}`);

beforeEach(() => {
  freshDb();
  // Thursday 2026-01-15, midday in Los Angeles.
  setSystemTime(new Date("2026-01-15T20:00:00Z"));
});

afterEach(() => {
  setSystemTime();
});

describe("reportQuery", () => {
  test("defaults: this week, by person, everyone", () => {
    expect(reportQuery(url(""))).toMatchObject({
      range: "this-week",
      from: "2026-01-11",
      to: "2026-01-17",
      by: "person",
      personId: null,
      categoryId: null,
      jobId: null,
    });
  });

  test("presets follow the calendar, across a year boundary", () => {
    expect(reportQuery(url("range=last-week"))).toMatchObject({ from: "2026-01-04", to: "2026-01-10" });
    expect(reportQuery(url("range=this-month"))).toMatchObject({ from: "2026-01-01", to: "2026-01-31" });
    expect(reportQuery(url("range=last-month"))).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
    setWeekStartsOn(1, null);
    expect(reportQuery(url("range=last-week"))).toMatchObject({ from: "2026-01-05", to: "2026-01-11" });
  });

  test("picked dates: swapped when backwards, capped in length, ignored when invalid", () => {
    expect(reportQuery(url("range=custom&from=2026-01-10&to=2026-01-02"))).toMatchObject({
      range: "custom",
      from: "2026-01-02",
      to: "2026-01-10",
    });
    expect(reportQuery(url("range=custom&from=2000-01-01&to=2026-01-10"))).toMatchObject({
      from: "2024-12-07",
      to: "2026-01-10",
    });
    expect(reportQuery(url("range=custom&from=2026-02-30&to=2026-03-01"))).toMatchObject({
      range: "this-week",
      from: "2026-01-11",
    });
  });

  test("unknown grouping, ids and jobs are dropped", () => {
    const q = reportQuery(url("by=planet&person=abc&category=-3&job=nope"));
    expect(q).toMatchObject({ by: "person", personId: null, categoryId: null, jobId: null });
    expect(q.filter.userIds).toBeUndefined();
    expect(reportQuery(url("by=day&person=7")).filter).toMatchObject({ userIds: [7] });
  });
});

describe("weekFromUrl", () => {
  test("any date picks its week; nonsense means this week", () => {
    const req = (q: string) => new Request(`http://test/admin/timesheets${q}`);
    expect(weekFromUrl(req(""))).toEqual({ weekStart: "2026-01-11", thisWeek: "2026-01-11", today: "2026-01-15" });
    expect(weekFromUrl(req("?week=2025-12-31")).weekStart).toBe("2025-12-28");
    expect(weekFromUrl(req("?week=yesterday")).weekStart).toBe("2026-01-11");
  });
});
