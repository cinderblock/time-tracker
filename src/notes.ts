import { audit } from "./audit.ts";
import { db } from "./db.server.ts";
import { type LocationFix, createManualEntry } from "./entries.ts";
import { requireBookableJob } from "./jobs.ts";
import { OpError } from "./op-error.ts";
import type { NoteKind } from "./ops-schema.ts";
import { rollupProblems } from "./rollup.ts";
import { workDateOf } from "./time.ts";

/**
 * Day notes: quick "what I'm doing now" jottings under the job they're
 * about, later turned into time entries. A 'start' is a note with no words
 * that marks being on a job from that moment. A note that has been turned
 * into time is part of an entry and is frozen.
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
  deleted_at: number | null;
}

const COLUMNS = "id, user_id, at, work_date, kind, text, job_id, rolled_into_entry_id, deleted_at";

const toNote = (r: NoteRow): DayNote => ({
  id: r.id,
  userId: r.user_id,
  at: r.at,
  workDate: r.work_date,
  kind: r.kind,
  text: r.text,
  jobId: r.job_id,
  rolledIntoEntryId: r.rolled_into_entry_id,
});

function getRow(id: string): NoteRow | null {
  return db().query<NoteRow, [string]>(`SELECT ${COLUMNS} FROM day_notes WHERE id = ?`).get(id);
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
}

export function listNotesForDate(userId: number, workDate: string): DayNote[] {
  return db()
    .query<NoteRow, [number, string]>(
      `SELECT ${COLUMNS} FROM day_notes
        WHERE user_id = ? AND work_date = ? AND deleted_at IS NULL
        ORDER BY at, id`,
    )
    .all(userId, workDate)
    .map(toNote);
}

/**
 * The latest day before `before` whose notes haven't been turned into time,
 * if any. In notes mode that day has to be finished before a later one can
 * take notes.
 */
export function pendingNotesBefore(userId: number, before: string): { date: string; count: number } | null {
  const row = db()
    .query<{ work_date: string; n: number }, [number, string]>(
      `SELECT work_date, COUNT(*) AS n FROM day_notes
        WHERE user_id = ? AND work_date < ? AND deleted_at IS NULL AND rolled_into_entry_id IS NULL
        GROUP BY work_date
        ORDER BY work_date DESC
        LIMIT 1`,
    )
    .get(userId, before);
  return row ? { date: row.work_date, count: row.n } : null;
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
 * Commit a reviewed rollup: create one entry per line — a span, or a duration
 * on the day — and mark its notes as rolled into it. All or nothing — the
 * caller runs this in one transaction.
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
  const problems = rollupProblems(args.lines);
  if (problems.length > 0) throw new OpError("invalid", problems.join(" "));

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
  for (const line of args.lines) {
    const spanned = line.startedAt != null && line.endedAt != null;
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
    const mark = db().query("UPDATE day_notes SET rolled_into_entry_id = ?, updated_at = ? WHERE id = ?");
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
