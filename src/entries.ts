import { audit } from "./audit.ts";
import { db } from "./db.server.ts";
import { type EntryStatus, isEditable, lockedReason } from "./entry-status.ts";
import { requireBookableJob } from "./jobs.ts";
import { MAX_ENTRY_SECONDS } from "./ops-schema.ts";
import { OpError } from "./op-error.ts";
import { requireNoteOnStop } from "./settings.ts";
import { workDateOf } from "./time.ts";

/**
 * Time entries and their segments — the timer state machine and edits.
 *
 * State (see entry-status.ts):
 *   open   a timer that hasn't been stopped. Running when it has an open
 *          segment, paused when it doesn't. At most one per person (a
 *          partial unique index enforces it).
 *   draft  stopped, or entered by hand; editable.
 *   approved and later states are locked; approvals.ts moves entries
 *   between draft and approved.
 *
 * Every function here runs inside the op transaction and throws OpError for
 * anything that doesn't make sense against the current state. Times named
 * `at` come from the device; `now` is the server clock, used for bookkeeping.
 */

export interface Segment {
  id: number;
  startedAt: number;
  endedAt: number | null;
}

export interface Entry {
  id: string;
  userId: number;
  jobId: string | null;
  workDate: string;
  durationSeconds: number;
  note: string | null;
  source: "timer" | "manual" | "note_rollup";
  status: EntryStatus;
  /** Frozen at approval; null before. */
  rateSnapshot: number | null;
  approvedAt: number | null;
  approvedBy: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  segments: Segment[];
}

interface EntryRow {
  id: string;
  user_id: number;
  job_id: string | null;
  work_date: string;
  duration_seconds: number;
  note: string | null;
  source: Entry["source"];
  status: Entry["status"];
  rate_snapshot: number | null;
  approved_at: number | null;
  approved_by: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

const COLUMNS =
  "id, user_id, job_id, work_date, duration_seconds, note, source, status, rate_snapshot, approved_at, approved_by, created_at, updated_at, deleted_at";

function segmentsOf(entryIds: string[]): Map<string, Segment[]> {
  const map = new Map<string, Segment[]>();
  if (entryIds.length === 0) return map;
  const rows = db()
    .query<{ id: number; entry_id: string; started_at: number; ended_at: number | null }, string[]>(
      `SELECT id, entry_id, started_at, ended_at FROM time_segments
        WHERE entry_id IN (${entryIds.map(() => "?").join(",")})
        ORDER BY started_at, id`,
    )
    .all(...entryIds);
  for (const r of rows) {
    const list = map.get(r.entry_id) ?? [];
    list.push({ id: r.id, startedAt: r.started_at, endedAt: r.ended_at });
    map.set(r.entry_id, list);
  }
  return map;
}

function hydrate(rows: EntryRow[]): Entry[] {
  const segments = segmentsOf(rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    jobId: r.job_id,
    workDate: r.work_date,
    durationSeconds: r.duration_seconds,
    note: r.note,
    source: r.source,
    status: r.status,
    rateSnapshot: r.rate_snapshot,
    approvedAt: r.approved_at,
    approvedBy: r.approved_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    segments: segments.get(r.id) ?? [],
  }));
}

export function getEntry(id: string): Entry | null {
  const row = db().query<EntryRow, [string]>(`SELECT ${COLUMNS} FROM time_entries WHERE id = ?`).get(id);
  return row ? hydrate([row])[0]! : null;
}

/** The person's open (running or paused) timer, if any. */
export function getOpenEntry(userId: number): Entry | null {
  const row = db()
    .query<EntryRow, [number]>(
      `SELECT ${COLUMNS} FROM time_entries WHERE user_id = ? AND status = 'open' AND deleted_at IS NULL`,
    )
    .get(userId);
  return row ? hydrate([row])[0]! : null;
}

