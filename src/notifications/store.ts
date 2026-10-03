import { createHmac, timingSafeEqual } from "node:crypto";

import { audit } from "../audit.ts";
import { config } from "../config.server.ts";
import { db } from "../db.server.ts";
import { describeUserAgent } from "../user-agent.ts";
import { UserInputError } from "../users.ts";
import type { Kind, LogEntry, SentLog } from "./rules.ts";

// ---- subscriptions ------------------------------------------------------------------

export interface Subscription {
  id: number;
  userId: number;
  sessionId: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  createdAt: number;
  lastSentAt: number | null;
  lastError: string | null;
  failures: number;
}

interface SubscriptionRow {
  id: number;
  user_id: number;
  session_id: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  created_at: number;
  last_sent_at: number | null;
  last_error: string | null;
  failures: number;
}

const SUB_COLUMNS = "id, user_id, session_id, endpoint, p256dh, auth, label, created_at, last_sent_at, last_error, failures";

const toSubscription = (r: SubscriptionRow): Subscription => ({
  id: r.id,
  userId: r.user_id,
  sessionId: r.session_id,
  endpoint: r.endpoint,
  p256dh: r.p256dh,
  auth: r.auth,
  label: r.label,
  createdAt: r.created_at,
  lastSentAt: r.last_sent_at,
  lastError: r.last_error,
  failures: r.failures,
});

/** The browser's PushSubscription.toJSON(), as posted by the account page. */
export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const BASE64URL = /^[A-Za-z0-9_-]+=*$/;

export function parseBrowserSubscription(value: unknown): BrowserSubscription {
  const v = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = typeof v?.endpoint === "string" ? v.endpoint : "";
  const p256dh = typeof v?.keys?.p256dh === "string" ? v.keys.p256dh : "";
  const auth = typeof v?.keys?.auth === "string" ? v.keys.auth : "";
  let url: URL | null = null;
  try {
    url = new URL(endpoint);
  } catch {
    url = null;
  }
  // Push services are always https. Anything else is not a browser's
  // subscription, and the server would be the one making the request.
  if (!url || url.protocol !== "https:" || endpoint.length > 1000) {
    throw new UserInputError("This browser's notification subscription didn't look right.");
  }
  if (!BASE64URL.test(p256dh) || !BASE64URL.test(auth) || p256dh.length > 200 || auth.length > 100) {
    throw new UserInputError("This browser's notification subscription didn't look right.");
  }
  return { endpoint, keys: { p256dh, auth } };
}

/**
 * Turn notifications on for one browser. Re-subscribing the same browser
 * (same endpoint) takes it over: it now belongs to whoever is signed in there.
 */
export function addSubscription(args: {
  userId: number;
  sessionId: string;
  subscription: BrowserSubscription;
  userAgent: string | null;
  now?: number;
}): Subscription {
  const now = args.now ?? Date.now();
  const { endpoint, keys } = args.subscription;
  const label = describeUserAgent(args.userAgent);
  const row = db()
    .query<SubscriptionRow, [number, string, string, string, string, string, number]>(
      `INSERT INTO push_subscriptions (user_id, session_id, endpoint, p256dh, auth, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id, session_id = excluded.session_id,
         p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label,
         failures = 0, last_error = NULL
       RETURNING ${SUB_COLUMNS}`,
    )
    .get(args.userId, args.sessionId, endpoint, keys.p256dh, keys.auth, label, now)!;
  audit({ actorUserId: args.userId, entity: "push_subscription", entityId: row.id, action: "add", after: { label }, at: now });
  return toSubscription(row);
}

