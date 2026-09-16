import { audit } from "./audit.ts";
import { db } from "./db.server.ts";

/**
 * Organisation-wide settings, stored as strings in the `settings` table.
 * Each setting has one typed accessor here, with its default next to it.
 */

function read(key: string): string | null {
  return db().query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
}

function write(key: string, value: string, actorUserId: number | null): void {
  const before = read(key);
  if (before === value) return;
  db()
    .query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
  audit({ actorUserId, entity: "setting", entityId: key, action: "set", before, after: value });
}

/** Whether stopping any timer requires a note. Default off. */
export function requireNoteOnStop(): boolean {
  return read("require_note_on_stop") === "1";
}

export function setRequireNoteOnStop(value: boolean, actorUserId: number | null): void {
  write("require_note_on_stop", value ? "1" : "0", actorUserId);
}

/**
 * The weekday weeks start on, 0 = Sunday … 6 = Saturday. Default Sunday.
 * Payroll weeks differ between organisations; every week shown — the day
 * screen's strip, timesheets, the calendar — starts here.
 */
export function weekStartsOn(): number {
  const value = Number(read("week_starts_on"));
  return Number.isInteger(value) && value >= 0 && value <= 6 ? value : 0;
}

export function setWeekStartsOn(day: number, actorUserId: number | null): void {
  if (!Number.isInteger(day) || day < 0 || day > 6) throw new RangeError("week_starts_on must be 0-6");
  write("week_starts_on", String(day), actorUserId);
}
