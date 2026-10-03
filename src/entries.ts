import { audit } from "./audit.ts";
import { db } from "./db.server.ts";
import { reopenEntries } from "./approvals.ts";
import { type EntryStatus, REOPENABLE_STATUSES, isEditable, lockedReason } from "./entry-status.ts";
import { requireBookableJob, resolveJob } from "./jobs.ts";
import { MAX_ENTRY_SECONDS, NOTE_MAX_LENGTH } from "./limits.ts";
import { OpError } from "./op-error.ts";
import { joinDescriptions } from "./rollup.ts";
import { requireNoteOnStop } from "./settings.ts";
import { formatWorkDate, workDateOf } from "./time.ts";

/**
 * Time entries and their segments — the timer state machine and edits.
 *
 * State (see entry-status.ts):
 *   open   a timer that hasn't been stopped. Running when it has an open
 *          segment, paused when it doesn't. At most one per person (a
 *          partial unique index enforces it).
 *   draft  stopped, or entered by hand; editable.
 *   submitted and later states are locked; approvals.ts moves entries out of
 *   draft and back again.
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
  /** All of it: the segments' time plus `untimedSeconds`. */
  durationSeconds: number;
  /**
   * Time with no start and end — typed in as a duration, or notes turned into
   * hours. A line can hold some of each (one line per job per day).
   */
  untimedSeconds: number;
  note: string | null;
  source: "timer" | "manual" | "note_rollup";
  status: EntryStatus;
  /** Frozen when the time is submitted; null before. */
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
  untimed_seconds: number;
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
  "id, user_id, job_id, work_date, duration_seconds, untimed_seconds, note, source, status, rate_snapshot, approved_at, approved_by, created_at, updated_at, deleted_at";

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
    untimedSeconds: r.untimed_seconds,
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

/**
 * Earlier dates where this person has stopped time they haven't submitted,
 * most recent first. The day screen uses it to say what's still waiting on
 * them — nothing submits itself, so the only thing that makes a submit step
 * work is being reminded it's there.
 */
export function unsubmittedDatesBefore(userId: number, before: string, limit = 14): string[] {
  return db()
    .query<{ work_date: string }, [number, string, number]>(
      `SELECT DISTINCT work_date FROM time_entries
        WHERE user_id = ? AND work_date < ? AND status = 'draft' AND deleted_at IS NULL
        ORDER BY work_date DESC LIMIT ?`,
    )
    .all(userId, before, limit)
    .map((r) => r.work_date);
}

/** When an entry began, for sorting: its first segment, else when it was created. */
export function entryStart(e: Entry): number {
  return e.segments[0]?.startedAt ?? e.createdAt;
}

/**
 * The entry an id names: itself, or — when its time was added to a line that
 * was already there — that line (see `entry_aliases`).
 */
export function resolveEntryId(entryId: string): string {
  return (
    db().query<{ entry_id: string }, [string]>("SELECT entry_id FROM entry_aliases WHERE alias_id = ?").get(entryId)
      ?.entry_id ?? entryId
  );
}

/** Owned, not deleted, or a not_found — never reveal that someone else's entry exists. */
function ownLiveEntry(userId: number, entryId: string): Entry {
  const entry = getEntry(resolveEntryId(entryId));
  if (!entry || entry.userId !== userId || entry.deletedAt != null) {
    throw new OpError("not_found", "That entry no longer exists.");
  }
  return entry;
}

/** Closed segments' time, in seconds. */
function timedSeconds(segments: readonly Segment[]): number {
  let ms = 0;
  for (const s of segments) if (s.endedAt != null && s.endedAt > s.startedAt) ms += s.endedAt - s.startedAt;
  return Math.round(ms / 1000);
}

/** duration = closed segments + untimed time. */
function recomputeDuration(entryId: string, now: number): void {
  const segments = segmentsOf([entryId]).get(entryId) ?? [];
  db()
    .query("UPDATE time_entries SET duration_seconds = ? + untimed_seconds, updated_at = ? WHERE id = ?")
    .run(timedSeconds(segments), now, entryId);
}

