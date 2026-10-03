import { beforeEach, describe, expect, test } from "bun:test";

import { db } from "../db.server.ts";
import { applyOp } from "../ops.ts";
import type { OpPayload, OpResult, OpType } from "../ops-schema.ts";
import { createSession, revokeSession } from "../sessions.ts";
import { freshDb } from "../testing/db.ts";
import { createUser } from "../users.ts";
import { uuidv7 } from "../uuid.ts";
import { DEFAULT_PREFS, setPrefs } from "./prefs.ts";
import { fakeSender } from "./send.ts";
import {
  actionToken,
  addSubscription,
  deviceLabel,
  isDayOff,
  liveSubscriptions,
  parseBrowserSubscription,
  recentNotifications,
  removeSubscription,
  setDayOff,
  snooze,
  verifyActionToken,
} from "./store.ts";
import { runNotifications, sendTest } from "./worker.ts";

const MIN = 60_000;
const TZ = "America/Los_Angeles";
// Friday 2026-10-02, 17:00 and 09:00 in Los Angeles.
const FIVE_PM = Date.parse("2026-10-03T00:00:00Z");
const NINE_AM = Date.parse("2026-10-02T16:00:00Z");
const ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36";

let admin = 0;
let alice = 0;
let aliceSession = "";
let job = "";

function browser(n: number) {
  return { endpoint: `https://push.example/send/${n}`, keys: { p256dh: `BKey${n}`, auth: `auth${n}` } };
}

function send<T extends OpType>(as: number, type: T, payload: OpPayload<T>, now: number): OpResult {
  const result = applyOp(as, { opId: uuidv7(), type, deviceId: "t", clientTime: now, payload }, now);
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result;
}

beforeEach(() => {
  freshDb();
  admin = createUser({ name: "Ada", role: "admin", actorUserId: null }).id;
  alice = createUser({ name: "Alice", role: "employee", actorUserId: admin }).id;
  aliceSession = createSession({ userId: alice, credentialId: null, userAgent: ANDROID, now: NINE_AM - 60 * MIN }).session.id;
  const customer = uuidv7();
  job = uuidv7();
  send(admin, "job.create", { jobId: customer, name: "Acme" }, NINE_AM - 60 * MIN);
  send(admin, "job.create", { jobId: job, name: "Widget", parentId: customer }, NINE_AM - 60 * MIN);
});

const subscribeAlice = (n = 1, sessionId = aliceSession) =>
  addSubscription({ userId: alice, sessionId, subscription: browser(n), userAgent: ANDROID, now: NINE_AM - 30 * MIN });

