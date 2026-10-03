import { config } from "../src/config.server.ts";
import { db } from "../src/db.server.ts";
import { type NotificationPrefs, getPrefs, setPrefs } from "../src/notifications/prefs.ts";
import { pushConfigured } from "../src/notifications/send.ts";
import {
  type RecentNotification,
  addSubscription,
  isDayOff,
  parseBrowserSubscription,
  recentNotifications,
  removeSubscription,
  setDayOff,
} from "../src/notifications/store.ts";
import { appSender, sendTest } from "../src/notifications/worker.ts";
import { weekStartsOn } from "../src/settings.ts";
import { today } from "../src/time.ts";
import { UserInputError } from "../src/users.ts";
import type { ActionResult } from "./actions.server.ts";
import { intField, stringField } from "./actions.server.ts";

/** One of the person's devices, as the account page lists it. */
export interface DeviceView {
  id: number;
  label: string;
  /** To recognise this browser's own row. */
  endpoint: string;
  createdAt: number;
  lastSentAt: number | null;
  lastError: string | null;
  failures: number;
  /** Signed in still. A signed-out device gets nothing until it's turned on again. */
  live: boolean;
}

export interface NotificationsView {
  /** The server can send: VAPID keys are set. */
  available: boolean;
  vapidPublicKey: string | null;
  prefs: NotificationPrefs;
  devices: DeviceView[];
  today: string;
  dayOffToday: boolean;
  timeZone: string;
  weekStartsOn: number;
  recent: RecentNotification[];
}

export function notificationsView(userId: number, now: number = Date.now()): NotificationsView {
  const devices = db()
    .query<
      {
        id: number;
        label: string;
        endpoint: string;
        created_at: number;
        last_sent_at: number | null;
        last_error: string | null;
        failures: number;
        live: number;
      },
      [number, number]
    >(
      `SELECT p.id, p.label, p.endpoint, p.created_at, p.last_sent_at, p.last_error, p.failures,
              (s.id IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at > ?) AS live
         FROM push_subscriptions p LEFT JOIN sessions s ON s.id = p.session_id
        WHERE p.user_id = ?
        ORDER BY p.created_at`,
    )
    .all(now, userId)
    .map((r) => ({
      id: r.id,
      label: r.label,
      endpoint: r.endpoint,
      createdAt: r.created_at,
      lastSentAt: r.last_sent_at,
      lastError: r.last_error,
      failures: r.failures,
      live: r.live === 1,
    }));
  const todayDate = today(config.timezone);
  return {
    available: pushConfigured(),
    vapidPublicKey: config.push.vapidPublicKey,
    prefs: getPrefs(userId),
    devices,
    today: todayDate,
    dayOffToday: isDayOff(userId, todayDate),
    timeZone: config.timezone,
    weekStartsOn: weekStartsOn(),
    recent: recentNotifications(userId, 8),
  };
}

function jsonField(form: FormData, name: string): unknown {
  try {
    return JSON.parse(stringField(form, name));
  } catch {
    throw new UserInputError("That request was incomplete.");
  }
}

/** The account page's notification intents, for handleForm. */
export function notificationHandlers(args: {
  userId: number;
  sessionId: string;
  userAgent: string | null;
}): Record<string, (form: FormData) => ActionResult | Promise<ActionResult>> {
  const { userId } = args;
  return {
    "push-subscribe": (form) => {
      if (!pushConfigured()) throw new UserInputError("This server isn't set up to send notifications.");
      const subscription = parseBrowserSubscription(jsonField(form, "subscription"));
      const added = addSubscription({ userId, sessionId: args.sessionId, subscription, userAgent: args.userAgent });
      return { ok: true, message: `Notifications are on for ${added.label}.` };
    },
    "push-remove": (form) => {
      const removed = removeSubscription({ userId, id: intField(form, "deviceId") });
      return removed ? { ok: true, message: "That device won't get notifications any more." } : { ok: true, message: "" };
    },
    "push-forget": (form) => {
      // This browser already unsubscribed itself; drop the row quietly.
      removeSubscription({ userId, endpoint: stringField(form, "endpoint") });
      return { ok: true, message: "Notifications are off for this device." };
    },
    "push-test": async (form) => {
      if (!pushConfigured()) throw new UserInputError("This server isn't set up to send notifications.");
      const deviceId = intField(form, "deviceId");
      const endpoint = db()
        .query<{ endpoint: string }, [number, number]>("SELECT endpoint FROM push_subscriptions WHERE id = ? AND user_id = ?")
        .get(deviceId, userId)?.endpoint;
      if (!endpoint) throw new UserInputError("That device isn't set up for notifications any more.");
      const result = await sendTest({ userId, sender: appSender(), endpoint });
      if (result.devices === 0) {
        throw new UserInputError("That device is signed out. Turn notifications on again from it.");
      }
      if (result.delivered === 0) {
        throw new UserInputError(`The push service didn't take it: ${result.errors.join("; ")}`);
      }
      return { ok: true, message: "Sent. It should appear in a few seconds." };
    },
    "notification-prefs": (form) => {
      setPrefs({ userId, prefs: jsonField(form, "prefs"), actorUserId: userId });
      return { ok: true, message: "Notification settings saved." };
    },
    "day-off": (form) => {
      const off = stringField(form, "off") === "1";
      setDayOff({ userId, workDate: today(config.timezone), off, actorUserId: userId });
      return { ok: true, message: off ? "No day reminders today." : "Today's reminders are back on." };
    },
  };
}
