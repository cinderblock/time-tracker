/**
 * Display formatting done on the server, in the deployment's timezone.
 *
 * Loaders return finished strings rather than timestamps for the client to
 * format: the server and the browser can disagree about the timezone, and a
 * date that renders differently on each side is a hydration mismatch.
 */

function zone(): string {
  return process.env.TZ ?? "UTC";
}

/** "Sep 16, 2026, 2:05 PM" */
export function formatDateTime(ms: number, timeZone: string = zone()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** "Sep 16, 2026" */
export function formatDate(ms: number, timeZone: string = zone()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(ms));
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600_000],
  ["month", 30 * 24 * 3600_000],
  ["week", 7 * 24 * 3600_000],
  ["day", 24 * 3600_000],
  ["hour", 3600_000],
  ["minute", 60_000],
];

/** "3 days ago", "in 2 hours", "just now", "in under a minute" */
export function formatRelative(ms: number, now: number = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff > 0 ? "in under a minute" : "just now";
  for (const [unit, size] of UNITS) {
    if (abs >= size) return relative.format(Math.round(diff / size), unit);
  }
  return "just now";
}
