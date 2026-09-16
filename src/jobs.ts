import { audit } from "./audit.ts";
import { config } from "./config.server.ts";
import { db } from "./db.server.ts";
import { JOB_NAME_MAX_LENGTH } from "./limits.ts";
import { OpError } from "./op-error.ts";
import { UserInputError } from "./users.ts";

/**
 * Jobs — what time is booked against.
 *
 * With an accounting backend, jobs normally arrive from it (remote-lists.ts
 * pulls them). Anyone may still create one here when the work can't wait for
 * the real job to exist; such jobs are `provisional` until an admin links them
 * to a real one (merging them) or has them created there. With no backend
 * there is nothing to link to, so locally created jobs are simply jobs.
 */

export interface Job {
  id: string;
  name: string;
  /** "Parent:Child" path, the way accounting systems display nested jobs. */
  fullName: string;
  parentId: string | null;
  remoteId: string | null;
  /** Whether the accounting system has it active. Always true for local jobs. */
  remoteActive: boolean;
  provisional: boolean;
  /** Set on a provisional job that was linked to a real one: the job it became. */
  mergedInto: string | null;
  /** An admin asked for it to be created in the accounting system. */
  createRequestedAt: number | null;
  /** Why the last attempt to create it there failed. */
  syncError: string | null;
  defaultServiceItemId: string | null;
  requiresNote: boolean;
  /** Open here. A job can take time only when this and `remoteActive` are both true. */
  active: boolean;
  createdBy: number | null;
  createdAt: number;
}

interface JobRow {
  id: string;
  name: string;
  parent_id: string | null;
  remote_id: string | null;
  remote_active: number;
  provisional: number;
  merged_into: string | null;
  create_requested_at: number | null;
  sync_error: string | null;
  default_service_item_id: string | null;
  requires_note: number;
  active: number;
  created_by: number | null;
  created_at: number;
}

const COLUMNS =
  "id, name, parent_id, remote_id, remote_active, provisional, merged_into, create_requested_at, sync_error, default_service_item_id, requires_note, active, created_by, created_at";

function allRows(): JobRow[] {
  return db().query<JobRow, []>(`SELECT ${COLUMNS} FROM jobs`).all();
}

function withFullNames(rows: JobRow[]): Job[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const fullName = (row: JobRow): string => {
    const parts = [row.name];
    const seen = new Set([row.id]);
    let parent = row.parent_id ? byId.get(row.parent_id) : undefined;
    // `seen` guards against a cycle ever sneaking into the data.
    while (parent && !seen.has(parent.id)) {
      parts.unshift(parent.name);
      seen.add(parent.id);
      parent = parent.parent_id ? byId.get(parent.parent_id) : undefined;
    }
    return parts.join(":");
  };
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    fullName: fullName(r),
    parentId: r.parent_id,
    remoteId: r.remote_id,
    remoteActive: r.remote_active === 1,
    provisional: r.provisional === 1,
    mergedInto: r.merged_into,
    createRequestedAt: r.create_requested_at,
    syncError: r.sync_error,
    defaultServiceItemId: r.default_service_item_id,
    requiresNote: r.requires_note === 1,
    active: r.active === 1,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

/** Whether time can be booked against a job right now. */
export const isBookable = (job: Pick<Job, "active" | "remoteActive" | "mergedInto">) =>
  job.active && job.remoteActive && job.mergedInto == null;

/**
 * All jobs, sorted by full name. Closed ones only when asked for. Jobs merged
 * into another are never listed: they live on as the job they became.
 */
export function listJobs(opts: { includeInactive?: boolean } = {}): Job[] {
  return withFullNames(allRows())
    .filter((j) => j.mergedInto == null && (opts.includeInactive || isBookable(j)))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" }));
}

/** A job by id, including merged ones (use `resolveJob` to follow a merge). */
export function getJob(id: string): Job | null {
  return withFullNames(allRows()).find((j) => j.id === id) ?? null;
}

/** A job by id, following merges to the job it became. */
export function resolveJob(id: string): Job | null {
  const all = new Map(withFullNames(allRows()).map((j) => [j.id, j]));
  let job = all.get(id);
  const seen = new Set<string>();
  while (job?.mergedInto && !seen.has(job.id)) {
    seen.add(job.id);
    job = all.get(job.mergedInto);
  }
  return job ?? null;
}

/**
 * A job time can be booked against right now, or an OpError explaining why
 * not. Follows merges, so callers must store the returned job's id rather
 * than the one they were given.
 */
export function requireBookableJob(id: string): Job {
  const job = resolveJob(id);
  if (!job) throw new OpError("not_found", "That job doesn't exist.");
  if (!job.active) throw new OpError("conflict", `“${job.fullName}” is closed. Pick another job.`);
  if (!job.remoteActive) {
    throw new OpError("conflict", `“${job.fullName}” is inactive in the accounting system. Pick another job.`);
  }
  return job;
}

function normalizeJobName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) throw new OpError("invalid", "Name the job.");
  if (name.length > JOB_NAME_MAX_LENGTH) throw new OpError("invalid", "That name is too long.");
  // ":" is the path separator in full names; allowing it would make
  // "A:B" ambiguous between a job and a sub-job.
  if (name.includes(":")) throw new OpError("invalid", "Job names can't contain “:”.");
  return name;
}

