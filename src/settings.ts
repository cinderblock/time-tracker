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

/** For modules that own a setting of their own (branding.ts). Empty means unset. */
export const readSetting = (key: string): string => read(key) ?? "";
export const writeSetting = write;

/** Whether stopping any timer requires a note. Default off. */
export function requireNoteOnStop(): boolean {
  return read("require_note_on_stop") === "1";
}

export function setRequireNoteOnStop(value: boolean, actorUserId: number | null): void {
  write("require_note_on_stop", value ? "1" : "0", actorUserId);
}

// ---- accounting ---------------------------------------------------------------------

/** remote_items.id of the service item used when a job has none. */
export function defaultServiceItemId(): string | null {
  return read("default_service_item_id") || null;
}

export function setDefaultServiceItemId(id: string | null, actorUserId: number | null): void {
  write("default_service_item_id", id ?? "", actorUserId);
}

/** remote_items.id of the wage item used for Employees with none of their own or their category's. */
export function defaultPayrollItemId(): string | null {
  return read("default_payroll_item_id") || null;
}

export function setDefaultPayrollItemId(id: string | null, actorUserId: number | null): void {
  write("default_payroll_item_id", id ?? "", actorUserId);
}

/**
 * Bookkeeping for the sync (not audited: these change on every contact).
 * Times are epoch ms; absent means never.
 */
export interface SyncState {
  lastPullAt: number | null;
  lastPullAttemptAt: number | null;
  pullRequestedAt: number | null;
  lastContactAt: number | null;
  lastContactOk: boolean;
  lastContactDetail: string;
}

const SYNC_STATE_KEY = "sync_state";

export function syncState(): SyncState {
  const stored = JSON.parse(read(SYNC_STATE_KEY) ?? "{}") as Partial<SyncState>;
  return {
    lastPullAt: stored.lastPullAt ?? null,
    lastPullAttemptAt: stored.lastPullAttemptAt ?? null,
    pullRequestedAt: stored.pullRequestedAt ?? null,
    lastContactAt: stored.lastContactAt ?? null,
    lastContactOk: stored.lastContactOk ?? false,
    lastContactDetail: stored.lastContactDetail ?? "",
  };
}

export function updateSyncState(changes: Partial<SyncState>): void {
  const next = JSON.stringify({ ...syncState(), ...changes });
  db()
    .query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(SYNC_STATE_KEY, next);
}

/**
 * Stable ids the Web Connector knows this app by. Generated once: a new pair
 * would make the Web Connector treat a re-downloaded .qwc file as a
 * different application.
 */
export function webConnectorIds(): { ownerId: string; fileId: string } {
  const existing = read("qbwc_ids");
  if (existing) return JSON.parse(existing);
  const ids = { ownerId: `{${crypto.randomUUID()}}`, fileId: `{${crypto.randomUUID()}}` };
  write("qbwc_ids", JSON.stringify(ids), null);
  return ids;
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
