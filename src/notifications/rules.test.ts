import { describe, expect, test } from "bun:test";

import { DEFAULT_PREFS, type NotificationPrefs, parsePrefs } from "./prefs.ts";
import { type Kind, type LogEntry, type PersonState, type SentLog, dueNotifications } from "./rules.ts";

const MIN = 60_000;
// Friday 2026-10-02. Only `minutesNow` and `now` move; the rules never read the zone.
const FRIDAY = "2026-10-02";
const NOW = Date.parse("2026-10-03T00:00:00Z"); // 17:00 in Los Angeles

function state(over: Partial<PersonState> = {}): PersonState {
  return {
    isAdmin: false,
    today: FRIDAY,
    minutesNow: 17 * 60,
    dayOff: false,
    secondsToday: 0,
    timer: null,
    notesToday: 0,
    notesEarlier: null,
    draftDays: [],
    held: [],
    failed: [],
    attention: null,
    ...over,
  };
}

function prefs(over: Record<string, unknown> = {}): NotificationPrefs {
  return parsePrefs({ ...DEFAULT_PREFS, ...over });
}

/** An in-memory sent log. */
function log(entries: Partial<LogEntry>[] = []): SentLog {
  const all: LogEntry[] = entries.map((e) => ({
    kind: "day_empty",
    key: FRIDAY,
    lastAt: NOW - 60 * MIN,
    sentCount: 1,
    snoozedUntil: null,
    ...e,
  }));
  return {
    get: (kind, key) => all.find((e) => e.kind === kind && e.key === key) ?? null,
    latest: (kind) =>
      all.filter((e) => e.kind === kind).sort((a, b) => b.lastAt - a.lastAt)[0] ?? null,
  };
}

const kinds = (due: { kind: Kind; key: string }[]) => due.map((d) => `${d.kind}@${d.key}`);

describe("no time entered", () => {
  test("goes at the reminder time on a workday with nothing recorded", () => {
    expect(kinds(dueNotifications(prefs(), state({ minutesNow: 16 * 60 + 59 }), log(), NOW))).toEqual([]);
    const due = dueNotifications(prefs(), state(), log(), NOW);
    expect(kinds(due)).toEqual([`day_empty@${FRIDAY}`]);
    expect(due[0]!.title).toBe("No time entered today");
    expect(due[0]!.url).toBe("/");
    expect(due[0]!.actions.map((a) => a.action)).toEqual(["snooze", "day-off"]);
  });

  test("not when there is any time, a timer open, or notes waiting", () => {
    expect(dueNotifications(prefs(), state({ secondsToday: 60 }), log(), NOW)).toEqual([]);
    expect(kinds(dueNotifications(prefs(), state({ notesToday: 2 }), log(), NOW))).toEqual([`notes_pending@${FRIDAY}`]);
    const timer = { entryId: "e1", job: "Widget", seconds: 3600, running: true };
    expect(kinds(dueNotifications(prefs(), state({ timer }), log(), NOW))).toEqual([`timer_running@${FRIDAY}`]);
  });

  test("with a minimum, goes when the day is short of it", () => {
    const p = prefs({ dayEmpty: { on: true, minHours: 8 } });
    const due = dueNotifications(p, state({ secondsToday: 6 * 3600 }), log(), NOW);
    expect(kinds(due)).toEqual([`day_empty@${FRIDAY}`]);
    expect(due[0]!.title).toBe("Only 6h entered today");
    expect(dueNotifications(p, state({ secondsToday: 8 * 3600 }), log(), NOW)).toEqual([]);
  });

  test("not on a day that isn't a workday, a day off, or while paused", () => {
    expect(dueNotifications(prefs({ workdays: [1, 2, 3, 4] }), state(), log(), NOW)).toEqual([]);
    expect(dueNotifications(prefs(), state({ dayOff: true }), log(), NOW)).toEqual([]);
    expect(dueNotifications(prefs({ pausedThrough: FRIDAY }), state(), log(), NOW)).toEqual([]);
    expect(dueNotifications(prefs({ pausedThrough: "2026-10-01" }), state(), log(), NOW)).toHaveLength(1);
  });

  test("off means off", () => {
    expect(dueNotifications(prefs({ dayEmpty: { on: false, minHours: 0 } }), state(), log(), NOW)).toEqual([]);
  });

  test("a later reminder time waits for it", () => {
    expect(dueNotifications(prefs({ reminderAt: "18:30" }), state(), log(), NOW)).toEqual([]);
    expect(dueNotifications(prefs({ reminderAt: "18:30" }), state({ minutesNow: 18 * 60 + 30 }), log(), NOW)).toHaveLength(1);
  });
});

