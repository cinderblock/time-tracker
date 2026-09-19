import type { PulledLists, RemoteItem, RemoteJob, RemotePerson } from "./accounting/types.ts";
import { audit } from "./audit.ts";
import { getCategory } from "./categories.ts";
import { db } from "./db.server.ts";
import { getJob, resolveJob } from "./jobs.ts";
import { QB_NAME_MAX_LENGTH } from "./accounting/qbxml.ts";
import { setDefaultPayrollItemId, setDefaultServiceItemId, updateSyncState } from "./settings.ts";
import { UserInputError, getUser } from "./users.ts";
import { uuidv7 } from "./uuid.ts";

/**
 * The accounting system's lists as copied here, and the links between them
 * and this app's people and jobs.
 */

// ---- pulled lists -------------------------------------------------------------------

export interface CachedPerson extends RemotePerson {}
export interface CachedItem extends RemoteItem {}

export function listRemotePeople(): CachedPerson[] {
  return db()
    .query<{ id: string; kind: RemotePerson["kind"]; name: string; active: number }, []>(
      "SELECT id, kind, name, active FROM remote_people ORDER BY name COLLATE NOCASE",
    )
    .all()
    .map((r) => ({ remoteId: r.id, kind: r.kind, name: r.name, active: r.active === 1 }));
}

export function getRemotePerson(id: string): CachedPerson | null {
  return listRemotePeople().find((p) => p.remoteId === id) ?? null;
}

export function listRemoteItems(kind?: RemoteItem["kind"]): CachedItem[] {
  return db()
    .query<{ id: string; kind: RemoteItem["kind"]; name: string; full_name: string; active: number }, []>(
      "SELECT id, kind, name, full_name, active FROM remote_items ORDER BY full_name COLLATE NOCASE",
    )
    .all()
    .filter((r) => !kind || r.kind === kind)
    .map((r) => ({ remoteId: r.id, kind: r.kind, name: r.name, fullName: r.full_name, active: r.active === 1 }));
}

export function getRemoteItem(id: string): CachedItem | null {
  return listRemoteItems().find((i) => i.remoteId === id) ?? null;
}

/**
 * Store a pull. People and items are upserted, and any no longer listed are
 * marked inactive rather than deleted (something may still name them). Jobs
 * are matched by remote id: known ones follow the accounting system's name,
 * parent and active flag; new ones are added.
 */
export function applyPull(lists: PulledLists, now: number): { jobsAdded: number } {
  return db().transaction(() => {
    const upsertPerson = db().query(
      `INSERT INTO remote_people (id, kind, name, active, synced_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name,
         active = excluded.active, synced_at = excluded.synced_at`,
    );
    for (const p of lists.people) upsertPerson.run(p.remoteId, p.kind, p.name, p.active ? 1 : 0, now);
    db().query("UPDATE remote_people SET active = 0 WHERE synced_at < ?").run(now);

    const upsertItem = db().query(
      `INSERT INTO remote_items (id, kind, name, full_name, active, synced_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, full_name = excluded.full_name,
         active = excluded.active, synced_at = excluded.synced_at`,
    );
    for (const i of lists.items) upsertItem.run(i.remoteId, i.kind, i.name, i.fullName, i.active ? 1 : 0, now);
    // A list that couldn't be read keeps its cached copy.
    // A skipped list keeps whatever an earlier pull stored, rather than being emptied.
    const skippedKinds = [
      ...(lists.skipped.includes("wages") ? ["payroll_wage"] : []),
      ...(lists.skipped.includes("services") ? ["service"] : []),
    ];
    db()
      .query(
        `UPDATE remote_items SET active = 0 WHERE synced_at < ?
           AND kind NOT IN (${skippedKinds.map(() => "?").join(",") || "''"})`,
      )
      .run(now, ...skippedKinds);

    const jobsAdded = applyJobs(lists.jobs, now);
    updateSyncState({ lastPullAt: now });
    return { jobsAdded };
  })();
}

