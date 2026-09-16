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
  return process.env.TZ ?? "UTC";
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
