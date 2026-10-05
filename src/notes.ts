import { audit } from "./audit.ts";
import { db } from "./db.server.ts";
import { type LocationFix, addToLine, createManualEntry, lineFor, recordEntryAlias } from "./entries.ts";
import { requireBookableJob } from "./jobs.ts";
import { OpError } from "./op-error.ts";
import type { NoteKind, NoteSettled } from "./ops-schema.ts";
import { rollupProblems } from "./rollup.ts";
import { workDateOf } from "./time.ts";

/**
 * Day notes: quick "what I'm doing now" jottings under the job they're
 * about, later turned into time entries. A 'start' is a note with no words
 * that marks being on a job from that moment. A note that has been turned
 * into time is part of an entry and is frozen. So is a settled one: a note
 * that won't become hours here, because the accounting system's record of
 * the same time was kept, or because the person left it out.
 */

export interface DayNote {
  id: string;
  userId: number;
  at: number;
  workDate: string;
  kind: NoteKind;
  /** Empty for a start. */
  text: string;
  jobId: string | null;
  rolledIntoEntryId: string | null;
  /** Settled without being part of an entry here, and how; null if not. */
  settled: NoteSettled | null;
}

interface NoteRow {
  id: string;
  user_id: number;
  at: number;
  work_date: string;
  kind: NoteKind;
  text: string;
  job_id: string | null;
  rolled_into_entry_id: string | null;
  settled_as: NoteSettled | null;
  deleted_at: number | null;
}

/**
 * A note is part of an entry only while that entry is live: delete the entry
 * — undoing a rollup — and its notes are free to become hours again; restore
 * it and they are its once more. The link itself is left in place for that.
 */
const COLUMNS = `n.id, n.user_id, n.at, n.work_date, n.kind, n.text, n.job_id,
       CASE WHEN e.id IS NOT NULL AND e.deleted_at IS NULL THEN n.rolled_into_entry_id END AS rolled_into_entry_id,
       n.settled_as, n.deleted_at`;
const FROM = "day_notes n LEFT JOIN time_entries e ON e.id = n.rolled_into_entry_id";

/** Still to be turned into hours: part of no live entry, and not settled. */
const PENDING = "(n.rolled_into_entry_id IS NULL OR e.id IS NULL OR e.deleted_at IS NOT NULL) AND n.settled_as IS NULL";

const toNote = (r: NoteRow): DayNote => ({
  id: r.id,
  userId: r.user_id,
  at: r.at,
  workDate: r.work_date,
  kind: r.kind,
  text: r.text,
  jobId: r.job_id,
  rolledIntoEntryId: r.rolled_into_entry_id,
  settled: r.settled_as,
});

function getRow(id: string): NoteRow | null {
  return db().query<NoteRow, [string]>(`SELECT ${COLUMNS} FROM ${FROM} WHERE n.id = ?`).get(id);
}

function ownLiveNote(userId: number, noteId: string): NoteRow {
  const row = getRow(noteId);
  if (!row || row.user_id !== userId || row.deleted_at != null) {
    throw new OpError("not_found", "That note no longer exists.");
  }
  return row;
}

function assertNotRolled(row: NoteRow): void {
  if (row.rolled_into_entry_id) {
    throw new OpError("conflict", "That note is already part of a time entry; edit the entry instead.");
  }
  if (row.settled_as === "kept_in_accounting") {
    throw new OpError("conflict", "That note's time is already in the accounting system.");
  }
  if (row.settled_as === "left_out") {
    throw new OpError("conflict", "That note was left out of the hours; bring it back first.");
  }
}

/**
 * An entry is being deleted because the accounting system already has the
 * same time, and its record there is the one kept. The notes that became
 * the entry are settled by that record: unlike a delete that undoes a rollup,
 * they don't go back to being notes to turn into hours.
 */
export function discardedFor(entryId: string, now: number): void {
  db()
    .query(
      `UPDATE day_notes SET settled_as = 'kept_in_accounting', settled_at = ?, updated_at = ?
        WHERE rolled_into_entry_id = ? AND deleted_at IS NULL`,
    )
    .run(now, now, entryId);
}

/**
 * Leave notes out of the hours: their time was billed some other way, or
 * wasn't work. They stay as a record, settled, and the day no longer waits
 * on them. Nothing about time changes, so a submitted day may do this too.
 */