function applyJobs(remote: RemoteJob[], now: number): number {
  const localIdOf = new Map(
    db()
      .query<{ id: string; remote_id: string }, []>("SELECT id, remote_id FROM jobs WHERE remote_id IS NOT NULL")
      .all()
      .map((r) => [r.remote_id, r.id]),
  );
  let added = 0;
  // Parents first, so a child's parent already has a local id.
  const byDepth = [...remote].sort((a, b) => a.fullName.split(":").length - b.fullName.split(":").length);
  for (const job of byDepth) {
    const parentId = job.parentRemoteId ? (localIdOf.get(job.parentRemoteId) ?? null) : null;
    const existing = localIdOf.get(job.remoteId);
    if (existing) {
      db()
        .query(
          `UPDATE jobs SET name = ?, parent_id = ?, remote_full_name = ?, remote_active = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(job.name, parentId, job.fullName, job.active ? 1 : 0, now, existing);
    } else {
      const id = uuidv7(now);
      db()
        .query(
          `INSERT INTO jobs (id, name, parent_id, remote_id, remote_full_name, remote_active, provisional, active,
                             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
        )
        .run(id, job.name, parentId, job.remoteId, job.fullName, job.active ? 1 : 0, now, now);
      localIdOf.set(job.remoteId, id);
      added++;
    }
  }
  // Gone from the accounting system (deleted or merged there): no more time.
  const seen = new Set(remote.map((j) => j.remoteId));
  for (const [remoteId, id] of localIdOf) {
    if (!seen.has(remoteId)) db().query("UPDATE jobs SET remote_active = 0, updated_at = ? WHERE id = ?").run(now, id);
  }
  return added;
}

/** Ask for a pull at the next opportunity. */
export function requestPull(now: number = Date.now()): void {
  updateSyncState({ pullRequestedAt: now });
}

// ---- people -------------------------------------------------------------------------

/** Link a person to their name in the accounting system, or unlink them (`remoteId: null`). */
export function linkPerson(args: { userId: number; remoteId: string | null; actorUserId: number }): void {
  const user = mustGetUser(args.userId);
  if (args.remoteId != null && !getRemotePerson(args.remoteId)) {
    throw new UserInputError("That name isn't in the accounting system's list. Refresh the lists and try again.");
  }
  const before = currentLink(user.id);
  if (before === args.remoteId) return;
  if (args.remoteId != null) {
    const taken = db()
      .query<{ name: string }, [string, number]>("SELECT name FROM users WHERE remote_person_id = ? AND id != ?")
      .get(args.remoteId, user.id);
    if (taken) throw new UserInputError(`That name is already linked to ${taken.name}.`);
  }
  db()
    .query("UPDATE users SET remote_person_id = ?, updated_at = ? WHERE id = ?")
    .run(args.remoteId, Date.now(), user.id);
  audit({
    actorUserId: args.actorUserId,
    entity: "user",
    entityId: user.id,
    action: "link",
    before: { remotePersonId: before },
    after: { remotePersonId: args.remoteId },
  });
}

function currentLink(userId: number): string | null {
  return (
    db().query<{ id: string | null }, [number]>("SELECT remote_person_id AS id FROM users WHERE id = ?").get(userId)
      ?.id ?? null
  );
}

function mustGetUser(id: number) {
  const user = getUser(id);
  if (!user) throw new UserInputError("That person no longer exists.");
  return user;
}

function checkItem(id: string | null, kind: RemoteItem["kind"]): void {
  if (id == null) return;
  const item = getRemoteItem(id);
  if (!item || item.kind !== kind) {
    throw new UserInputError(`That ${kind === "service" ? "service" : "payroll"} item isn't in the accounting system's list.`);
  }
}

/** The organisation's default service and/or payroll item (`null` clears one). */
export function setDefaultItems(items: { service?: string | null; payroll?: string | null }, actorUserId: number): void {
  if (items.service !== undefined) {
    checkItem(items.service, "service");
    setDefaultServiceItemId(items.service, actorUserId);
  }
  if (items.payroll !== undefined) {
    checkItem(items.payroll, "payroll_wage");
    setDefaultPayrollItemId(items.payroll, actorUserId);
  }
}

export interface PersonLink {
  userId: number;
  remotePersonId: string | null;
  payrollItemId: string | null;
}

export function personLinks(): PersonLink[] {
  return db()
    .query<{ id: number; remote_person_id: string | null; default_payroll_item_id: string | null }, []>(
      "SELECT id, remote_person_id, default_payroll_item_id FROM users",
    )
    .all()
    .map((r) => ({ userId: r.id, remotePersonId: r.remote_person_id, payrollItemId: r.default_payroll_item_id }));
}

export function setPersonPayrollItem(args: { userId: number; itemId: string | null; actorUserId: number }): void {
  const user = mustGetUser(args.userId);
  checkItem(args.itemId, "payroll_wage");
  db().query("UPDATE users SET default_payroll_item_id = ?, updated_at = ? WHERE id = ?").run(args.itemId, Date.now(), user.id);
  audit({ actorUserId: args.actorUserId, entity: "user", entityId: user.id, action: "payroll_item", after: { itemId: args.itemId } });
}

export function setCategoryPayrollItem(args: { categoryId: number; itemId: string | null; actorUserId: number }): void {
  if (!getCategory(args.categoryId)) throw new UserInputError("That category no longer exists.");
  checkItem(args.itemId, "payroll_wage");
  db().query("UPDATE employee_categories SET default_payroll_item_id = ? WHERE id = ?").run(args.itemId, args.categoryId);
  audit({
    actorUserId: args.actorUserId,
    entity: "category",
    entityId: args.categoryId,
    action: "payroll_item",
    after: { itemId: args.itemId },
  });
}

export function categoryPayrollItems(): Map<number, string | null> {
  return new Map(
    db()
      .query<{ id: number; item: string | null }, []>("SELECT id, default_payroll_item_id AS item FROM employee_categories")
      .all()
      .map((r) => [r.id, r.item]),
  );
}

// ---- jobs ---------------------------------------------------------------------------

export function setJobServiceItem(args: { jobId: string; itemId: string | null; actorUserId: number }): void {
  const job = getJob(args.jobId);
  if (!job || job.mergedInto) throw new UserInputError("That job no longer exists.");
  checkItem(args.itemId, "service");
  db().query("UPDATE jobs SET default_service_item_id = ?, updated_at = ? WHERE id = ?").run(args.itemId, Date.now(), job.id);
  audit({ actorUserId: args.actorUserId, entity: "job", entityId: job.id, action: "service_item", after: { itemId: args.itemId } });
}

/**
 * Link a provisional job to a job the accounting system already has, by
 * merging it in: its entries, notes, rates and sub-jobs move to the real
 * job, and it forwards there from now on.
 */
export function linkJob(args: { jobId: string; targetId: string; actorUserId: number; now?: number }): void {
  const now = args.now ?? Date.now();
  db().transaction(() => {
    const job = getJob(args.jobId);
    if (!job || job.mergedInto) throw new UserInputError("That job no longer exists.");
    if (job.remoteId) throw new UserInputError(`“${job.fullName}” is already in the accounting system.`);
    const target = resolveJob(args.targetId);
    if (!target?.remoteId) throw new UserInputError("Pick a job from the accounting system.");
    if (target.id === job.id) throw new UserInputError("A job can't be linked to itself.");
    // Time is booked to jobs, never to a customer: a job's time has to land on a job.
    if (job.parentId && !target.parentId) {
      throw new UserInputError(
        `“${target.fullName}” is a customer, and “${job.fullName}” is a job. Link it to one of that customer's jobs, or have it created there.`,
      );
    }

    const moved = {
      entries: db().query("UPDATE time_entries SET job_id = ?, updated_at = ? WHERE job_id = ?").run(target.id, now, job.id).changes,
      notes: db().query("UPDATE day_notes SET job_id = ?, updated_at = ? WHERE job_id = ?").run(target.id, now, job.id).changes,
      subJobs: db().query("UPDATE jobs SET parent_id = ?, updated_at = ? WHERE parent_id = ?").run(target.id, now, job.id).changes,
    };
    // A rate the real job already has for the same person and date wins.
    db()
      .query(
        `UPDATE rates SET deleted_at = ?
          WHERE job_id = ? AND deleted_at IS NULL AND EXISTS (
            SELECT 1 FROM rates t WHERE t.job_id = ? AND t.deleted_at IS NULL AND t.scope = rates.scope
              AND t.user_id IS rates.user_id AND t.effective_from = rates.effective_from)`,
      )
      .run(now, job.id, target.id);
    db().query("UPDATE rates SET job_id = ? WHERE job_id = ?").run(target.id, job.id);
    if (job.requiresNote && !target.requiresNote) {
      db().query("UPDATE jobs SET requires_note = 1 WHERE id = ?").run(target.id);
    }
    db()
      .query(
        `UPDATE jobs SET merged_into = ?, active = 0, create_requested_at = NULL, sync_error = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(target.id, now, job.id);
    audit({
      actorUserId: args.actorUserId,
      entity: "job",
      entityId: job.id,
      action: "link",
      before: { name: job.fullName },
      after: { mergedInto: target.id, name: target.fullName, ...moved },
      at: now,
    });
  })();
}

/**
 * Ask for a provisional job to be created in the accounting system (or stop
 * asking). Its parent, if any, must be there already.
 */
export function requestJobCreation(args: { jobId: string; create: boolean; actorUserId: number; now?: number }): void {
  const job = getJob(args.jobId);
  if (!job || job.mergedInto) throw new UserInputError("That job no longer exists.");
  if (job.remoteId) throw new UserInputError(`“${job.fullName}” is already in the accounting system.`);
  if (args.create) {
    if (job.name.length > QB_NAME_MAX_LENGTH) {
      throw new UserInputError(
        `QuickBooks limits job names to ${QB_NAME_MAX_LENGTH} characters. Rename “${job.name}” first.`,
      );
    }
    if (job.parentId && !getJob(job.parentId)?.remoteId) {
      throw new UserInputError("Its parent job isn't in the accounting system yet. Link or create that first.");
    }
  }
  db()
    .query("UPDATE jobs SET create_requested_at = ?, sync_error = NULL, sync_next_at = NULL, updated_at = ? WHERE id = ?")
    .run(args.create ? (args.now ?? Date.now()) : null, Date.now(), job.id);
  audit({
    actorUserId: args.actorUserId,
    entity: "job",
    entityId: job.id,
    action: args.create ? "create_remote_requested" : "create_remote_cancelled",
  });
}
