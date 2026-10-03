import { formatDurationHuman, formatWorkDate, weekdayOf } from "../time.ts";
import type { NotificationPrefs } from "./prefs.ts";

/**
 * What is due to be sent to one person, right now. Pure: everything it needs
 * comes in as arguments, so every timing rule is tested with a fixed clock
 * (rules.test.ts) and the worker only gathers state and sends.
 *
 * Two families:
 *
 *   reminders  at a time of day, on workdays, about the day: nothing entered,
 *              notes not turned into hours, a timer left going, days not
 *              submitted. Keyed by date, so each goes once a day — or again
 *              every N minutes while it still applies, if the person asked.
 *   alerts     when something happens: time held, refused, a timer running
 *              very long, (admins) anything needing an admin. Keyed by what
 *              they're about, so they go when there's something new, and wait
 *              for quiet hours to end.
 */

export const KINDS = [
  "day_empty",
  "notes_pending",
  "timer_running",
  "unsubmitted",
  "time_held",
  "send_failed",
  "admin_attention",
  "test",
] as const;
export type Kind = (typeof KINDS)[number];

export interface PersonState {
  isAdmin: boolean;
  /** Today's work date, in the organisation's zone. */
  today: string;
  /** Minutes since midnight, in the organisation's zone. */
  minutesNow: number;
  /** The person said today is a day off. */
  dayOff: boolean;
  /** Stopped time on today (seconds), not counting a timer that's open. */
  secondsToday: number;
  /** The person's open timer, if any. */
  timer: { entryId: string; job: string | null; seconds: number; running: boolean } | null;
  /** Notes on today not yet turned into hours. */
  notesToday: number;
  /** The latest earlier day with notes not yet turned into hours. */
  notesEarlier: { date: string; count: number } | null;
  /** Days with time not yet submitted, up to and including today, newest first. */
  draftDays: string[];
  /** Entries held because QuickBooks already has time like them. */
  held: { entryId: string; workDate: string }[];
  /** Entries QuickBooks refused. */
  failed: { entryId: string; workDate: string; error: string }[];
  /** Admins: entries anyone has waiting on an admin. */
  attention: { held: string[]; blocked: string[]; failed: string[] } | null;
}

export interface LogEntry {
  kind: Kind;
  key: string;
  lastAt: number;
  sentCount: number;
  snoozedUntil: number | null;
}

/** What the rules may ask about what has already been sent. */
export interface SentLog {
  get(kind: Kind, key: string): LogEntry | null;
  /** The most recent send of a kind, whatever it was about. */
  latest(kind: Kind): LogEntry | null;
}

export interface NotificationAction {
  action: "snooze" | "day-off";
  title: string;
}

export interface Due {
  kind: Kind;
  key: string;
  title: string;
  body: string;
  url: string;
  actions: NotificationAction[];
}

const SNOOZE: NotificationAction = { action: "snooze", title: "Remind me in an hour" };
const DAY_OFF: NotificationAction = { action: "day-off", title: "Day off today" };