export function leaveOutNotes(args: { userId: number; actorUserId: number; noteIds: string[]; now: number }): void {
  const rows = args.noteIds.map((id) => ownLiveNote(args.userId, id));
  for (const row of rows) assertNotRolled(row);
  const mark = db().query("UPDATE day_notes SET settled_as = 'left_out', settled_at = ?, updated_at = ? WHERE id = ?");
  for (const row of rows) mark.run(args.now, args.now, row.id);
  audit({
    actorUserId: args.actorUserId,
    entity: "notes",
    entityId: rows[0]!.work_date,
    action: "leave_out",
    after: { noteIds: args.noteIds },
    at: args.now,
  });
}

/** Undo leaving notes out: they are notes to turn into hours again. */
export function bringBackNotes(args: { userId: number; actorUserId: number; noteIds: string[]; now: number }): void {
  const rows = args.noteIds.map((id) => ownLiveNote(args.userId, id));
  for (const row of rows) {
    if (row.settled_as === "kept_in_accounting") {
      throw new OpError("conflict", "That note's time is in the accounting system, kept in place of its hours here.");
    }
    if (row.settled_as !== "left_out") throw new OpError("conflict", "That note wasn't left out.");
  }
  const clear = db().query("UPDATE day_notes SET settled_as = NULL, settled_at = NULL, updated_at = ? WHERE id = ?");
  for (const row of rows) clear.run(args.now, row.id);
  audit({
    actorUserId: args.actorUserId,
    entity: "notes",
    entityId: rows[0]!.work_date,
    action: "bring_back",
    after: { noteIds: args.noteIds },
    at: args.now,
  });
}

export function listNotesForDate(userId: number, workDate: string): DayNote[] {
  return db()
    .query<NoteRow, [number, string]>(
      `SELECT ${COLUMNS} FROM ${FROM}
        WHERE n.user_id = ? AND n.work_date = ? AND n.deleted_at IS NULL
        ORDER BY n.at, n.id`,
    )
    .all(userId, workDate)
    .map(toNote);
}

/**
 * The latest day before `before` whose notes haven't been turned into time,
 * if any. In notes mode that day has to be finished before a later one can
 * take notes. Settled notes aren't waiting on anything.
 */
export function pendingNotesBefore(userId: number, before: string): { date: string; count: number } | null {
  const row = db()
    .query<{ work_date: string; n: number }, [number, string]>(
      `SELECT n.work_date, COUNT(*) AS n FROM ${FROM}
        WHERE n.user_id = ? AND n.work_date < ? AND n.deleted_at IS NULL AND ${PENDING}
        GROUP BY n.work_date
        ORDER BY n.work_date DESC
        LIMIT 1`,
    )
    .get(userId, before);
  return row ? { date: row.work_date, count: row.n } : null;
}

/** Those of `dates` with notes still to turn into hours, latest first. */
export function datesWithPendingNotes(userId: number, dates: readonly string[]): string[] {
  if (dates.length === 0) return [];
  return db()
    .query<{ work_date: string }, (number | string)[]>(
      `SELECT DISTINCT n.work_date FROM ${FROM}
        WHERE n.user_id = ? AND n.work_date IN (${dates.map(() => "?").join(",")})
          AND n.deleted_at IS NULL AND ${PENDING}
        ORDER BY n.work_date DESC`,
    )
    .all(userId, ...dates)
    .map((r) => r.work_date);
}