describe("once, or repeated", () => {
  test("once by default", () => {
    expect(dueNotifications(prefs(), state(), log([{}]), NOW)).toEqual([]);
  });

  test("repeats every N minutes while it still applies, up to the limit", () => {
    const p = prefs({ repeat: { everyMinutes: 30, maxTimes: 3 } });
    expect(dueNotifications(p, state(), log([{ lastAt: NOW - 29 * MIN }]), NOW)).toEqual([]);
    expect(dueNotifications(p, state(), log([{ lastAt: NOW - 30 * MIN, sentCount: 2 }]), NOW)).toHaveLength(1);
    expect(dueNotifications(p, state(), log([{ lastAt: NOW - 90 * MIN, sentCount: 3 }]), NOW)).toEqual([]);
  });

  test("a snooze sends it again once it runs out, even with repeats off", () => {
    const snoozed = { lastAt: NOW - 61 * MIN, snoozedUntil: NOW + MIN };
    expect(dueNotifications(prefs(), state(), log([snoozed]), NOW)).toEqual([]);
    expect(dueNotifications(prefs(), state(), log([{ ...snoozed, snoozedUntil: NOW }]), NOW)).toHaveLength(1);
  });

  test("tomorrow is a new key", () => {
    const due = dueNotifications(prefs(), state({ today: "2026-10-05" }), log([{}]), NOW);
    expect(kinds(due)).toEqual(["day_empty@2026-10-05"]);
  });
});

describe("notes", () => {
  test("in the morning, about an earlier day still waiting", () => {
    const s = state({ minutesNow: 8 * 60 + 30, notesEarlier: { date: "2026-10-01", count: 3 }, secondsToday: 1 });
    const due = dueNotifications(prefs(), s, log(), NOW);
    expect(kinds(due)).toEqual([`notes_pending@morning:${FRIDAY}`]);
    expect(due[0]!.title).toBe("Thu, Oct 1's notes still need turning into hours");
    expect(due[0]!.url).toBe("/day/2026-10-01");
    expect(dueNotifications(prefs(), { ...s, minutesNow: 8 * 60 + 29 }, log(), NOW)).toEqual([]);
    const noMorning = prefs({ notesPending: { on: true, morning: false, morningAt: "08:30" } });
    expect(dueNotifications(noMorning, s, log(), NOW)).toEqual([]);
  });
});

describe("timers", () => {
  const running = { entryId: "e1", job: "Widget", seconds: 9 * 3600, running: true };

  test("still going at the reminder time", () => {
    const due = dueNotifications(prefs(), state({ timer: running }), log(), NOW);
    expect(due[0]!.title).toBe("A timer is still running");
    expect(due[0]!.body).toContain("on Widget");
  });

  test("paused rather than stopped says so", () => {
    const due = dueNotifications(prefs(), state({ timer: { ...running, running: false } }), log(), NOW);
    expect(due[0]!.title).toBe("A timer is paused, not stopped");
  });

  test("running very long: an alert, once per timer, inside quiet hours' window", () => {
    const long = { ...running, seconds: 10 * 3600 };
    const at10 = state({ timer: long, minutesNow: 10 * 60 });
    expect(kinds(dueNotifications(prefs(), at10, log(), NOW))).toEqual(["timer_running@long:e1"]);
    expect(dueNotifications(prefs(), at10, log([{ kind: "timer_running", key: "long:e1" }]), NOW)).toEqual([]);
    // 03:00: waits for the window.
    expect(dueNotifications(prefs(), { ...at10, minutesNow: 3 * 60 }, log(), NOW)).toEqual([]);
    // Quiet hours off: any time.
    const anyTime = prefs({ quietHours: { on: false, from: "07:00", until: "20:00" } });
    expect(dueNotifications(anyTime, { ...at10, minutesNow: 3 * 60 }, log(), NOW)).toHaveLength(1);
    // Under the threshold, or switched off: nothing.
    expect(dueNotifications(prefs(), { ...at10, timer: { ...long, seconds: 10 * 3600 - 1 } }, log(), NOW)).toEqual([]);
    const notLong = prefs({ timerRunning: { atReminder: true, long: false, longHours: 10 } });
    expect(dueNotifications(notLong, at10, log(), NOW)).toEqual([]);
  });
});

describe("days not submitted", () => {
  test("weekly by default, on Friday, counting the week so far", () => {
    const s = state({ draftDays: [FRIDAY, "2026-09-30"], secondsToday: 3600 });
    const due = dueNotifications(prefs(), s, log(), NOW);
    expect(kinds(due)).toEqual([`unsubmitted@week:${FRIDAY}`]);
    expect(due[0]!.title).toBe("2 days not submitted");
    expect(due[0]!.url).toBe("/day/2026-09-30");
    expect(dueNotifications(prefs(), { ...s, today: "2026-10-01" }, log(), NOW)).toEqual([]);
  });

  test("daily: earlier days only", () => {
    const p = prefs({ unsubmitted: { when: "daily", weeklyOn: 5 } });
    expect(dueNotifications(p, state({ draftDays: [FRIDAY], secondsToday: 1 }), log(), NOW)).toEqual([]);
    const due = dueNotifications(p, state({ draftDays: [FRIDAY, "2026-09-29"], secondsToday: 1 }), log(), NOW);
    expect(kinds(due)).toEqual([`unsubmitted@${FRIDAY}`]);
    expect(due[0]!.title).toBe("1 day not submitted");
  });

  test("off", () => {
    const p = prefs({ unsubmitted: { when: "off", weeklyOn: 5 } });
    expect(dueNotifications(p, state({ draftDays: ["2026-09-29"], secondsToday: 1 }), log(), NOW)).toEqual([]);
  });
});

