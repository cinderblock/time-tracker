import { describe, expect, test } from "bun:test";

import { workDateOf, zonedTimeToInstant } from "../../src/time.ts";
import { latestTimeOn, noteTimeOn } from "./note-time.ts";

const tz = "America/Los_Angeles";
const now = zonedTimeToInstant("2026-10-04", "12:00", tz);

describe("noteTimeOn", () => {
  test("a typed time on an earlier day lands on that day", () => {
    const r = noteTimeOn("2026-10-01", "14:30", tz, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.at).toBe(zonedTimeToInstant("2026-10-01", "14:30", tz));
    expect(workDateOf(r.at, tz)).toBe("2026-10-01");
  });

  test("a time has to be given", () => {
    expect(noteTimeOn("2026-10-01", "", tz, now)).toEqual({ ok: false, problem: "Say when." });
    expect(noteTimeOn("2026-10-01", "half two", tz, now)).toEqual({ ok: false, problem: "Say when." });
  });

  test("not later than now", () => {
    expect(noteTimeOn("2026-10-04", "13:00", tz, now)).toEqual({ ok: false, problem: "That's later than now." });
    expect(noteTimeOn("2026-10-04", "11:59", tz, now).ok).toBe(true);
  });
});

describe("latestTimeOn", () => {
  test("the latest note's time, or nothing on an empty day", () => {
    const at = (t: string) => ({ at: zonedTimeToInstant("2026-10-01", t, tz) });
    expect(latestTimeOn([at("09:15"), at("16:40"), at("11:00")], tz)).toBe("16:40");
    expect(latestTimeOn([], tz)).toBe("");
  });
});