/** A person's live entries for a work date, oldest first. */
export function listEntriesForDate(userId: number, workDate: string): Entry[] {
  const rows = db()
    .query<EntryRow, [number, string]>(
      `SELECT ${COLUMNS} FROM time_entries
        WHERE user_id = ? AND work_date = ? AND deleted_at IS NULL
        ORDER BY created_at, id`,
    )
    .all(userId, workDate);
  return hydrate(rows).sort((a, b) => entryStart(a) - entryStart(b));
}

/** Per-date totals (seconds) for a person over an inclusive date range. */
export function totalsByDate(userId: number, from: string, to: string): Map<string, number> {
  const rows = db()
    .query<{ work_date: string; seconds: number }, [number, string, string]>(
      `SELECT work_date, SUM(duration_seconds) AS seconds FROM time_entries
        WHERE user_id = ? AND work_date BETWEEN ? AND ? AND deleted_at IS NULL
        GROUP BY work_date`,
    )
    .all(userId, from, to);
  return new Map(rows.map((r) => [r.work_date, r.seconds]));
}

/** When an entry began, for sorting: its first segment, else when it was created. */
export function entryStart(e: Entry): number {
  return e.segments[0]?.startedAt ?? e.createdAt;
}

/** Owned, not deleted, or a not_found — never reveal that someone else's entry exists. */
function ownLiveEntry(userId: number, entryId: string): Entry {
  const entry = getEntry(entryId);
  if (!entry || entry.userId !== userId || entry.deletedAt != null) {
    throw new OpError("not_found", "That entry no longer exists.");
  }
  return entry;
}

function recomputeDuration(entryId: string, now: number): void {
  const segments = segmentsOf([entryId]).get(entryId) ?? [];
  if (segments.length === 0) {
    db().query("UPDATE time_entries SET updated_at = ? WHERE id = ?").run(now, entryId);
    return;
  }
  let ms = 0;
  for (const s of segments) if (s.endedAt != null && s.endedAt > s.startedAt) ms += s.endedAt - s.startedAt;
  db()
    .query("UPDATE time_entries SET duration_seconds = ?, updated_at = ? WHERE id = ?")
    .run(Math.round(ms / 1000), now, entryId);
}