export function minutesOf(clock: string): number {
  const [h, m] = clock.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

export function dayUrl(date: string, today: string): string {
  return date === today ? "/" : `/day/${date}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function listDates(dates: readonly string[]): string {
  const sorted = [...new Set(dates)].sort();
  const shown = sorted.slice(0, 4).map((d) => formatWorkDate(d));
  return sorted.length > 4 ? `${shown.join(", ")} and ${sorted.length - 4} more` : shown.join(", ");
}

export function dueNotifications(prefs: NotificationPrefs, state: PersonState, log: SentLog, now: number): Due[] {
  if (prefs.pausedThrough && state.today <= prefs.pausedThrough) return [];

  const due: Due[] = [];
  const workday = prefs.workdays.includes(weekdayOf(state.today));
  const dayReminders = workday && !state.dayOff;
  const atReminder = state.minutesNow >= minutesOf(prefs.reminderAt);
  const alertsMayGo =
    !prefs.quietHours.on ||
    (workday &&
      state.minutesNow >= minutesOf(prefs.quietHours.from) &&
      state.minutesNow < minutesOf(prefs.quietHours.until));

  /** A reminder about today: once at its time, then per the repeat setting, or after a snooze. */
  const reminder = (kind: Kind, key: string, timeReached: boolean): boolean => {
    if (!timeReached) return false;
    const sent = log.get(kind, key);
    if (!sent) return true;
    if (sent.snoozedUntil != null) return now >= sent.snoozedUntil && sent.lastAt < sent.snoozedUntil;
    const every = prefs.repeat.everyMinutes;
    return every > 0 && sent.sentCount < prefs.repeat.maxTimes && now - sent.lastAt >= every * 60_000;
  };

  /**
   * An alert about a set of things: due when the set holds something the last
   * alert of this kind didn't, or again once a snooze runs out while some of
   * what it was about is still there. The key is the set itself.
   */
  const alert = (kind: Kind, ids: readonly string[]): string | null => {
    if (ids.length === 0 || !alertsMayGo) return null;
    const key = [...ids].sort().join(",");
    const last = log.latest(kind);
    if (!last) return key;
    const before = new Set(last.key.split(","));
    if (ids.some((id) => !before.has(id))) return key;
    if (last.snoozedUntil != null && now >= last.snoozedUntil && last.lastAt < last.snoozedUntil) return last.key;
    return null;
  };

  const today = state.today;
  const todayName = formatWorkDate(today);
  const timerSeconds = state.timer?.seconds ?? 0;

  // ---- reminders --------------------------------------------------------------------

  if (dayReminders && prefs.dayEmpty.on && !state.timer && state.notesToday === 0) {
    const min = prefs.dayEmpty.minHours * 3600;
    const total = state.secondsToday;
    const short = min === 0 ? total === 0 : total < min;
    if (short && reminder("day_empty", today, atReminder)) {
      due.push({
        kind: "day_empty",
        key: today,
        title: total === 0 ? "No time entered today" : `Only ${formatDurationHuman(total)} entered today`,
        body:
          total === 0
            ? `Nothing is recorded for ${todayName} yet. Add your hours while you remember them.`
            : `${todayName} has ${formatDurationHuman(total)} — less than the ${formatDurationHuman(min)} you asked to be reminded about.`,
        url: "/",
        actions: [SNOOZE, DAY_OFF],
      });
    }
  }

  if (dayReminders && prefs.notesPending.on && state.notesToday > 0 && reminder("notes_pending", today, atReminder)) {
    due.push({
      kind: "notes_pending",
      key: today,
      title: "Today's notes aren't hours yet",
      body: `${plural(state.notesToday, "note")} on ${todayName} still need turning into hours.`,
      url: "/",
      actions: [SNOOZE, DAY_OFF],
    });
  }

  if (dayReminders && prefs.notesPending.on && prefs.notesPending.morning && state.notesEarlier) {
    const key = `morning:${today}`;
    if (reminder("notes_pending", key, state.minutesNow >= minutesOf(prefs.notesPending.morningAt))) {
      const day = formatWorkDate(state.notesEarlier.date);
      due.push({
        kind: "notes_pending",
        key,
        title: `${day}'s notes still need turning into hours`,
        body: `${plural(state.notesEarlier.count, "note")} waiting. Today's notes wait until that day is done.`,
        url: dayUrl(state.notesEarlier.date, today),
        actions: [SNOOZE],
      });
    }
  }

  if (dayReminders && prefs.timerRunning.atReminder && state.timer && reminder("timer_running", today, atReminder)) {
    const job = state.timer.job ? ` on ${state.timer.job}` : "";
    due.push({
      kind: "timer_running",
      key: today,
      title: state.timer.running ? "A timer is still running" : "A timer is paused, not stopped",
      body: state.timer.running
        ? `It has run ${formatDurationHuman(timerSeconds)}${job}. Stop it if you're done for the day.`
        : `${formatDurationHuman(timerSeconds)}${job} is waiting. Stop it so the time can be submitted.`,
      url: "/",
      actions: [SNOOZE, DAY_OFF],
    });
  }

  if (prefs.unsubmitted.when === "daily" && dayReminders) {
    const earlier = state.draftDays.filter((d) => d < today);
    if (earlier.length > 0 && reminder("unsubmitted", today, atReminder)) {
      due.push(unsubmittedDue(today, today, earlier));
    }
  }
  if (prefs.unsubmitted.when === "weekly" && !state.dayOff && weekdayOf(today) === prefs.unsubmitted.weeklyOn) {
    const key = `week:${today}`;
    if (state.draftDays.length > 0 && reminder("unsubmitted", key, atReminder)) {
      due.push(unsubmittedDue(key, today, state.draftDays));
    }
  }

  if (state.isAdmin && prefs.adminAttention.on && prefs.adminAttention.when === "daily" && dayReminders && state.attention) {
    const a = state.attention;
    if (a.held.length + a.blocked.length + a.failed.length > 0 && reminder("admin_attention", today, atReminder)) {
      due.push(attentionDue(today, a));
    }
  }

  // ---- alerts -----------------------------------------------------------------------

  if (prefs.timerRunning.long && state.timer?.running && timerSeconds >= prefs.timerRunning.longHours * 3600) {
    const key = `long:${state.timer.entryId}`;
    const sent = log.get("timer_running", key);
    const snoozeOver = sent?.snoozedUntil != null && now >= sent.snoozedUntil && sent.lastAt < sent.snoozedUntil;
    if (alertsMayGo && (!sent || snoozeOver)) {
      const job = state.timer.job ? ` on ${state.timer.job}` : "";
      due.push({
        kind: "timer_running",
        key,
        title: `A timer has run ${formatDurationHuman(timerSeconds)}`,
        body: `Still going${job}. If you forgot to stop it, stop it and fix the end time.`,
        url: "/",
        actions: [SNOOZE],
      });
    }
  }

  if (prefs.timeHeld.on) {
    const key = alert(
      "time_held",
      state.held.map((h) => h.entryId),
    );
    if (key) {
      const days = [...new Set(state.held.map((h) => h.workDate))].sort();
      due.push({
        kind: "time_held",
        key,
        title: `QuickBooks already has time on ${plural(days.length, "day")} you submitted`,
        body: `${listDates(days)}: compare the two and choose what to keep. Nothing is sent until you do.`,
        url: dayUrl(days[0]!, today),
        actions: [SNOOZE],
      });
    }
  }

  if (prefs.sendFailed.on) {
    const key = alert(
      "send_failed",
      state.failed.map((f) => f.entryId),
    );
    if (key) {
      const days = [...new Set(state.failed.map((f) => f.workDate))].sort();
      const first = state.failed.find((f) => f.workDate === days[0])!;
      due.push({
        kind: "send_failed",
        key,
        title: `QuickBooks refused your time for ${listDates(days)}`,
        body: `It said: “${first.error}”. It's retried automatically; an admin can see why on the Accounting page.`,
        url: dayUrl(days[0]!, today),
        actions: [SNOOZE],
      });
    }
  }

  if (state.isAdmin && prefs.adminAttention.on && prefs.adminAttention.when === "immediately" && state.attention) {
    const a = state.attention;
    const ids = [...a.held.map((id) => `h:${id}`), ...a.blocked.map((id) => `b:${id}`), ...a.failed.map((id) => `f:${id}`)];
    const key = alert("admin_attention", ids);
    if (key) due.push(attentionDue(key, a));
  }

  return due;
}

function unsubmittedDue(key: string, today: string, days: readonly string[]): Due {
  const sorted = [...days].sort();
  return {
    kind: "unsubmitted",
    key,
    title: `${plural(sorted.length, "day")} not submitted`,
    body: `${listDates(sorted)} ${sorted.length === 1 ? "has" : "have"} time that hasn't been submitted, so it can't reach QuickBooks yet.`,
    url: dayUrl(sorted[0]!, today),
    actions: [SNOOZE],
  };
}

function attentionDue(key: string, a: { held: string[]; blocked: string[]; failed: string[] }): Due {
  const total = a.held.length + a.blocked.length + a.failed.length;
  const parts = [
    a.held.length ? `${a.held.length} held` : null,
    a.blocked.length ? `${a.blocked.length} blocked` : null,
    a.failed.length ? `${a.failed.length} refused` : null,
  ].filter(Boolean);
  return {
    kind: "admin_attention",
    key,
    title: `${plural(total, "entry", "entries")} need an admin`,
    body: `${parts.join(", ")}. The Accounting page says what each needs.`,
    url: "/admin/accounting",
    actions: [SNOOZE],
  };
}
