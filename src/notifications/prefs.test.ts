import { beforeEach, describe, expect, test } from "bun:test";

import { db } from "../db.server.ts";
import { freshDb } from "../testing/db.ts";
import { UserInputError, createUser } from "../users.ts";
import { DEFAULT_PREFS, getPrefs, parsePrefs, setPrefs } from "./prefs.ts";

let alice = 0;

beforeEach(() => {
  freshDb();
  alice = createUser({ name: "Alice", role: "employee", actorUserId: null }).id;
});

describe("defaults", () => {
  test("someone who never chose has the defaults", () => {
    expect(getPrefs(alice)).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS.workdays).toEqual([1, 2, 3, 4, 5]);
    expect(DEFAULT_PREFS.reminderAt).toBe("17:00");
    expect(DEFAULT_PREFS.dayEmpty).toEqual({ on: true, minHours: 0 });
    expect(DEFAULT_PREFS.unsubmitted).toEqual({ when: "weekly", weeklyOn: 5 });
  });

  test("a stored value from an older version reads, gaps filled and junk dropped", () => {
    expect(parsePrefs({ reminderAt: "18:15", dayEmpty: { on: false }, quietHours: "nonsense", extra: 1 })).toEqual({
      ...DEFAULT_PREFS,
      reminderAt: "18:15",
      dayEmpty: { on: false, minHours: 0 },
    });
    expect(parsePrefs({ reminderAt: "25:00" }).reminderAt).toBe("17:00");
  });
});

describe("saving", () => {
  test("round trips and is audited", () => {
    const next = { ...DEFAULT_PREFS, reminderAt: "16:45", workdays: [5, 1, 1] };
    const saved = setPrefs({ userId: alice, prefs: next, actorUserId: alice });
    expect(saved.workdays).toEqual([1, 5]);
    expect(getPrefs(alice)).toEqual(saved);
    const rows = db()
      .query<{ action: string }, [string]>("SELECT action FROM audit_log WHERE entity = 'user' AND entity_id = ?")
      .all(String(alice));
    expect(rows.map((r) => r.action)).toContain("notification_prefs");
  });

  test("refuses what doesn't fit rather than quietly using a default", () => {
    expect(() => setPrefs({ userId: alice, prefs: { ...DEFAULT_PREFS, reminderAt: "5pm" }, actorUserId: alice })).toThrow(
      UserInputError,
    );
    expect(() =>
      setPrefs({ userId: alice, prefs: { ...DEFAULT_PREFS, repeat: { everyMinutes: 7, maxTimes: 3 } }, actorUserId: alice }),
    ).toThrow(UserInputError);
    expect(() =>
      setPrefs({ userId: alice, prefs: { ...DEFAULT_PREFS, quietHours: { on: true, from: "20:00", until: "07:00" } }, actorUserId: alice }),
    ).toThrow("Quiet hours");
    expect(() => setPrefs({ userId: alice, prefs: { ...DEFAULT_PREFS, workdays: [] }, actorUserId: alice })).toThrow("workday");
    expect(getPrefs(alice)).toEqual(DEFAULT_PREFS);
  });
});