function cleanNote(note: string | null | undefined): string | null | undefined {
  if (note === undefined) return undefined;
  const trimmed = note?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** Whether stopping a timer on this job needs a note. */
export function noteRequiredFor(jobId: string | null): boolean {
  if (requireNoteOnStop()) return true;
  if (!jobId) return false;
  return db().query<{ r: number }, [string]>("SELECT requires_note AS r FROM jobs WHERE id = ?").get(jobId)?.r === 1;
}

export interface LocationFix {
  lat: number;
  lon: number;
  accuracy?: number | null;
  at: number;
}

function recordLocation(args: {
  entryId?: string;
  segmentId?: number;
  noteId?: string;
  kind: "start" | "stop" | "periodic" | "note";
  fix: LocationFix | null | undefined;
}): void {
  if (!args.fix) return;
  db()
    .query(
      `INSERT INTO locations (entry_id, segment_id, note_id, at, lat, lon, accuracy_m, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.entryId ?? null,
      args.segmentId ?? null,
      args.noteId ?? null,
      args.fix.at,
      args.fix.lat,
      args.fix.lon,
      args.fix.accuracy ?? null,
      args.kind,
    );
}

// ---- timer ------------------------------------------------------------------------

/** Close the running segment (if any) at `at` and mark the entry stopped. */
function stopOpen(entry: Entry, at: number, note: string | null | undefined, now: number): void {
  const running = entry.segments.find((s) => s.endedAt == null);
  if (running && at < running.startedAt) {
    throw new OpError("conflict", "The stop time is before the timer started. Check the device's clock.");
  }
  const finalNote = note !== undefined ? note : entry.note;
  if (!finalNote && noteRequiredFor(entry.jobId)) {
    throw new OpError("note_required", "Add a note before stopping this timer.");
  }
  if (running) db().query("UPDATE time_segments SET ended_at = ? WHERE id = ?").run(at, running.id);
  db()
    .query("UPDATE time_entries SET status = 'draft', note = ?, updated_at = ? WHERE id = ?")
    .run(finalNote ?? null, now, entry.id);
  recomputeDuration(entry.id, now);
}

export function startTimer(args: {
  userId: number;
  entryId: string;
  jobId: string;
  at: number;
  note?: string | null;
  location?: LocationFix | null;
  deviceId: string;
  clientTime: number;
  now: number;
}): Entry {
  const jobId = requireBookableJob(args.jobId).id;
  if (getEntry(args.entryId)) throw new OpError("conflict", "That entry already exists.");

  // Starting while another timer is open is a switch: the old one stops at
  // the same instant, so there is neither a gap nor an overlap.
  const open = getOpenEntry(args.userId);
  if (open) stopOpen(open, args.at, undefined, args.now);

  db()
    .query(
      `INSERT INTO time_entries
         (id, user_id, job_id, work_date, duration_seconds, note, source, status,
          device_id, client_created_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, 'timer', 'open', ?, ?, ?, ?)`,
    )
    .run(
      args.entryId,
      args.userId,
      jobId,
      workDateOf(args.at),
      cleanNote(args.note) ?? null,
      args.deviceId,
      args.clientTime,
      args.now,
      args.now,
    );
  const segment = db()
    .query<{ id: number }, [string, number]>(
      "INSERT INTO time_segments (entry_id, started_at) VALUES (?, ?) RETURNING id",
    )
    .get(args.entryId, args.at)!;
  recordLocation({ entryId: args.entryId, segmentId: segment.id, kind: "start", fix: args.location });
  return getEntry(args.entryId)!;
}

function ownOpenEntry(userId: number, entryId: string): Entry {
  const entry = ownLiveEntry(userId, entryId);
  if (entry.status !== "open") throw new OpError("conflict", "That timer has already been stopped.");
  return entry;
}

export function pauseTimer(args: { userId: number; entryId: string; at: number; now: number }): Entry {
  const entry = ownOpenEntry(args.userId, args.entryId);
  const running = entry.segments.find((s) => s.endedAt == null);
  if (!running) throw new OpError("conflict", "That timer is already paused.");
  if (args.at < running.startedAt) {
    throw new OpError("conflict", "The pause time is before the timer started. Check the device's clock.");
  }
  db().query("UPDATE time_segments SET ended_at = ? WHERE id = ?").run(args.at, running.id);
  recomputeDuration(entry.id, args.now);
  return getEntry(entry.id)!;
}

export function resumeTimer(args: { userId: number; entryId: string; at: number; now: number }): Entry {
  const entry = ownOpenEntry(args.userId, args.entryId);
  if (entry.segments.some((s) => s.endedAt == null)) throw new OpError("conflict", "That timer is already running.");
  const lastEnd = Math.max(...entry.segments.map((s) => s.endedAt ?? 0));
  if (args.at < lastEnd) {
    throw new OpError("conflict", "The resume time is before the pause. Check the device's clock.");
  }
  db().query("INSERT INTO time_segments (entry_id, started_at) VALUES (?, ?)").run(entry.id, args.at);
  recomputeDuration(entry.id, args.now);
  return getEntry(entry.id)!;
}

export function stopTimer(args: {
  userId: number;
  entryId: string;
  at: number;
  note?: string | null;
  location?: LocationFix | null;
  now: number;
}): Entry {
  const entry = ownOpenEntry(args.userId, args.entryId);
  const running = entry.segments.find((s) => s.endedAt == null);
  stopOpen(entry, args.at, cleanNote(args.note), args.now);
  recordLocation({ entryId: entry.id, segmentId: running?.id, kind: "stop", fix: args.location });
  return getEntry(entry.id)!;
}

// ---- manual entries and edits -----------------------------------------------------

function checkSpan(startedAt: number, endedAt: number): void {
  if (endedAt <= startedAt) throw new OpError("invalid", "The end time must be after the start time.");
  if (endedAt - startedAt > MAX_ENTRY_SECONDS * 1000) {
    throw new OpError("invalid", "A single entry can't be longer than 24 hours.");
  }
}

export function createManualEntry(args: {
  userId: number;
  entryId: string;
  jobId: string;
  note?: string | null;
  startedAt?: number;
  endedAt?: number;
  workDate?: string;
  durationSeconds?: number;
  source?: "manual" | "note_rollup";
  deviceId: string;
  clientTime: number;
  now: number;
}): Entry {
  const jobId = requireBookableJob(args.jobId).id;
  if (getEntry(args.entryId)) throw new OpError("conflict", "That entry already exists.");

  const spanned = args.startedAt != null && args.endedAt != null;
  if (spanned) checkSpan(args.startedAt!, args.endedAt!);
  const workDate = spanned ? workDateOf(args.startedAt!) : args.workDate!;
  const seconds = spanned ? Math.round((args.endedAt! - args.startedAt!) / 1000) : args.durationSeconds!;

  db()
    .query(
      `INSERT INTO time_entries
         (id, user_id, job_id, work_date, duration_seconds, note, source, status,
          device_id, client_created_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    )
    .run(
      args.entryId,
      args.userId,
      jobId,
      workDate,
      seconds,
      cleanNote(args.note) ?? null,
      args.source ?? "manual",
      args.deviceId,
      args.clientTime,
      args.now,
      args.now,
    );
  if (spanned) {
    db()
      .query("INSERT INTO time_segments (entry_id, started_at, ended_at) VALUES (?, ?, ?)")
      .run(args.entryId, args.startedAt!, args.endedAt!);
  }
  return getEntry(args.entryId)!;
}

function snapshot(e: Entry) {
  return {
    jobId: e.jobId,
    workDate: e.workDate,
    durationSeconds: e.durationSeconds,
    note: e.note,
    start: e.segments[0]?.startedAt ?? null,
    end: e.segments.at(-1)?.endedAt ?? null,
  };
}

/**
 * Edit an entry. Start and end times move the first segment's start and the
 * last segment's end; a date and duration only apply to entries that have no
 * times (typed-in durations). Passing `note: null` clears the note.
 */
export function updateEntry(args: {
  userId: number;
  actorUserId: number;
  entryId: string;
  jobId?: string;
  note?: string | null;
  startedAt?: number;
  endedAt?: number;
  workDate?: string;
  durationSeconds?: number;
  now: number;
}): Entry {
  const entry = ownLiveEntry(args.userId, args.entryId);
  if (!isEditable(entry.status)) throw new OpError("conflict", lockedReason(entry.status));
  const before = snapshot(entry);
  const hasTimes = entry.segments.length > 0;

  const jobId =
    args.jobId === undefined || args.jobId === entry.jobId ? args.jobId : requireBookableJob(args.jobId).id;

  if ((args.workDate !== undefined || args.durationSeconds !== undefined) && hasTimes) {
    throw new OpError("invalid", "This entry has start and end times; change those instead.");
  }
  if ((args.startedAt !== undefined || args.endedAt !== undefined) && !hasTimes) {
    throw new OpError("invalid", "This entry is a plain duration; change the duration instead.");
  }
  if (args.endedAt !== undefined && entry.status === "open") {
    throw new OpError("conflict", "Stop the timer before changing its end time.");
  }

  if (hasTimes) {
    const first = entry.segments[0]!;
    const last = entry.segments.at(-1)!;
    const newStart = args.startedAt ?? first.startedAt;
    const newEnd = args.endedAt ?? last.endedAt;
    if (entry.segments.length === 1) {
      if (newEnd != null) checkSpan(newStart, newEnd);
      else if (newStart > args.now + 5 * 60_000) {
        throw new OpError("invalid", "A running timer can't start in the future.");
      }
    } else {
      if (first.endedAt != null && newStart >= first.endedAt) {
        throw new OpError("invalid", "The start must be before the first pause.");
      }
      if (newEnd != null && newEnd <= last.startedAt) {
        throw new OpError("invalid", "The end must be after the last resume.");
      }
    }
    if (args.startedAt !== undefined) {
      db().query("UPDATE time_segments SET started_at = ? WHERE id = ?").run(newStart, first.id);
      // A timer's work date follows its start.
      db().query("UPDATE time_entries SET work_date = ? WHERE id = ?").run(workDateOf(newStart), entry.id);
    }
    if (args.endedAt !== undefined) {
      db().query("UPDATE time_segments SET ended_at = ? WHERE id = ?").run(newEnd, last.id);
    }
  } else {
    if (args.workDate !== undefined) {
      db().query("UPDATE time_entries SET work_date = ? WHERE id = ?").run(args.workDate, entry.id);
    }
    if (args.durationSeconds !== undefined) {
      db().query("UPDATE time_entries SET duration_seconds = ? WHERE id = ?").run(args.durationSeconds, entry.id);
    }
  }

  if (jobId !== undefined) {
    db().query("UPDATE time_entries SET job_id = ? WHERE id = ?").run(jobId, entry.id);
  }
  const note = cleanNote(args.note);
  if (note !== undefined) {
    db().query("UPDATE time_entries SET note = ? WHERE id = ?").run(note, entry.id);
  }
  recomputeDuration(entry.id, args.now);

  const after = getEntry(entry.id)!;
  audit({
    actorUserId: args.actorUserId,
    entity: "entry",
    entityId: entry.id,
    action: "update",
    before,
    after: snapshot(after),
    at: args.now,
  });
  return after;
}

// ---- delete and undo --------------------------------------------------------------

/**
 * Soft-delete. No confirmation is asked for — the app offers an undo instead.
 * A running timer's segment is left open, so an immediate undo carries on as
 * if nothing happened.
 */
export function deleteEntry(args: { userId: number; actorUserId: number; entryId: string; at: number; now: number }): void {
  const entry = ownLiveEntry(args.userId, args.entryId);
  if (!isEditable(entry.status)) throw new OpError("conflict", lockedReason(entry.status));
  db().query("UPDATE time_entries SET deleted_at = ?, updated_at = ? WHERE id = ?").run(args.at, args.now, entry.id);
  audit({
    actorUserId: args.actorUserId,
    entity: "entry",
    entityId: entry.id,
    action: "delete",
    before: snapshot(entry),
    at: args.now,
  });
}

/**
 * Undo a delete. A timer that was running when deleted resumes as if never
 * deleted — unless another timer has been started since, in which case it
 * comes back stopped at the moment it was deleted (two can't run at once).
 */
export function restoreEntry(args: { userId: number; actorUserId: number; entryId: string; now: number }): Entry {
  const entry = getEntry(args.entryId);
  if (!entry || entry.userId !== args.userId) throw new OpError("not_found", "That entry no longer exists.");
  if (entry.deletedAt == null) return entry; // already restored: nothing to do

  if (entry.status === "open" && getOpenEntry(args.userId)) {
    const running = entry.segments.find((s) => s.endedAt == null);
    if (running) {
      db()
        .query("UPDATE time_segments SET ended_at = ? WHERE id = ?")
        .run(Math.max(entry.deletedAt, running.startedAt), running.id);
    }
    db().query("UPDATE time_entries SET status = 'draft' WHERE id = ?").run(entry.id);
  }
  db().query("UPDATE time_entries SET deleted_at = NULL WHERE id = ?").run(entry.id);
  recomputeDuration(entry.id, args.now);
  audit({ actorUserId: args.actorUserId, entity: "entry", entityId: entry.id, action: "restore", at: args.now });
  return getEntry(entry.id)!;
}