describe("subscriptions", () => {
  test("a browser's subscription is checked before it is kept", () => {
    expect(parseBrowserSubscription(browser(1))).toEqual(browser(1));
    expect(() => parseBrowserSubscription({ ...browser(1), endpoint: "http://push.example/x" })).toThrow();
    expect(() => parseBrowserSubscription({ ...browser(1), endpoint: "not a url" })).toThrow();
    expect(() => parseBrowserSubscription({ endpoint: browser(1).endpoint, keys: { p256dh: "a b", auth: "x" } })).toThrow();
  });

  test("devices are labelled from the user agent", () => {
    expect(deviceLabel(ANDROID)).toBe("Chrome on Android");
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toBe(
      "Safari on iPhone",
    );
    expect(deviceLabel(null)).toBe("A browser");
  });

  test("signing the device out stops its notifications", async () => {
    subscribeAlice();
    expect(liveSubscriptions(alice, NINE_AM)).toHaveLength(1);
    revokeSession({ id: aliceSession, userId: alice, actorUserId: alice, now: NINE_AM });
    expect(liveSubscriptions(alice, NINE_AM)).toHaveLength(0);
    const { sender, sent } = fakeSender();
    expect(await runNotifications({ sender, now: FIVE_PM, timeZone: TZ })).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test("subscribing the same browser again replaces it; removing takes it away", () => {
    subscribeAlice();
    const again = subscribeAlice();
    expect(liveSubscriptions(alice, NINE_AM).map((s) => s.id)).toEqual([again.id]);
    expect(removeSubscription({ userId: admin, id: again.id })).toBe(false);
    expect(removeSubscription({ userId: alice, endpoint: browser(1).endpoint })).toBe(true);
    expect(liveSubscriptions(alice, NINE_AM)).toHaveLength(0);
  });

  test("the keys stay out of the audit log", () => {
    subscribeAlice();
    const logged = db().query<{ j: string | null }, []>("SELECT after_json AS j FROM audit_log WHERE entity = 'push_subscription'").all();
    expect(logged.map((r) => r.j)).toEqual([JSON.stringify({ label: "Chrome on Android" })]);
  });
});

describe("a pass", () => {
  test("nobody with a device: nothing is worked out or sent", async () => {
    const { sender, sent } = fakeSender();
    expect(await runNotifications({ sender, now: FIVE_PM, timeZone: TZ })).toBe(0);
    expect(sent).toEqual([]);
  });

  test("an empty Friday at 17:00: one reminder to every device, once", async () => {
    subscribeAlice(1);
    const other = createSession({ userId: alice, credentialId: null, userAgent: null, now: NINE_AM }).session.id;
    subscribeAlice(2, other);
    const { sender, sent } = fakeSender();

    expect(await runNotifications({ sender, now: FIVE_PM - MIN, timeZone: TZ })).toBe(0);
    expect(await runNotifications({ sender, now: FIVE_PM, timeZone: TZ })).toBe(1);
    expect(sent.map((s) => s.target.endpoint)).toEqual([browser(1).endpoint, browser(2).endpoint]);
    expect(sent[0]!.payload).toMatchObject({
      title: "No time entered today",
      url: "/",
      tag: "tt-day_empty",
      actions: [
        { action: "snooze", title: "Remind me in an hour" },
        { action: "day-off", title: "Day off today" },
      ],
    });
    expect(sent[0]!.options).toEqual({ ttl: 6 * 3600, topic: "tt-day-empty", urgency: "normal" });

    expect(await runNotifications({ sender, now: FIVE_PM + 10 * MIN, timeZone: TZ })).toBe(0);
    expect(recentNotifications(alice)).toMatchObject([{ kind: "day_empty", sentCount: 1, delivered: 2 }]);
  });

  test("time entered: no empty-day reminder; on a Friday, the weekly one about submitting", async () => {
    subscribeAlice();
    send(alice, "entry.create", { entryId: uuidv7(), jobId: job, startedAt: NINE_AM, endedAt: NINE_AM + 60 * MIN, note: null }, NINE_AM);
    const { sender, sent } = fakeSender();
    await runNotifications({ sender, now: FIVE_PM, timeZone: TZ });
    expect(sent.map((s) => s.payload.title)).toEqual(["1 day not submitted"]);
    expect(sent[0]!.payload.url).toBe("/");
  });

  test("a timer still running at 17:00", async () => {
    subscribeAlice();
    send(alice, "timer.start", { entryId: uuidv7(), jobId: job, at: NINE_AM }, NINE_AM);
    const { sender, sent } = fakeSender();
    await runNotifications({ sender, now: FIVE_PM, timeZone: TZ });
    expect(sent.map((s) => s.payload.title)).toEqual(["A timer is still running"]);
    expect(sent[0]!.payload.body).toBe("It has run 8h on Widget. Stop it if you're done for the day.");
  });

  test("today's notes not turned into hours", async () => {
    subscribeAlice();
    send(alice, "note.create", { noteId: uuidv7(), at: NINE_AM, kind: "start", jobId: job }, NINE_AM);
    send(alice, "note.create", { noteId: uuidv7(), at: NINE_AM + MIN, text: "Fixed the gate", jobId: job }, NINE_AM);
    const { sender, sent } = fakeSender();
    await runNotifications({ sender, now: FIVE_PM, timeZone: TZ });
    expect(sent.map((s) => s.payload.title)).toEqual(["Today's notes aren't hours yet"]);
  });

  test("time QuickBooks refused, at 09:00", async () => {
    subscribeAlice();
    const entryId = uuidv7();
    send(alice, "entry.create", { entryId, jobId: job, workDate: "2026-09-30", durationSeconds: 3600, note: null }, NINE_AM);
    db().query("UPDATE time_entries SET status = 'sync_failed', sync_error = 'Item not found' WHERE id = ?").run(entryId);
    const { sender, sent } = fakeSender();
    await runNotifications({ sender, now: NINE_AM, timeZone: TZ });
    expect(sent.map((s) => s.payload.title)).toEqual(["QuickBooks refused your time for Wed, Sep 30"]);
    expect(sent[0]!.payload.url).toBe("/day/2026-09-30");
  });

  test("a device the push service says is gone is forgotten; other failures are counted", async () => {
    subscribeAlice(1);
    subscribeAlice(2, createSession({ userId: alice, credentialId: null, userAgent: null, now: NINE_AM }).session.id);
    const { sender } = fakeSender((t) =>
      t.endpoint.endsWith("/1") ? { ok: false, gone: true, error: "410 Gone" } : { ok: false, gone: false, error: "500 Oops" },
    );
    await runNotifications({ sender, now: FIVE_PM, timeZone: TZ });
    const left = liveSubscriptions(alice, FIVE_PM);
    expect(left.map((s) => [s.endpoint, s.failures, s.lastError])).toEqual([[browser(2).endpoint, 1, "500 Oops"]]);
    expect(recentNotifications(alice)[0]!.delivered).toBe(0);
  });

  test("their own choices apply", async () => {
    subscribeAlice();
    setPrefs({ userId: alice, prefs: { ...DEFAULT_PREFS, dayEmpty: { on: false, minHours: 0 } }, actorUserId: alice });
    const { sender, sent } = fakeSender();
    await runNotifications({ sender, now: FIVE_PM, timeZone: TZ });
    expect(sent).toEqual([]);
  });
});

describe("buttons on a notification", () => {
  test("the token names one notification of one person", async () => {
    subscribeAlice();
    const { sender, sent } = fakeSender();
    await runNotifications({ sender, now: FIVE_PM, timeZone: TZ });
    const { id, token } = sent[0]!.payload as { id: number; token: string };
    expect(token).toBe(actionToken(alice, id));
    expect(verifyActionToken(token, id)).toBe(alice);
    expect(verifyActionToken(token, id + 1)).toBeNull();
    expect(verifyActionToken(`${token.slice(0, -1)}x`, id)).toBeNull();
    expect(verifyActionToken("short", id)).toBeNull();
  });

  test("snooze: again an hour later, even with repeats off", async () => {
    subscribeAlice();
    const { sender, sent } = fakeSender();
    await runNotifications({ sender, now: FIVE_PM, timeZone: TZ });
    expect(snooze({ userId: alice, logId: sent[0]!.payload.id as number, now: FIVE_PM + MIN })).toBe(true);
    await runNotifications({ sender, now: FIVE_PM + 60 * MIN, timeZone: TZ });
    expect(sent).toHaveLength(1);
    await runNotifications({ sender, now: FIVE_PM + 61 * MIN, timeZone: TZ });
    expect(sent).toHaveLength(2);
    await runNotifications({ sender, now: FIVE_PM + 3 * 60 * MIN, timeZone: TZ });
    expect(sent).toHaveLength(2);
  });

  test("day off: no day reminders today", async () => {
    subscribeAlice();
    setDayOff({ userId: alice, workDate: "2026-10-02", off: true, actorUserId: alice });
    expect(isDayOff(alice, "2026-10-02")).toBe(true);
    const { sender, sent } = fakeSender();
    await runNotifications({ sender, now: FIVE_PM, timeZone: TZ });
    expect(sent).toEqual([]);
  });
});

describe("a test notification", () => {
  test("goes to the one device asked for, now, whatever the time", async () => {
    subscribeAlice(1);
    subscribeAlice(2, createSession({ userId: alice, credentialId: null, userAgent: null, now: NINE_AM }).session.id);
    const { sender, sent } = fakeSender();
    const result = await sendTest({ userId: alice, sender, endpoint: browser(2).endpoint, now: NINE_AM });
    expect(result).toMatchObject({ devices: 1, delivered: 1, errors: [] });
    expect(sent.map((s) => s.target.endpoint)).toEqual([browser(2).endpoint]);
    expect(sent[0]!.payload).toMatchObject({ title: "Notifications are working", url: "/account#notifications" });
    expect(sent[0]!.options.urgency).toBe("high");
  });

  test("to a device that's signed out: nothing sent, nothing recorded", async () => {
    subscribeAlice(1);
    revokeSession({ id: aliceSession, userId: alice, actorUserId: alice, now: NINE_AM });
    const { sender, sent } = fakeSender();
    const result = await sendTest({ userId: alice, sender, endpoint: browser(1).endpoint, now: NINE_AM });
    expect(result).toMatchObject({ devices: 0, delivered: 0 });
    expect(sent).toEqual([]);
    expect(recentNotifications(alice)).toEqual([]);
  });
});
