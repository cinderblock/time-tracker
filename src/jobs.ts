import { audit } from "./audit.ts";
import { config } from "./config.server.ts";
import { db } from "./db.server.ts";
import { JOB_NAME_MAX_LENGTH } from "./limits.ts";
import { OpError } from "./op-error.ts";
import { UserInputError } from "./users.ts";

/**
 * Jobs — what time is booked against — and the customers they belong to.
 *
 * The rows form a tree. A top-level row is a *customer*; anything under it is
 * a *job* (jobs can nest further, as they do in accounting systems). Time is
 * booked to jobs only: a customer groups its jobs and never takes time
 * itself. Closing a customer closes its jobs, and a customer's "needs a
 * note" rule applies to them.
 *
 * With an accounting backend, customers and jobs normally arrive from it
 * (remote-lists.ts pulls them). Anyone may still create one here when the
 * work can't wait for the real one to exist; such rows are `provisional`
 * until an admin links them to a real one (merging them) or has them created
 * there. With no backend there is nothing to link to, so locally created
 * rows are simply the list.
 */

export interface Job {
  id: string;
  name: string;
  /** "Customer:Job" path, the way accounting systems display nested jobs. */
  fullName: string;
  parentId: string | null;
  /** The top of this row's tree — its customer. A customer's own id. */
  customerId: string;
  remoteId: string | null;
  /** Whether the accounting system has it active. Always true for local rows. */
  remoteActive: boolean;
  provisional: boolean;
  /** Set on a provisional row that was linked to a real one: the row it became. */
  mergedInto: string | null;
  /** An admin asked for it to be created in the accounting system. */
  createRequestedAt: number | null;
  /** Why the last attempt to create it there failed. */
  syncError: string | null;
  defaultServiceItemId: string | null;
  /** This row's own "needs a note" switch. `noteRequired` is the rule in force. */
  requiresNote: boolean;
  /** Stopping a timer here needs a note: its own switch, or one above it. */
  noteRequired: boolean;
  /** Open here (the admin's switch). Independent of anything above it. */
  active: boolean;
  /** Open, active in the accounting system and not merged — and so is everything above it. */
  open: boolean;
  /** Time can be booked here: open, and a job rather than a customer. */
  bookable: boolean;
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

const selfOpen = (r: JobRow) => r.active === 1 && r.remote_active === 1 && r.merged_into == null;

/** Rows to Jobs, with everything that depends on the rows above each one. */
function hydrate(rows: JobRow[]): Job[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows.map((r) => {
    const names = [r.name];
    let open = selfOpen(r);
    let noteRequired = r.requires_note === 1;
    let top = r;
    // `seen` guards against a cycle ever sneaking into the data.
    const seen = new Set([r.id]);
    for (let p = r.parent_id ? byId.get(r.parent_id) : undefined; p && !seen.has(p.id); ) {
      names.unshift(p.name);
      seen.add(p.id);
      open &&= selfOpen(p);
      noteRequired ||= p.requires_note === 1;
      top = p;
      p = p.parent_id ? byId.get(p.parent_id) : undefined;
    }
    return {
      id: r.id,
      name: r.name,
      fullName: names.join(":"),
      parentId: r.parent_id,
      customerId: top.id,
      remoteId: r.remote_id,
      remoteActive: r.remote_active === 1,
      provisional: r.provisional === 1,
      mergedInto: r.merged_into,
      createRequestedAt: r.create_requested_at,
      syncError: r.sync_error,
      defaultServiceItemId: r.default_service_item_id,
      requiresNote: r.requires_note === 1,
      noteRequired,
      active: r.active === 1,
      open,
      bookable: open && r.parent_id != null,
      createdBy: r.created_by,
      createdAt: r.created_at,
    };
  });
}

const byFullName = (a: Job, b: Job) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" });

/**
 * Customers and jobs, sorted by full name. Open ones by default — customers
 * included, so check `bookable` before booking — or everything when asked.
 * Rows merged into another are never listed: they live on as the row they
 * became.
 */
export function listJobs(opts: { includeInactive?: boolean } = {}): Job[] {
  return hydrate(allRows())
    .filter((j) => j.mergedInto == null && (opts.includeInactive || j.open))
    .sort(byFullName);
}

/** A row by id, including merged ones (use `resolveJob` to follow a merge). */
export function getJob(id: string): Job | null {
  return hydrate(allRows()).find((j) => j.id === id) ?? null;
}

/** A row by id, following merges to the row it became. */
export function resolveJob(id: string): Job | null {
  const all = new Map(hydrate(allRows()).map((j) => [j.id, j]));
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
  if (!job.parentId) throw new OpError("conflict", `“${job.fullName}” is a customer. Pick one of its jobs.`);
  if (!job.open) throw new OpError("conflict", `“${job.fullName}” is under a closed customer. Pick another job.`);
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

/** A new customer (no parent) or job (under one). */
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
  if (args.parentId && !parent) throw new OpError("not_found", "The customer doesn't exist.");
  const parentId = parent?.id ?? null;

  if (nameTaken(name, parentId, null)) {
    throw new OpError(
      "conflict",
      parentId ? `“${parent!.fullName}” already has a job called “${name}”.` : `There's already a customer called “${name}”.`,
    );
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
      throw new UserInputError("This name comes from the accounting system. Change it there.");
    }
    try {
      name = normalizeJobName(args.name);
    } catch (err) {
      throw new UserInputError(err instanceof Error ? err.message : "Invalid name.");
    }
    if (nameTaken(name, job.parentId, job.id)) throw new UserInputError(`There's already one called “${name}” there.`);
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
  const bookable = new Set(listJobs().filter((j) => j.bookable).map((j) => j.id));
  return db()
    .query<{ job_id: string }, [number]>(
      `SELECT job_id
         FROM time_entries
        WHERE user_id = ? AND deleted_at IS NULL AND job_id IS NOT NULL
        GROUP BY job_id
        ORDER BY MAX(created_at) DESC`,
    )
    .all(userId)
    .map((r) => r.job_id)
    .filter((id) => bookable.has(id))
    .slice(0, limit);
}
