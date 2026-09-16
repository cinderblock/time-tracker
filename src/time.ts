/**
 * Wall-clock helpers.
 *
 * The whole app hinges on one distinction: an *instant* (epoch ms, UTC) versus
 * a *work date* (the human day a piece of work belongs to, in the deployment's
 * configured timezone). Evening work in America/Los_Angeles is already
 * tomorrow in UTC, so deriving a date with `toISOString().slice(0, 10)` books
 * it on the wrong day — and QuickBooks stores a bare date with no zone to
 * correct it later.
 */

/**
 * Read TZ directly rather than importing `config`: this module is a pure
 * utility, and pulling in the config would make importing a date formatter
 * fail whenever a required environment variable is absent — which is exactly
 * what happened the first time the tests ran. `config.timezone` resolves the
 * same variable, so the two never disagree.
 */
function defaultTimeZone(): string {
  // This module also runs in the browser, where there is no `process`; the
  // browser always passes the organisation's zone explicitly.
  return (typeof process !== "undefined" ? process.env.TZ : undefined) ?? "UTC";
}

/** 'YYYY-MM-DD' for an instant, in the configured timezone. */
export function workDateOf(instant: number, timeZone: string = defaultTimeZone()): string {
  // en-CA formats as YYYY-MM-DD, which is what we want and what sorts.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

/** Today's work date. */
export function today(timeZone?: string): string {
  return workDateOf(Date.now(), timeZone);
}

/**
 * Total seconds covered by a set of segments, treating an open segment (no
 * `endedAt`) as running until `now`. Segments are assumed non-overlapping —
 * the timer state machine guarantees at most one open segment per entry.
 */
export function durationSeconds(
  segments: readonly { startedAt: number; endedAt: number | null }[],
  now: number = Date.now(),
): number {
  let ms = 0;
  for (const s of segments) {
    const end = s.endedAt ?? now;
    // Clamp: a device whose clock jumped backwards mid-segment would otherwise
    // contribute negative time and silently shrink the day's total.
    if (end > s.startedAt) ms += end - s.startedAt;
  }
  return Math.round(ms / 1000);
}

/** "1:23:45" / "23:45" — monospace-friendly, for a live timer readout. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "1h 23m" — for totals in lists and summaries, where seconds are noise. */
export function formatDurationHuman(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.round((s % 3600) / 60);
  // Rounding minutes can reach 60; carry rather than print "1h 60m".
  if (minutes === 60) return `${hours + 1}h`;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/** Decimal hours, rounded to the nearest hundredth — the payroll convention. */
export function decimalHours(totalSeconds: number): number {
  return Math.round((totalSeconds / 3600) * 100) / 100;
}

// ---- zone-aware conversions ------------------------------------------------------
//
// The browser needs these because the organisation's timezone (whose calendar
// work dates live in) need not be the phone's: someone travelling still books
// time on the office's days.

const partsCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of an instant in a zone. */
export function zonedParts(instant: number, timeZone: string) {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(new Date(instant))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour! % 24,
    minute: out.minute!,
    second: out.second!,
  };
}

/** Milliseconds the zone is ahead of UTC at an instant. */
function zoneOffset(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant at which the zone's clock reads `date` `time` ("YYYY-MM-DD",
 * "HH:MM"). In the hour a DST change skips, the result lands just after the
 * gap; in the hour it repeats, the earlier of the two readings wins.
 */
export function zonedTimeToInstant(date: string, time: string, timeZone: string): number {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes settle the offset, including right next to a transition.
  const first = guess - zoneOffset(guess, timeZone);
  const second = guess - zoneOffset(first, timeZone);
  const earlier = Math.min(first, second);
  return zonedParts(earlier, timeZone).hour === h ? earlier : Math.max(first, second);
}

/** "HH:MM" (24-hour) for an instant in a zone — the value a time input wants. */
export function zonedTimeInput(instant: number, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** "9:05 AM" for an instant in a zone. */
export function formatClock(instant: number, timeZone: string): string {
  // Newer ICU builds put a narrow no-break space before "AM"; older ones a
  // plain space. Normalise, or the server's text and the browser's differ
  // and React reports a hydration mismatch.
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
    .format(new Date(instant))
    .replace(/\s/g, " ");
}

/** Calendar arithmetic on 'YYYY-MM-DD' strings (no zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** "Wed, Sep 16" for a work date. */
export function formatWorkDate(date: string, opts: { withYear?: boolean } = {}): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(opts.withYear ? { year: "numeric" } : {}),
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Day of week, 0 = Sunday, for a work date. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const WORK_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