export function createNote(args: {
  userId: number;
  noteId: string;
  at: number;
  kind?: NoteKind;
  text?: string;
  jobId?: string | null;
  location?: LocationFix | null;
  deviceId: string;
  now: number;
}): DayNote {
  if (getRow(args.noteId)) throw new OpError("conflict", "That note already exists.");
  const kind = args.kind ?? "note";
  const text = (args.text ?? "").trim();
  if (kind === "note" && !text) throw new OpError("invalid", "Write something.");
  if (kind === "start" && !args.jobId) throw new OpError("invalid", "A start needs a job.");
  const jobId = args.jobId ? requireBookableJob(args.jobId).id : null;
  db()
    .query(
      `INSERT INTO day_notes (id, user_id, at, work_date, kind, text, job_id, device_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.noteId,
      args.userId,
      args.at,
      workDateOf(args.at),
      kind,
      kind === "start" ? "" : text,
      jobId,
      args.deviceId,
      args.now,
      args.now,
    );
  if (args.location) {
    db()
      .query("INSERT INTO locations (note_id, at, lat, lon, accuracy_m, kind) VALUES (?, ?, ?, ?, ?, 'note')")
      .run(args.noteId, args.location.at, args.location.lat, args.location.lon, args.location.accuracy ?? null);
  }
  return toNote(getRow(args.noteId)!);
}

export function updateNote(args: {
  userId: number;
  noteId: string;
  text?: string;
  jobId?: string | null;
  at?: number;
  now: number;
}): DayNote {
  const row = ownLiveNote(args.userId, args.noteId);
  assertNotRolled(row);
  if (row.kind === "start" && args.text !== undefined) {
    throw new OpError("invalid", "A start has no words of its own; add a note under the job instead.");
  }
  const jobId = args.jobId ? requireBookableJob(args.jobId).id : args.jobId;
  const at = args.at ?? row.at;
  db()
    .query("UPDATE day_notes SET text = ?, job_id = ?, at = ?, work_date = ?, updated_at = ? WHERE id = ?")
    .run(
      args.text?.trim() ?? row.text,
      jobId !== undefined ? jobId : row.job_id,
      at,
      workDateOf(at),
      args.now,
      row.id,
    );
  return toNote(getRow(row.id)!);
}

export function deleteNote(args: { userId: number; noteId: string; at: number; now: number }): void {
  const row = ownLiveNote(args.userId, args.noteId);
  assertNotRolled(row);
  db().query("UPDATE day_notes SET deleted_at = ?, updated_at = ? WHERE id = ?").run(args.at, args.now, row.id);
}

export function restoreNote(args: { userId: number; noteId: string; now: number }): void {
  const row = getRow(args.noteId);
  if (!row || row.user_id !== args.userId) throw new OpError("not_found", "That note no longer exists.");
  db().query("UPDATE day_notes SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(args.now, row.id);
}

/**
 * Commit a reviewed rollup: one entry per line — a span, or a duration on the
 * day — with its notes marked as rolled into it. A job that already has hours
 * that day gets these added to them instead (one line per job per day), and
 * the line's id stands for them. All or nothing — the caller runs this in one
 * transaction.
 */
export function commitRollup(args: {
  userId: number;
  /** Who committed it, when not the person themselves. */
  actorUserId?: number;
  workDate: string;
  lines: {
    entryId: string;
    jobId: string;
    startedAt?: number | null;
    endedAt?: number | null;
    durationSeconds?: number | null;
    note?: string | null;
    noteIds: string[];
  }[];
  deviceId: string;
  clientTime: number;
  now: number;
}): string[] {
  const lines = args.lines.map((l) => ({ ...l, line: lineFor(args.userId, l.jobId, args.workDate, l.entryId) }));
  const problems = rollupProblems(lines.map((l) => ({ ...l, joinsLine: l.line != null })));
  if (problems.length > 0) throw new OpError("invalid", problems.join(" "));
  if (new Set(lines.map((l) => l.jobId)).size < lines.length) {
    throw new OpError("invalid", "Each job's notes become one line of hours; give each job one line.");
  }

  const seen = new Set<string>();
  for (const line of args.lines) {
    for (const noteId of line.noteIds) {
      if (seen.has(noteId)) throw new OpError("invalid", "A note appears in two lines.");
      seen.add(noteId);
      const row = ownLiveNote(args.userId, noteId);
      assertNotRolled(row);
      if (row.work_date !== args.workDate) throw new OpError("invalid", "A note belongs to a different day.");
    }
  }

  const created: string[] = [];
  for (const line of lines) {
    const spanned = line.startedAt != null && line.endedAt != null;
    const mark = db().query("UPDATE day_notes SET rolled_into_entry_id = ?, updated_at = ? WHERE id = ?");
    if (line.line) {
      const joined = addToLine({
        line: line.line,
        userId: args.userId,
        actorUserId: args.actorUserId ?? args.userId,
        ...(spanned ? { startedAt: line.startedAt!, endedAt: line.endedAt! } : { seconds: line.durationSeconds! }),
        note: line.note,
        now: args.now,
      });
      recordEntryAlias(line.entryId, joined.id, args.now);
      for (const noteId of line.noteIds) mark.run(joined.id, args.now, noteId);
      created.push(joined.id);
      continue;
    }
    createManualEntry({
      userId: args.userId,
      entryId: line.entryId,
      jobId: line.jobId,
      note: line.note,
      ...(spanned
        ? { startedAt: line.startedAt!, endedAt: line.endedAt! }
        : { workDate: args.workDate, durationSeconds: line.durationSeconds! }),
      source: "note_rollup",
      deviceId: args.deviceId,
      clientTime: args.clientTime,
      now: args.now,
    });
    for (const noteId of line.noteIds) mark.run(line.entryId, args.now, noteId);
    created.push(line.entryId);
  }
  audit({
    actorUserId: args.actorUserId ?? args.userId,
    entity: "rollup",
    entityId: args.workDate,
    action: "commit",
    after: { entries: created.length, notes: seen.size },
    at: args.now,
  });
  return created;
}
