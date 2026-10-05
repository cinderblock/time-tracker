import { config } from "../config.server.ts";
import { getPrefs } from "./prefs.ts";
import { type Due, dueNotifications } from "./rules.ts";
import { type PushSender, pushConfigured, webPushSender } from "./send.ts";
import { adminAttention, personState } from "./state.ts";
import {
  actionToken,
  liveSubscriptions,
  peopleWithDevices,
  recordDelivered,
  recordDelivery,
  recordSend,
  sentLog,
} from "./store.ts";

/**
 * The loop that sends reminders and alerts: once a minute, for everyone with
 * a device turned on, work out what's due (rules.ts) and send it.
 */

/** How long a push service may hold a message for a device that's off. */
const TTL_SECONDS: Record<Due["kind"], number> = {
  day_empty: 6 * 3600,
  notes_pending: 6 * 3600,
  timer_running: 6 * 3600,
  unsubmitted: 12 * 3600,
  time_held: 24 * 3600,
  send_failed: 24 * 3600,
  admin_attention: 24 * 3600,
  problems: 24 * 3600,
  test: 300,
};

export interface DeliverySummary {
  logId: number;
  devices: number;
  delivered: number;
  errors: string[];
}

/** Record one notification and send it to the person's devices (or one of them). */
export async function deliver(args: {
  userId: number;
  due: Due;
  sender: PushSender;
  now: number;
  /** Only this browser — for "send a test to this device". */
  endpoint?: string;
}): Promise<DeliverySummary> {
  const { userId, due, sender, now } = args;
  const targets = liveSubscriptions(userId, now).filter((s) => !args.endpoint || s.endpoint === args.endpoint);
  // Nowhere to send it: don't record it as sent, so it goes once there is.
  if (targets.length === 0) return { logId: 0, devices: 0, delivered: 0, errors: [] };
  const logId = recordSend({ userId, kind: due.kind, key: due.key, title: due.title, body: due.body, url: due.url, now });
  const payload = JSON.stringify({
    title: due.title,
    body: due.body,
    url: due.url,
    // One notification per kind on screen: a repeat replaces the last.
    tag: `tt-${due.kind}`,
    actions: due.actions,
    id: logId,
    token: actionToken(userId, logId),
  });
  let delivered = 0;
  const errors: string[] = [];
  for (const target of targets) {
    const result = await sender.send(target, payload, {
      ttl: TTL_SECONDS[due.kind],
      topic: `tt-${due.kind}`.replaceAll("_", "-"),
      urgency: due.kind === "test" ? "high" : "normal",
    });
    recordDelivery(target.id, result, now);
    if (result.ok) delivered++;
    else errors.push(`${target.label}: ${result.error}`);
  }
  recordDelivered(logId, delivered);
  return { logId, devices: targets.length, delivered, errors };
}

export async function sendTest(args: { userId: number; sender: PushSender; endpoint?: string; now?: number }) {
  const now = args.now ?? Date.now();
  return deliver({
    userId: args.userId,
    sender: args.sender,
    now,
    endpoint: args.endpoint,
    due: {
      kind: "test",
      key: `test:${now}`,
      title: "Notifications are working",
      body: "This device will get the reminders and alerts you've chosen.",
      url: "/account#notifications",
      actions: [],
    },
  });
}

/** One pass over everyone. Returns how many notifications went out. */
export async function runNotifications(args: { sender: PushSender; now?: number; timeZone?: string }): Promise<number> {
  const now = args.now ?? Date.now();
  const timeZone = args.timeZone ?? config.timezone;
  let attention: ReturnType<typeof adminAttention> | null = null;
  const sharedAttention = () => (attention ??= adminAttention(now));
  let sent = 0;
  for (const person of peopleWithDevices(now)) {
    const state = personState({ userId: person.userId, isAdmin: person.isAdmin, now, timeZone, attention: sharedAttention });
    const due = dueNotifications(getPrefs(person.userId), state, sentLog(person.userId), now);
    for (const d of due) {
      await deliver({ userId: person.userId, due: d, sender: args.sender, now });
      sent++;
    }
  }
  return sent;
}

let senderOverride: PushSender | null = null;

/** The sender the app uses: the real one, unless a test put a fake in. */
export function appSender(): PushSender {
  return senderOverride ?? webPushSender();
}

export function setSenderForTests(sender: PushSender | null): void {
  senderOverride = sender;
}

const TIMER_KEY = "__timeTrackerNotifyTimer__";
type GlobalWithTimer = typeof globalThis & { [TIMER_KEY]?: ReturnType<typeof setInterval> };

/** Start the loop, once per process, when push is configured. */
export function startNotificationWorker(): void {
  const g = globalThis as GlobalWithTimer;
  if (g[TIMER_KEY]) return;
  if (!pushConfigured()) return;
  const every = config.push.checkEverySeconds * 1000;
  if (every === 0) {
    console.log("[notify] reminders are off (NOTIFY_EVERY_SECONDS=0); test notifications still send");
    return;
  }
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    runNotifications({ sender: appSender() })
      .then((n) => {
        if (n) console.log(`[notify] sent ${n} notification${n === 1 ? "" : "s"}`);
      })
      .catch((err) => console.error("[notify] pass failed:", err))
      .finally(() => {
        running = false;
      });
  };
  g[TIMER_KEY] = setInterval(tick, every);
  g[TIMER_KEY].unref?.();
  setTimeout(tick, 10_000).unref?.();
  console.log(`[notify] checking for reminders every ${every / 1000}s`);
}
