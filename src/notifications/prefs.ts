import { audit } from "../audit.ts";
import { db } from "../db.server.ts";
import { UserInputError } from "../users.ts";
import { DEFAULT_PREFS, type NotificationPrefs, parsePrefs, prefsSchema } from "./prefs-schema.ts";

export { DEFAULT_PREFS, type NotificationPrefs, parsePrefs, prefsSchema };
export { REPEAT_MAX_TIMES, REPEAT_MINUTES } from "./prefs-schema.ts";

/**
 * Storage for each person's notification choices: one row per person in
 * `notification_prefs`; no row means the defaults. Which devices receive
 * them is separate — that is per device (`push_subscriptions`).
 */

export function getPrefs(userId: number): NotificationPrefs {
  const row = db()
    .query<{ prefs: string }, [number]>("SELECT prefs FROM notification_prefs WHERE user_id = ?")
    .get(userId);
  if (!row) return DEFAULT_PREFS;
  try {
    return parsePrefs(JSON.parse(row.prefs));
  } catch {
    return DEFAULT_PREFS;
  }
}

/**
 * Save a person's choices. Strict where the stored read is lenient: a value
 * that doesn't fit is refused, not quietly replaced by its default, so the
 * person sees what they set.
 */
export function setPrefs(args: { userId: number; prefs: unknown; actorUserId: number; now?: number }): NotificationPrefs {
  const strict = prefsSchema.safeParse(args.prefs);
  if (!strict.success || !sameShape(args.prefs, strict.data)) {
    throw new UserInputError("Those notification settings didn't make sense. Reload and try again.");
  }
  const next = strict.data;
  if (next.workdays.length === 0 && next.dayEmpty.on) {
    throw new UserInputError("Pick at least one workday, or turn the day reminders off.");
  }
  if (next.quietHours.on && next.quietHours.from >= next.quietHours.until) {
    throw new UserInputError("Quiet hours: the start of the window has to be before its end.");
  }
  const before = getPrefs(args.userId);
  if (JSON.stringify(before) === JSON.stringify(next)) return before;
  const now = args.now ?? Date.now();
  db()
    .query(
      `INSERT INTO notification_prefs (user_id, prefs, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`,
    )
    .run(args.userId, JSON.stringify(next), now);
  audit({
    actorUserId: args.actorUserId,
    entity: "user",
    entityId: args.userId,
    action: "notification_prefs",
    before,
    after: next,
  });
  return next;
}

/**
 * Whether parsing kept every value it was given. `.catch` makes the schema
 * forgiving for stored data; for a save, a caught value means the input was
 * wrong, so compare what came in with what came out.
 */
function sameShape(input: unknown, parsed: unknown): boolean {
  if (Array.isArray(parsed)) {
    // workdays are normalised (sorted, de-duplicated); compare as sets.
    return (
      Array.isArray(input) &&
      input.every((v) => (parsed as unknown[]).includes(v)) &&
      parsed.every((v) => input.includes(v))
    );
  }
  if (parsed !== null && typeof parsed === "object") {
    if (input === null || typeof input !== "object") return false;
    return Object.entries(parsed).every(([k, v]) => sameShape((input as Record<string, unknown>)[k], v));
  }
  return Object.is(input, parsed);
}