describe("held and refused time", () => {
  const held = [
    { entryId: "a", workDate: "2026-09-22" },
    { entryId: "b", workDate: "2026-09-21" },
  ];

  test("goes when something new is held, any day of the week, inside the window", () => {
    const s = state({ held, secondsToday: 1, minutesNow: 9 * 60 });
    const due = dueNotifications(prefs(), s, log(), NOW);
    expect(kinds(due)).toEqual(["time_held@a,b"]);
    expect(due[0]!.title).toBe("QuickBooks already has time on 2 days you submitted");
    expect(due[0]!.body).toStartWith("Mon, Sep 21, Tue, Sep 22:");
    expect(due[0]!.url).toBe("/day/2026-09-21");
  });

  test("not again for the same entries, nor when some are settled; again when one is added", () => {
    const s = state({ held, secondsToday: 1, minutesNow: 9 * 60 });
    expect(dueNotifications(prefs(), s, log([{ kind: "time_held", key: "a,b" }]), NOW)).toEqual([]);
    expect(dueNotifications(prefs(), { ...s, held: held.slice(0, 1) }, log([{ kind: "time_held", key: "a,b" }]), NOW)).toEqual([]);
    const more = [...held, { entryId: "c", workDate: "2026-09-23" }];
    expect(kinds(dueNotifications(prefs(), { ...s, held: more }, log([{ kind: "time_held", key: "a,b" }]), NOW))).toEqual([
      "time_held@a,b,c",
    ]);
  });

  test("snoozed: again once the snooze runs out, if still held", () => {
    const s = state({ held, secondsToday: 1, minutesNow: 9 * 60 });
    const snoozed = { kind: "time_held" as const, key: "a,b", lastAt: NOW - 2 * 60 * MIN, snoozedUntil: NOW - MIN };
    expect(kinds(dueNotifications(prefs(), s, log([snoozed]), NOW))).toEqual(["time_held@a,b"]);
  });

  test("waits for quiet hours to end, and for a workday", () => {
    expect(dueNotifications(prefs(), state({ held, secondsToday: 1, minutesNow: 21 * 60 }), log(), NOW)).toEqual([]);
    expect(dueNotifications(prefs(), state({ held, today: "2026-10-03", minutesNow: 9 * 60 }), log(), NOW)).toEqual([]);
  });

  test("with no workdays set, quiet hours' window is every day", () => {
    const noWorkdays = prefs({ workdays: [], dayEmpty: { on: false, minHours: 0 } });
    const saturday = state({ held, today: "2026-10-03", minutesNow: 9 * 60 });
    expect(kinds(dueNotifications(noWorkdays, saturday, log(), NOW))).toEqual(["time_held@a,b"]);
    expect(dueNotifications(noWorkdays, { ...saturday, minutesNow: 21 * 60 }, log(), NOW)).toEqual([]);
  });

  test("refused", () => {
    const failed = [{ entryId: "x", workDate: "2026-09-30", error: "Item not found" }];
    const due = dueNotifications(prefs(), state({ failed, secondsToday: 1, minutesNow: 9 * 60 }), log(), NOW);
    expect(due[0]!.title).toBe("QuickBooks refused your time for Wed, Sep 30");
    expect(due[0]!.body).toContain("“Item not found”");
  });

  test("each can be switched off", () => {
    const s = state({ held, failed: [{ entryId: "x", workDate: "2026-09-30", error: "no" }], secondsToday: 1, minutesNow: 9 * 60 });
    expect(dueNotifications(prefs({ timeHeld: { on: false }, sendFailed: { on: false } }), s, log(), NOW)).toEqual([]);
  });
});

describe("admins", () => {
  const attention = { held: ["a"], blocked: ["b", "c"], failed: [] };

  test("immediately: when anything new needs an admin", () => {
    const s = state({ isAdmin: true, attention, secondsToday: 1, minutesNow: 9 * 60 });
    const due = dueNotifications(prefs(), s, log(), NOW);
    expect(kinds(due)).toEqual(["admin_attention@b:b,b:c,h:a"]);
    expect(due[0]!.title).toBe("3 entries need an admin");
    expect(due[0]!.body).toStartWith("1 held, 2 blocked.");
    expect(due[0]!.url).toBe("/admin/accounting");
  });

  test("daily: once, at the reminder time", () => {
    const p = prefs({ adminAttention: { on: true, when: "daily" } });
    expect(dueNotifications(p, state({ isAdmin: true, attention, secondsToday: 1, minutesNow: 9 * 60 }), log(), NOW)).toEqual([]);
    const due = dueNotifications(p, state({ isAdmin: true, attention, secondsToday: 1 }), log(), NOW);
    expect(kinds(due)).toEqual([`admin_attention@${FRIDAY}`]);
  });

  test("never for someone who isn't an admin", () => {
    expect(dueNotifications(prefs(), state({ attention, secondsToday: 1, minutesNow: 9 * 60 }), log(), NOW)).toEqual([]);
  });
});