function cleanNote(note: string | null | undefined): string | null | undefined {
  if (note === undefined) return undefined;
  const trimmed = note?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** Whether stopping a timer on this job needs a note: the global rule, the job's own, or its customer's. */
export function noteRequiredFor(jobId: string | null): boolean {
  if (requireNoteOnStop()) return true;
  if (!jobId) return false;
  return resolveJob(jobId)?.noteRequired ?? false;
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

// ---- one line per job per day -----------------------------------------------------
//
// A person has at most one line of hours for a job on a day. Time added to a
// job that already has hours that day — a timer started, a duration typed in,
// notes turned into hours — joins that line. The op still names the id its
// device made; that id becomes an alias of the line (`entry_aliases`), so
// whatever the device sends about it next lands on the line.

/**
 * The person's line for a job on a day: their live entry there, if any. While
 * old duplicates last (from before one line per job), the earliest.
 */
export function lineFor(userId: number, jobId: string, workDate: string, exceptId?: string): Entry | null {
  const row = db()
    .query<EntryRow, [number, string, string, string]>(
      `SELECT ${COLUMNS} FROM time_entries
        WHERE user_id = ? AND job_id = ? AND work_date = ? AND deleted_at IS NULL AND id != ?
        ORDER BY created_at, id LIMIT 1`,
    )
    .get(userId, jobId, workDate, exceptId ?? "");
  return row ? hydrate([row])[0]! : null;
}

/** Say that an id an op named now stands for a line (its time joined that line). */
export function recordEntryAlias(aliasId: string, entryId: string, now: number): void {
  recordAlias(aliasId, entryId, now);
}

function recordAlias(aliasId: string, entryId: string, now: number): void {
  if (aliasId === entryId) return;
  db().query("INSERT OR IGNORE INTO entry_aliases (alias_id, entry_id, created_at) VALUES (?, ?, ?)").run(aliasId, entryId, now);
}

/**
 * A line ready to take more time. Signed-off time is taken back first when it
 * may be — the person's own submission by them, anything by an admin acting
 * for them — and the day then needs submitting again, as after any change.
 * Time an admin has approved isn't the person's to reopen.
 */
function lineReadyToAdd(line: Entry, who: { userId: number; actorUserId: number }, now: number): Entry {
  if (isEditable(line.status)) return line;
  const ownOnly = who.userId === who.actorUserId;
  if (!REOPENABLE_STATUSES.has(line.status) || (ownOnly && line.approvedBy != null)) {
    throw new OpError(
      "conflict",
      `This job already has hours on ${formatWorkDate(line.workDate)}, and they're locked. ${lockedReason(line.status, false)}`,
    );
  }
  reopenEntries({ userId: line.userId, entryIds: [line.id], actorUserId: who.actorUserId, now, ownSubmissionsOnly: ownOnly });
  return getEntry(line.id)!;
}

/** Two descriptions as one; refused rather than cut when together they're too long. */
function joinNotesOf(existing: string | null, added: string | null | undefined): string | null {
  const joined = joinDescriptions(existing, added);
  if (joined && joined.length > NOTE_MAX_LENGTH) {
    throw new OpError("invalid", "Together with the hours already there, the description would be too long. Shorten one first.");
  }
  return joined;
}

function overlapsSegments(segments: readonly Segment[], startedAt: number, endedAt: number): boolean {
  return segments.some((s) => startedAt < (s.endedAt ?? Number.POSITIVE_INFINITY) && s.startedAt < endedAt);
}

/**
 * Add time to a line: a span becomes another segment (never overlapping the
 * line's own), a duration adds to its untimed time, and the description is
 * joined on. `seconds` may be 0: notes attached to hours already counted.
 */
export function addToLine(args: {
  line: Entry;
  userId: number;
  actorUserId: number;
  startedAt?: number;
  endedAt?: number;
  seconds?: number;
  note?: string | null;
  now: number;
}): Entry {
  const line = lineReadyToAdd(args.line, args, args.now);
  const before = snapshot(line);
  const spanned = args.startedAt != null && args.endedAt != null;
  const adding = spanned ? Math.round((args.endedAt! - args.startedAt!) / 1000) : (args.seconds ?? 0);
  if (line.durationSeconds + adding > MAX_ENTRY_SECONDS) {
    throw new OpError("invalid", "That would put more than 24 hours on one job in one day.");
  }
  if (spanned) {
    checkSpan(args.startedAt!, args.endedAt!);
    if (overlapsSegments(line.segments, args.startedAt!, args.endedAt!)) {
      throw new OpError("conflict", "Those times overlap time already on this job that day.");
    }
    db()
      .query("INSERT INTO time_segments (entry_id, started_at, ended_at) VALUES (?, ?, ?)")
      .run(line.id, args.startedAt!, args.endedAt!);
  } else if (adding > 0) {
    db().query("UPDATE time_entries SET untimed_seconds = untimed_seconds + ? WHERE id = ?").run(adding, line.id);
  }
  db().query("UPDATE time_entries SET note = ? WHERE id = ?").run(joinNotesOf(line.note, args.note), line.id);
  recomputeDuration(line.id, args.now);
  const after = getEntry(line.id)!;
  audit({ actorUserId: args.actorUserId, entity: "entry", entityId: line.id, action: "add", before, after: snapshot(after), at: args.now });
  return after;
}

/**
 * Take back exactly what an add put on a line — the undo of joining time to
 * hours that were already there: the untimed seconds or the segment it added,
 * the description as it was, and the notes it made hours of, which are notes
 * again.
 */
export function unmergeEntry(args: {
  userId: number;
  actorUserId: number;
  entryId: string;
  removeSeconds?: number;
  removeSegment?: { startedAt: number; endedAt?: number | null };
  note?: string | null;
  releaseNoteIds?: string[];
  now: number;
}): Entry {
  const entry = ownLiveEntry(args.userId, args.entryId);
  if (!isEditable(entry.status)) throw new OpError("conflict", lockedReason(entry.status, entry.approvedBy == null));
  const before = snapshot(entry);
  if (args.removeSeconds) {
    db()
      .query("UPDATE time_entries SET untimed_seconds = MAX(0, untimed_seconds - ?) WHERE id = ?")
      .run(args.removeSeconds, entry.id);
  }
  if (args.removeSegment) {
    const seg = entry.segments.find(
      (s) => s.startedAt === args.removeSegment!.startedAt && (args.removeSegment!.endedAt == null || s.endedAt === args.removeSegment!.endedAt),
    );
    if (seg) {
      db().query("UPDATE locations SET segment_id = NULL WHERE segment_id = ?").run(seg.id);
      db().query("DELETE FROM time_segments WHERE id = ?").run(seg.id);
    }
  }
  const note = cleanNote(args.note);
  if (note !== undefined) db().query("UPDATE time_entries SET note = ? WHERE id = ?").run(note, entry.id);
  if (args.releaseNoteIds?.length) {
    db()
      .query(
        `UPDATE day_notes SET rolled_into_entry_id = NULL, updated_at = ?
          WHERE user_id = ? AND rolled_into_entry_id = ? AND id IN (${args.releaseNoteIds.map(() => "?").join(",")})`,
      )
      .run(args.now, args.userId, entry.id, ...args.releaseNoteIds);
  }
  recomputeDuration(entry.id, args.now);
  const after = getEntry(entry.id)!;
  audit({ actorUserId: args.actorUserId, entity: "entry", entityId: entry.id, action: "unmerge", before, after: snapshot(after), at: args.now });
  return after;
}

/**
 * Fold a person's several lines for one job and day — made before one line
 * per job was the rule — into the first: segments, untimed time, notes and
 * location fixes move over, descriptions are joined, the rest are deleted
 * (and, if they reached the accounting system, removed there by the sync).
 * Only time that can still be changed; a running timer has to stop first.
 */
export function combineEntries(args: {
  userId: number;
  actorUserId: number;
  intoEntryId: string;
  entryIds: string[];
  now: number;
}): Entry {
  const into = ownLiveEntry(args.userId, args.intoEntryId);
  const others = [...new Set(args.entryIds.map(resolveEntryId))]
    .filter((id) => id !== into.id)
    .map((id) => ownLiveEntry(args.userId, id));
  if (others.length === 0) return into;
  for (const e of [into, ...others]) {
    if (e.jobId !== into.jobId || e.workDate !== into.workDate) {
      throw new OpError("invalid", "Only hours on the same job and day can be combined.");
    }
    if (e.status === "open") throw new OpError("conflict", "Stop the timer before combining its hours.");
    if (!isEditable(e.status)) {
      throw new OpError("conflict", `Some of these hours are submitted. ${lockedReason(e.status, e.approvedBy == null)}`);
    }
  }
  const before = snapshot(into);
  let note = into.note;
  for (const other of others) {
    db().query("UPDATE time_segments SET entry_id = ? WHERE entry_id = ?").run(into.id, other.id);
    db().query("UPDATE locations SET entry_id = ? WHERE entry_id = ?").run(into.id, other.id);
    db().query("UPDATE day_notes SET rolled_into_entry_id = ? WHERE rolled_into_entry_id = ?").run(into.id, other.id);
    db().query("UPDATE time_entries SET untimed_seconds = untimed_seconds + ? WHERE id = ?").run(other.untimedSeconds, into.id);
    note = joinNotesOf(note, other.note);
    db().query("UPDATE time_entries SET deleted_at = ?, updated_at = ? WHERE id = ?").run(args.now, args.now, other.id);
    db().query("UPDATE entry_aliases SET entry_id = ? WHERE entry_id = ?").run(into.id, other.id);
    recordAlias(other.id, into.id, args.now);
  }
  db().query("UPDATE time_entries SET note = ? WHERE id = ?").run(note, into.id);
  recomputeDuration(into.id, args.now);
  const after = getEntry(into.id)!;
  if (after.durationSeconds > MAX_ENTRY_SECONDS) {
    throw new OpError("invalid", "Together these would be more than 24 hours on one job in one day.");
  }
  audit({
    actorUserId: args.actorUserId,
    entity: "entry",
    entityId: into.id,
    action: "combine",
    before,
    after: { ...snapshot(after), combined: others.map((o) => o.id) },
    at: args.now,
  });
  return after;
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
  if (running && at === running.startedAt && (entry.segments.length > 1 || entry.untimedSeconds > 0)) {
    // Stopped the moment it started: a line continued and at once taken back
    // (that's how its undo works). The empty segment goes rather than stays.
    db().query("UPDATE locations SET segment_id = NULL WHERE segment_id = ?").run(running.id);
    db().query("DELETE FROM time_segments WHERE id = ?").run(running.id);
  } else if (running) {
    db().query("UPDATE time_segments SET ended_at = ? WHERE id = ?").run(at, running.id);
  }
  db()
    .query("UPDATE time_entries SET status = 'draft', note = ?, updated_at = ? WHERE id = ?")
    .run(finalNote ?? null, now, entry.id);
  recomputeDuration(entry.id, now);
}

export function startTimer(args: {
  userId: number;
  /** Who is starting it: the person, or an admin acting for them. */
  actorUserId?: number;
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
  const who = { userId: args.userId, actorUserId: args.actorUserId ?? args.userId };

  // The job already has hours today: the timer continues that line.
  const line = lineFor(args.userId, jobId, workDateOf(args.at), args.entryId);
  if (line) return continueLine(line, args, who);

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

/**
 * A timer started on a job that already has hours today runs on that line: a
 * new segment from `at`, as resuming after a pause makes one, so the times are
 * all kept. Already running on it: nothing to do. Paused on it: a resume.
 */
function continueLine(
  line: Entry,
  args: { entryId: string; at: number; note?: string | null; location?: LocationFix | null; now: number },
  who: { userId: number; actorUserId: number },
): Entry {
  const open = getOpenEntry(who.userId);
  if (open?.id === line.id) {
    recordAlias(args.entryId, line.id, args.now);
    if (open.segments.some((s) => s.endedAt == null)) return open;
    return resumeTimer({ userId: who.userId, entryId: line.id, at: args.at, now: args.now });
  }
  const lastEnd = Math.max(0, ...line.segments.map((s) => s.endedAt ?? 0));
  if (args.at < lastEnd) {
    throw new OpError(
      "conflict",
      "This job's time today already runs past that moment, so a timer on it can't start then. Check the device's clock.",
    );
  }
  if (open) stopOpen(open, args.at, undefined, args.now);
  const ready = lineReadyToAdd(line, who, args.now);
  const segment = db()
    .query<{ id: number }, [string, number]>("INSERT INTO time_segments (entry_id, started_at) VALUES (?, ?) RETURNING id")
    .get(ready.id, args.at)!;
  db()
    .query("UPDATE time_entries SET status = 'open', note = ?, updated_at = ? WHERE id = ?")
    .run(joinNotesOf(ready.note, cleanNote(args.note)), args.now, ready.id);
  recomputeDuration(ready.id, args.now);
  recordAlias(args.entryId, ready.id, args.now);
  recordLocation({ entryId: ready.id, segmentId: segment.id, kind: "start", fix: args.location });
  audit({
    actorUserId: who.actorUserId,
    entity: "entry",
    entityId: ready.id,
    action: "continue",
    before: snapshot(ready),
    after: { alias: args.entryId, at: args.at },
    at: args.now,
  });
  return getEntry(ready.id)!;
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
  /** Who is adding it: the person, or an admin acting for them. */
  actorUserId?: number;
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

  // The job already has hours that day: this joins them.
  const line = lineFor(args.userId, jobId, workDate, args.entryId);
  if (line) {
    const after = addToLine({
      line,
      userId: args.userId,
      actorUserId: args.actorUserId ?? args.userId,
      ...(spanned ? { startedAt: args.startedAt!, endedAt: args.endedAt! } : { seconds }),
      note: args.note,
      now: args.now,
    });
    recordAlias(args.entryId, after.id, args.now);
    return after;
  }

  db()
    .query(
      `INSERT INTO time_entries
         (id, user_id, job_id, work_date, duration_seconds, untimed_seconds, note, source, status,
          device_id, client_created_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    )
    .run(
      args.entryId,
      args.userId,
      jobId,
      workDate,
      seconds,
      spanned ? 0 : seconds,
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
 *
 * `convertTo` is how an entry changes from one of those to the other — "I ran
 * the timer but the times are wrong, it was just two hours". It has to be
 * asked for by name: the guards below exist so that a client sending a
 * duration for an entry that has times is told it's confused rather than
 * silently destroying the times, and inferring the conversion from the same
 * fields would take that back.
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
  convertTo?: "duration" | "times";
  now: number;
}): Entry {
  const entry = ownLiveEntry(args.userId, args.entryId);
  if (!isEditable(entry.status))
    throw new OpError("conflict", lockedReason(entry.status, entry.approvedBy == null));
  const before = snapshot(entry);
  const hasTimes = entry.segments.length > 0;
  // Asking for the shape it already has is an ordinary edit, not a conversion.
  const convertTo = args.convertTo === (hasTimes ? "times" : "duration") ? undefined : args.convertTo;

  const jobId =
    args.jobId === undefined || args.jobId === entry.jobId ? args.jobId : requireBookableJob(args.jobId).id;
  // A line that holds timed and untimed time takes a duration as its new total.
  const mixed = hasTimes && entry.untimedSeconds > 0;

  if (convertTo !== undefined) {
    if (entry.status === "open") {
      throw new OpError("conflict", "Stop the timer before changing how this time is recorded.");
    }
  } else {
    if ((args.workDate !== undefined || (args.durationSeconds !== undefined && !mixed)) && hasTimes) {
      throw new OpError("invalid", "This entry has start and end times; change those instead.");
    }
    if ((args.startedAt !== undefined || args.endedAt !== undefined) && !hasTimes) {
      throw new OpError("invalid", "This entry is a plain duration; change the duration instead.");
    }
  }
  if (args.endedAt !== undefined && entry.status === "open") {
    throw new OpError("conflict", "Stop the timer before changing its end time.");
  }

  if (convertTo === "duration") {
    if (args.durationSeconds === undefined) {
      throw new OpError("invalid", "Converting to a duration needs the duration.");
    }
    // The segments go, pauses and all — their times being wrong is the whole
    // reason for the conversion. Location fixes don't: they were taken at real
    // moments and are still true once the times are gone, so they're detached
    // from the segments rather than cascading away with them.
    db().query("UPDATE locations SET segment_id = NULL WHERE entry_id = ?").run(entry.id);
    db().query("DELETE FROM time_segments WHERE entry_id = ?").run(entry.id);
    db()
      .query("UPDATE time_entries SET work_date = ?, duration_seconds = ?, untimed_seconds = ? WHERE id = ?")
      .run(args.workDate ?? entry.workDate, args.durationSeconds, args.durationSeconds, entry.id);
  } else if (convertTo === "times") {
    if (args.startedAt === undefined || args.endedAt === undefined) {
      throw new OpError("invalid", "Converting to a start and an end needs both.");
    }
    checkSpan(args.startedAt, args.endedAt);
    db()
      .query("INSERT INTO time_segments (entry_id, started_at, ended_at) VALUES (?, ?, ?)")
      .run(entry.id, args.startedAt, args.endedAt);
    // As everywhere else, a span's work date follows its start, and
    // recomputeDuration below takes the duration from the segment.
    db()
      .query("UPDATE time_entries SET work_date = ?, untimed_seconds = 0 WHERE id = ?")
      .run(workDateOf(args.startedAt), entry.id);
  } else if (hasTimes && (args.startedAt !== undefined || args.endedAt !== undefined)) {
    // Only a change to the times is held to these: a note or job edit leaves
    // them as they are, however they are — an undo can leave a pause with
    // nothing in it, and the note must still be editable.
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
  } else if (!hasTimes) {
    if (args.workDate !== undefined) {
      db().query("UPDATE time_entries SET work_date = ? WHERE id = ?").run(args.workDate, entry.id);
    }
    if (args.durationSeconds !== undefined) {
      db().query("UPDATE time_entries SET untimed_seconds = ? WHERE id = ?").run(args.durationSeconds, entry.id);
    }
  } else if (mixed && args.durationSeconds !== undefined) {
    // The total changes; the times stay, so what changes is the untimed part.
    const timed = timedSeconds(entry.segments);
    if (args.durationSeconds < timed) {
      throw new OpError(
        "invalid",
        "That's less than the timed part of these hours. Change the times, or turn the entry into a plain duration.",
      );
    }
    db().query("UPDATE time_entries SET untimed_seconds = ? WHERE id = ?").run(args.durationSeconds - timed, entry.id);
  }

  // Still one line per job per day: moving these hours onto a job and day
  // that already has a line is refused rather than quietly merged.
  const moved = getEntry(entry.id)!;
  const targetJob = jobId ?? entry.jobId;
  if (targetJob && (targetJob !== entry.jobId || moved.workDate !== entry.workDate)) {
    const other = lineFor(entry.userId, targetJob, moved.workDate, entry.id);
    if (other) {
      throw new OpError(
        "conflict",
        `That job already has hours on ${formatWorkDate(moved.workDate)}. Add to those instead, or delete one of the two.`,
      );
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
  // An id whose time joined a line names only part of it; deleting the whole
  // line for it would take more than that op ever added.
  if (resolveEntryId(args.entryId) !== args.entryId) {
    throw new OpError("conflict", "Those hours were added to the job's other hours that day. Change those instead.");
  }
  const entry = ownLiveEntry(args.userId, args.entryId);
  if (!isEditable(entry.status))
    throw new OpError("conflict", lockedReason(entry.status, entry.approvedBy == null));
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
 * Undo a stop or a pause: the timer runs again from the moment it last
 * stopped, so the time since counts as if it had never been stopped. It is
 * a new segment from that moment rather than the old one reopened — the
 * record is the same either way, and a device's copy can then show it from
 * what it already holds (the last end) without knowing the segments.
 */
export function reopenTimer(args: { userId: number; actorUserId: number; entryId: string; now: number }): Entry {
  const entry = ownLiveEntry(args.userId, args.entryId);
  if (entry.status !== "open" && entry.status !== "draft") {
    throw new OpError("conflict", lockedReason(entry.status, entry.approvedBy == null));
  }
  if (entry.segments.some((s) => s.endedAt == null)) throw new OpError("conflict", "That timer is already running.");
  const lastEnd = Math.max(0, ...entry.segments.map((s) => s.endedAt ?? 0));
  if (!lastEnd) throw new OpError("conflict", "That time was typed in as a duration; it has no timer to restart.");
  const open = getOpenEntry(args.userId);
  if (open && open.id !== entry.id) throw new OpError("conflict", "Another timer is running. Stop it first.");
  db().query("INSERT INTO time_segments (entry_id, started_at) VALUES (?, ?)").run(entry.id, lastEnd);
  db().query("UPDATE time_entries SET status = 'open', updated_at = ? WHERE id = ?").run(args.now, entry.id);
  recomputeDuration(entry.id, args.now);
  audit({
    actorUserId: args.actorUserId,
    entity: "entry",
    entityId: entry.id,
    action: "reopen_timer",
    before: snapshot(entry),
    at: args.now,
  });
  return getEntry(entry.id)!;
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
