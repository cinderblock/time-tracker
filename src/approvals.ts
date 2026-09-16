import { audit } from "./audit.ts";
import { db } from "./db.server.ts";
import { type EntryStatus, REOPENABLE_STATUSES } from "./entry-status.ts";
import { rateResolver } from "./rates.ts";
import { UserInputError } from "./users.ts";

/**
 * Approval: an admin signs off time, which locks it and makes it eligible to
 * be sent to the accounting system.
 *
 * Approving copies the rate in effect onto each entry, so later rate changes
 * never rewrite approved time. Running timers can't be approved — they're
 * skipped and reported, and approving again after they stop picks them up.
 * Reopening puts approved time back to draft so it can be corrected. Time
 * already sent keeps its link to the accounting system's record: approving it
 * again amends that record, and deleting it removes it there (sync.ts).
 */

export interface Selection {
  userId: number;
  /** Inclusive date range… */
  from?: string;
  to?: string;
  /** …or specific entries (of that person). */
  entryIds?: string[];
}

interface Row {
  id: string;
  user_id: number;
  job_id: string | null;
  work_date: string;
  status: EntryStatus;
  rate_snapshot: number | null;
}

function select(sel: Selection): Row[] {
  const where = ["user_id = ?", "deleted_at IS NULL"];
  const params: (string | number)[] = [sel.userId];
  if (sel.entryIds) {
    if (sel.entryIds.length === 0) return [];
    where.push(`id IN (${sel.entryIds.map(() => "?").join(",")})`);
    params.push(...sel.entryIds);
  }
  if (sel.from) {
    where.push("work_date >= ?");
    params.push(sel.from);
  }
  if (sel.to) {
    where.push("work_date <= ?");
    params.push(sel.to);
  }
  if (!sel.entryIds && !(sel.from && sel.to)) throw new UserInputError("Pick the time to change.");
  return db()
    .query<Row, (string | number)[]>(
      `SELECT id, user_id, job_id, work_date, status, rate_snapshot FROM time_entries
        WHERE ${where.join(" AND ")} ORDER BY work_date, id`,
    )
    .all(...params);
}

export interface ApprovalResult {
  /** Entries whose state changed. */
  changed: number;
  /** Entries left alone because they were already in the target state. */
  unchanged: number;
  /** Entries that couldn't change (running timers; time already in accounting). */
  skipped: number;
}

export function approveEntries(sel: Selection & { actorUserId: number; now?: number }): ApprovalResult {
  const now = sel.now ?? Date.now();
  return db().transaction((): ApprovalResult => {
    const rows = select(sel);
    const rate = rateResolver();
    const result: ApprovalResult = { changed: 0, unchanged: 0, skipped: 0 };
    for (const row of rows) {
      if (row.status === "open") {
        result.skipped++;
        continue;
      }
      if (row.status !== "draft" && row.status !== "submitted") {
        result.unchanged++;
        continue;
      }
      const hourlyRate = rate(row.user_id, row.job_id, row.work_date)?.hourlyRate ?? null;
      db()
        .query(
          `UPDATE time_entries
              SET status = 'approved', approved_at = ?, approved_by = ?, rate_snapshot = ?, updated_at = ?,
                  sync_error = NULL, sync_failures = 0, sync_next_at = NULL
            WHERE id = ?`,
        )
        .run(now, sel.actorUserId, hourlyRate, now, row.id);
      audit({
        actorUserId: sel.actorUserId,
        entity: "entry",
        entityId: row.id,
        action: "approve",
        before: { status: row.status },
        after: { status: "approved", rate: hourlyRate },
        at: now,
      });
      result.changed++;
    }
    return result;
  })();
}

export function reopenEntries(sel: Selection & { actorUserId: number; now?: number }): ApprovalResult {
  const now = sel.now ?? Date.now();
  return db().transaction((): ApprovalResult => {
    const rows = select(sel);
    const result: ApprovalResult = { changed: 0, unchanged: 0, skipped: 0 };
    for (const row of rows) {
      if (row.status === "open" || row.status === "draft") {
        result.unchanged++;
        continue;
      }
      if (!REOPENABLE_STATUSES.has(row.status)) {
        result.skipped++;
        continue;
      }
      db()
        .query(
          `UPDATE time_entries
              SET status = 'draft', approved_at = NULL, approved_by = NULL, rate_snapshot = NULL, updated_at = ?,
                  sync_error = NULL, sync_failures = 0, sync_next_at = NULL
            WHERE id = ?`,
        )
        .run(now, row.id);
      audit({
        actorUserId: sel.actorUserId,
        entity: "entry",
        entityId: row.id,
        action: "reopen",
        before: { status: row.status, rate: row.rate_snapshot },
        after: { status: "draft" },
        at: now,
      });
      result.changed++;
    }
    return result;
  })();
}

/** "Approved 12 entries; 1 running timer was left for later." */
export function describeApproval(verb: "Approved" | "Reopened", r: ApprovalResult): string {
  const one = (count: number) => count === 1;
  const parts = [
    r.changed
      ? `${verb} ${r.changed} ${one(r.changed) ? "entry" : "entries"}.`
      : `Nothing to ${verb === "Approved" ? "approve" : "reopen"}.`,
  ];
  if (r.skipped && verb === "Approved") {
    parts.push(
      one(r.skipped)
        ? "A running timer was left out; approve again once it stops."
        : `${r.skipped} running timers were left out; approve again once they stop.`,
    );
  } else if (r.skipped) {
    parts.push(
      one(r.skipped)
        ? "One entry already sent to accounting was left as is."
        : `${r.skipped} entries already sent to accounting were left as is.`,
    );
  }
  return parts.join(" ");
}