/** Turn one device off: the person's own, by id or by this browser's endpoint. */
export function removeSubscription(args: { userId: number; id?: number; endpoint?: string }): boolean {
  const row =
    args.id != null
      ? db()
          .query<{ id: number; label: string }, [number, number]>(
            "SELECT id, label FROM push_subscriptions WHERE id = ? AND user_id = ?",
          )
          .get(args.id, args.userId)
      : db()
          .query<{ id: number; label: string }, [string, number]>(
            "SELECT id, label FROM push_subscriptions WHERE endpoint = ? AND user_id = ?",
          )
          .get(args.endpoint ?? "", args.userId);
  if (!row) return false;
  db().query("DELETE FROM push_subscriptions WHERE id = ?").run(row.id);
  audit({ actorUserId: args.userId, entity: "push_subscription", entityId: row.id, action: "remove", before: { label: row.label } });
  return true;
}

/**
 * Devices that should receive a person's notifications: the session they were
 * turned on from is still signed in.
 */
export function liveSubscriptions(userId: number, now: number = Date.now()): Subscription[] {
  return db()
    .query<SubscriptionRow, [number, number]>(
      `SELECT ${SUB_COLUMNS.split(", ")
        .map((c) => `p.${c}`)
        .join(", ")}
         FROM push_subscriptions p JOIN sessions s ON s.id = p.session_id
        WHERE p.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
        ORDER BY p.created_at`,
    )
    .all(userId, now)
    .map(toSubscription);
}

export function getSubscriptionByEndpoint(userId: number, endpoint: string): Subscription | null {
  const row = db()
    .query<SubscriptionRow, [number, string]>(`SELECT ${SUB_COLUMNS} FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`)
    .get(userId, endpoint);
  return row ? toSubscription(row) : null;
}

/** People with at least one device that can receive notifications. */
export function peopleWithDevices(now: number = Date.now()): { userId: number; isAdmin: boolean }[] {
  return db()
    .query<{ user_id: number; role: string }, [number]>(
      `SELECT DISTINCT p.user_id, u.role
         FROM push_subscriptions p
         JOIN sessions s ON s.id = p.session_id
         JOIN users u ON u.id = p.user_id
        WHERE u.active = 1 AND s.revoked_at IS NULL AND s.expires_at > ?
        ORDER BY p.user_id`,
    )
    .all(now)
    .map((r) => ({ userId: r.user_id, isAdmin: r.role === "admin" }));
}

/** After a send: a success clears the failure count; "gone" means the browser dropped it. */
export function recordDelivery(id: number, result: { ok: true } | { ok: false; gone: boolean; error: string }, now: number): void {
  if (result.ok) {
    db().query("UPDATE push_subscriptions SET last_sent_at = ?, failures = 0, last_error = NULL WHERE id = ?").run(now, id);
  } else if (result.gone) {
    db().query("DELETE FROM push_subscriptions WHERE id = ?").run(id);
  } else {
    db()
      .query("UPDATE push_subscriptions SET failures = failures + 1, last_error = ? WHERE id = ?")
      .run(result.error.slice(0, 300), id);
  }
}

// ---- what was sent ------------------------------------------------------------------

interface LogRow {
  id: number;
  kind: Kind;
  key: string;
  title: string;
  body: string;
  url: string;
  first_at: number;
  last_at: number;
  sent_count: number;
  delivered: number;
  snoozed_until: number | null;
}

const toEntry = (r: LogRow): LogEntry => ({
  kind: r.kind,
  key: r.key,
  lastAt: r.last_at,
  sentCount: r.sent_count,
  snoozedUntil: r.snoozed_until,
});

export function sentLog(userId: number): SentLog {
  return {
    get(kind, key) {
      const row = db()
        .query<LogRow, [number, string, string]>("SELECT * FROM notification_log WHERE user_id = ? AND kind = ? AND key = ?")
        .get(userId, kind, key);
      return row ? toEntry(row) : null;
    },
    latest(kind) {
      const row = db()
        .query<LogRow, [number, string]>(
          "SELECT * FROM notification_log WHERE user_id = ? AND kind = ? ORDER BY last_at DESC, id DESC LIMIT 1",
        )
        .get(userId, kind);
      return row ? toEntry(row) : null;
    },
  };
}

