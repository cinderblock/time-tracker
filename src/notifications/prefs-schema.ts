import { z } from "zod";

import { isWorkDate } from "../time.ts";

/**
 * Each person's notification choices, as a schema. Pure (no database), so the
 * account page's form can share its limits; storage is in prefs.ts.
 *
 * Stored as JSON and parsed through this schema, so a stored value from an
 * older version still reads: anything missing takes its default, anything
 * unknown is dropped.
 */

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const clock = (fallback: string) => z.string().regex(CLOCK, "A time like 17:00").catch(fallback);
const weekday = z.number().int().min(0).max(6);

/** A group of settings: missing or not an object reads as all defaults. */
const section = <T extends z.ZodRawShape>(shape: T) =>
  z.preprocess((v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : {}), z.object(shape));

export const REPEAT_MINUTES = [0, 15, 30, 60, 120] as const;
export const REPEAT_MAX_TIMES = 10;

export const prefsSchema = z.object({
  /** Days the day reminders are for, 0 = Sunday. */
  workdays: z
    .array(weekday)
    .max(7)
    .transform((days) => [...new Set(days)].sort((a, b) => a - b))
    .catch([1, 2, 3, 4, 5]),
  /** When the end-of-day reminders go, in the organisation's time zone. */
  reminderAt: clock("17:00"),
  /**
   * Send a reminder again while it still applies. `everyMinutes` 0 is once.
   * `maxTimes` counts the first send.
   */
  repeat: section({
      everyMinutes: z
        .number()
        .refine((n): n is (typeof REPEAT_MINUTES)[number] => (REPEAT_MINUTES as readonly number[]).includes(n))
        .catch(0),
      maxTimes: z.number().int().min(1).max(REPEAT_MAX_TIMES).catch(3),
    }),
  /**
   * Alerts that come from something happening (held, refused, a long timer)
   * wait for this window on a workday, rather than buzzing at 2 a.m.
   */
  quietHours: section({
      on: z.boolean().catch(true),
      /** Alerts may go from … */
      from: clock("07:00"),
      /** … until. */
      until: clock("20:00"),
    }),
  /** Nothing at all is sent through this date (inclusive). */
  pausedThrough: z
    .string()
    .refine((v) => isWorkDate(v))
    .nullable()
    .catch(null),

  dayEmpty: section({
      on: z.boolean().catch(true),
      /** Remind when the day has less than this. 0: only when it has nothing. */
      minHours: z.number().min(0).max(24).catch(0),
    }),
  notesPending: section({
      on: z.boolean().catch(true),
      /** Also, in the morning, about an earlier day still waiting. */
      morning: z.boolean().catch(true),
      morningAt: clock("08:30"),
    }),
  timerRunning: section({
      /** At the reminder time, if a timer is still going. */
      atReminder: z.boolean().catch(true),
      /** Whenever one has run this long. */
      long: z.boolean().catch(true),
      longHours: z.number().min(1).max(24).catch(10),
    }),
  unsubmitted: section({
      /** daily: earlier days, at the reminder time. weekly: the week so far, on one day. */
      when: z.enum(["off", "daily", "weekly"]).catch("weekly"),
      weeklyOn: weekday.catch(5),
    }),
  timeHeld: section({ on: z.boolean().catch(true) }),
  sendFailed: section({ on: z.boolean().catch(true) }),
  /** Admins only: anyone's time that is held, blocked or refused. */
  adminAttention: section({
      on: z.boolean().catch(true),
      when: z.enum(["immediately", "daily"]).catch("immediately"),
    }),
  /** Admins only: a new bug report, or a new kind of error in someone's browser. */
  problems: section({ on: z.boolean().catch(true) }),
});

export type NotificationPrefs = z.infer<typeof prefsSchema>;

export const DEFAULT_PREFS: NotificationPrefs = prefsSchema.parse({});

/** Read anything — stored JSON, a form's JSON — as prefs, defaults filling the gaps. */
export function parsePrefs(value: unknown): NotificationPrefs {
  const result = prefsSchema.safeParse(value ?? {});
  return result.success ? result.data : DEFAULT_PREFS;
}