function nameTaken(name: string, parentId: string | null, exceptId: string | null): boolean {
  return (
    db()
      .query<{ id: string }, [string, string | null, string]>(
        "SELECT id FROM jobs WHERE name = ? COLLATE NOCASE AND parent_id IS ? AND merged_into IS NULL AND id != ?",
      )
      .get(name, parentId, exceptId ?? "") != null
  );
}

export function createJob(args: {
  id: string;
  name: string;
  parentId?: string | null;
  actorUserId: number;
  now?: number;
}): Job {
  const now = args.now ?? Date.now();
  const name = normalizeJobName(args.name);
  const parent = args.parentId ? resolveJob(args.parentId) : null;
  if (args.parentId && !parent) throw new OpError("not_found", "The parent job doesn't exist.");
  const parentId = parent?.id ?? null;

  if (nameTaken(name, parentId, null)) {
    throw new OpError("conflict", `There's already a job called “${name}”${parentId ? " there" : ""}.`);
  }
  if (getJob(args.id)) throw new OpError("conflict", "A job with that id already exists.");

  const provisional = config.accounting.kind !== "none";
  db()
    .query(
      `INSERT INTO jobs (id, name, parent_id, provisional, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(args.id, name, parentId, provisional ? 1 : 0, args.actorUserId, now, now);
  audit({
    actorUserId: args.actorUserId,
    entity: "job",
    entityId: args.id,
    action: "create",
    after: { name, parentId, provisional },
    at: now,
  });
  return getJob(args.id)!;
}

/** Admin edits. Throws UserInputError (these come from forms, not ops). */
export function updateJob(args: {
  id: string;
  name?: string;
  active?: boolean;
  requiresNote?: boolean;
  actorUserId: number;
}): Job {
  const job = getJob(args.id);
  if (!job || job.mergedInto) throw new UserInputError("That job no longer exists.");
  let name = job.name;
  if (args.name !== undefined && args.name.trim() !== job.name) {
    if (job.remoteId) {
      throw new UserInputError("This job's name comes from the accounting system. Rename it there.");
    }
    try {
      name = normalizeJobName(args.name);
    } catch (err) {
      throw new UserInputError(err instanceof Error ? err.message : "Invalid name.");
    }
    if (nameTaken(name, job.parentId, job.id)) throw new UserInputError(`There's already a job called “${name}”.`);
  }
  const active = args.active ?? job.active;
  const requiresNote = args.requiresNote ?? job.requiresNote;
  if (name === job.name && active === job.active && requiresNote === job.requiresNote) return job;

  db()
    .query("UPDATE jobs SET name = ?, active = ?, requires_note = ?, updated_at = ? WHERE id = ?")
    .run(name, active ? 1 : 0, requiresNote ? 1 : 0, Date.now(), job.id);
  audit({
    actorUserId: args.actorUserId,
    entity: "job",
    entityId: job.id,
    action: "update",
    before: { name: job.name, active: job.active, requiresNote: job.requiresNote },
    after: { name, active, requiresNote },
  });
  return getJob(job.id)!;
}

/** The bookable jobs a person booked most recently, newest first — for one-tap switching. */
export function recentJobIds(userId: number, limit = 6): string[] {
  return db()
    .query<{ job_id: string }, [number, number]>(
      `SELECT e.job_id
         FROM time_entries e
         JOIN jobs j ON j.id = e.job_id AND j.active = 1 AND j.remote_active = 1 AND j.merged_into IS NULL
        WHERE e.user_id = ? AND e.deleted_at IS NULL
        GROUP BY e.job_id
        ORDER BY MAX(e.created_at) DESC
        LIMIT ?`,
    )
    .all(userId, limit)
    .map((r) => r.job_id);
}