/** Record a send (before it goes, so its id can ride along); returns the row id. */
export function recordSend(args: {
  userId: number;
  kind: Kind;
  key: string;
  title: string;
  body: string;
  url: string;
  now: number;
}): number {
  return db()
    .query<{ id: number }, [number, string, string, string, string, string, number, number]>(
      `INSERT INTO notification_log (user_id, kind, key, title, body, url, first_at, last_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, kind, key) DO UPDATE SET
         title = excluded.title, body = excluded.body, url = excluded.url,
         last_at = excluded.last_at, sent_count = sent_count + 1, snoozed_until = NULL
       RETURNING id`,
    )
    .get(args.userId, args.kind, args.key, args.title, args.body, args.url, args.now, args.now)!.id;
}

export function recordDelivered(logId: number, devices: number): void {
  db().query("UPDATE notification_log SET delivered = ? WHERE id = ?").run(devices, logId);
}

export interface RecentNotification {
  id: number;
  kind: Kind;
  title: string;
  body: string;
  url: string;
  lastAt: number;
  sentCount: number;
  delivered: number;
  snoozedUntil: number | null;
}

export function recentNotifications(userId: number, limit = 10): RecentNotification[] {
  return db()
    .query<LogRow, [number, number]>("SELECT * FROM notification_log WHERE user_id = ? ORDER BY last_at DESC, id DESC LIMIT ?")
    .all(userId, limit)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      url: r.url,
      lastAt: r.last_at,
      sentCount: r.sent_count,
      delivered: r.delivered,
      snoozedUntil: r.snoozed_until,
    }));
}

export const SNOOZE_MS = 60 * 60_000;

export function snooze(args: { userId: number; logId: number; now: number }): boolean {
  return (
    db()
      .query("UPDATE notification_log SET snoozed_until = ? WHERE id = ? AND user_id = ?")
      .run(args.now + SNOOZE_MS, args.logId, args.userId).changes > 0
  );
}

// ---- days off -----------------------------------------------------------------------

export function isDayOff(userId: number, workDate: string): boolean {
  return (
    db()
      .query<{ n: number }, [number, string]>("SELECT 1 AS n FROM notification_days_off WHERE user_id = ? AND work_date = ?")
      .get(userId, workDate) != null
  );
}

export function setDayOff(args: { userId: number; workDate: string; off: boolean; actorUserId: number; now?: number }): void {
  const now = args.now ?? Date.now();
  const changed = args.off
    ? db()
        .query("INSERT OR IGNORE INTO notification_days_off (user_id, work_date, created_at) VALUES (?, ?, ?)")
        .run(args.userId, args.workDate, now).changes
    : db().query("DELETE FROM notification_days_off WHERE user_id = ? AND work_date = ?").run(args.userId, args.workDate)
        .changes;
  if (changed) {
    audit({
      actorUserId: args.actorUserId,
      entity: "user",
      entityId: args.userId,
      action: args.off ? "day_off" : "day_off_cleared",
      after: { workDate: args.workDate },
      at: now,
    });
  }
}

// ---- buttons on a notification ------------------------------------------------------

/**
 * A notification's buttons are pressed in the service worker, possibly long
 * after the page that could have held a CSRF token is gone. So each send
 * carries a token that names exactly one log row of one person, signed with
 * the session secret: it can snooze that notification or mark that person's
 * day off, nothing else.
 */
export function actionToken(userId: number, logId: number): string {
  return createHmac("sha256", config.sessionSecret).update(`notification:${userId}:${logId}`).digest("base64url").slice(0, 32);
}

export function verifyActionToken(token: string, logId: number): number | null {
  const row = db().query<{ user_id: number }, [number]>("SELECT user_id FROM notification_log WHERE id = ?").get(logId);
  if (!row) return null;
  const expected = Buffer.from(actionToken(row.user_id, logId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected) ? row.user_id : null;
}
