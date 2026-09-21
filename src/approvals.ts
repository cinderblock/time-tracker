import { audit } from "./audit.ts";
import { db } from "./db.server.ts";
import { type EntryStatus, REOPENABLE_STATUSES } from "./entry-status.ts";
import { rateResolver } from "./rates.ts";
import { UserInputError } from "./users.ts";

/**
 * Signing time off: submitting, approving, and taking it back.
 *
 * **Submitting** is the person saying their time is done. It copies the rate in
 * effect onto each entry, so later rate changes never rewrite submitted time,
 * and locks the entry. Unless the organisation requires approval, submitting is
 * also what makes time eligible to send to the accounting system.
 *
 * **Approving** is an admin signing off submitted time, and only happens where
 * the `require_approval` setting is on. It is the second gate, not the first.
 *
 * **Taking it back** puts time back to draft so it can be corrected. A person
 * may take back their own submission; once an admin has approved it, only an
 * admin can reopen it. Running timers are never signed off — they're skipped
 * and reported, and signing off again after they stop picks them up. Time
 * already sent keeps its link to the accounting system's record: submitting it
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
  approved_by: number | null;
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
      `SELECT id, user_id, job_id, work_date, status, rate_snapshot, approved_by FROM time_entries
        WHERE ${where.join(" AND ")} ORDER BY work_date, id`,
    )
    .all(...params);
}

export interface SignOffResult {
  /** Entries whose state changed. */
  changed: number;
  /** Entries left alone because they were already in the target state. */
  unchanged: number;
  /** Entries that couldn't change (running timers; someone else's sign-off). */
  skipped: number;
}

/** Clears the sync's retry bookkeeping — any change re-queues the entry from scratch. */
const RESET_SYNC = "sync_error = NULL, sync_failures = 0, sync_next_at = NULL";

/**
 * The person says this time is done: freeze its rate and lock it. Where
 * approval isn't required, this is what hands it to the accounting system.
 */
export function submitEntries(sel: Selection & { actorUserId: number; now?: number }): SignOffResult {
  const now = sel.now ?? Date.now();
  return db().transaction((): SignOffResult => {
    const rows = select(sel);
    const rate = rateResolver();
    const result: SignOffResult = { changed: 0, unchanged: 0, skipped: 0 };
    for (const row of rows) {
      if (row.status === "open") {
        result.skipped++;
        continue;
      }
      if (row.status !== "draft") {
        result.unchanged++;
        continue;
      }
      const hourlyRate = rate(row.user_id, row.job_id, row.work_date)?.hourlyRate ?? null;
      db()
        .query(
          `UPDATE time_entries
              SET status = 'submitted', submitted_at = ?, submitted_by = ?, rate_snapshot = ?, updated_at = ?,
                  ${RESET_SYNC}
            WHERE id = ?`,
        )
        .run(now, sel.actorUserId, hourlyRate, now, row.id);
      audit({
        actorUserId: sel.actorUserId,
        entity: "entry",
        entityId: row.id,
        action: "submit",
        before: { status: row.status },
        after: { status: "submitted", rate: hourlyRate },
        at: now,
      });
      result.changed++;
    }
    return result;
  })();
}

/**
 * An admin signs off submitted time. Draft time is accepted too and counts as
 * submitted on the person's behalf, so an admin never has to do it in two
 * steps. A rate already frozen by the submission is kept, not recomputed.
 */
export function approveEntries(sel: Selection & { actorUserId: number; now?: number }): SignOffResult {
  const now = sel.now ?? Date.now();
  return db().transaction((): SignOffResult => {
    const rows = select(sel);
    const rate = rateResolver();
    const result: SignOffResult = { changed: 0, unchanged: 0, skipped: 0 };
    for (const row of rows) {
      if (row.status === "open") {
        result.skipped++;
        continue;
      }
      if (row.status !== "draft" && row.status !== "submitted") {
        result.unchanged++;
        continue;
      }
      const hourlyRate =
        row.rate_snapshot ?? rate(row.user_id, row.job_id, row.work_date)?.hourlyRate ?? null;
      db()
        .query(
          `UPDATE time_entries
              SET status = 'approved', approved_at = ?, approved_by = ?, rate_snapshot = ?, updated_at = ?,
                  submitted_at = COALESCE(submitted_at, ?), submitted_by = COALESCE(submitted_by, ?),
                  ${RESET_SYNC}
            WHERE id = ?`,
        )
        .run(now, sel.actorUserId, hourlyRate, now, now, sel.actorUserId, row.id);
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

/**
 * Put signed-off time back to draft.
 *
 * `ownSubmissionsOnly` is the person taking back their own time: entries an
 * admin has approved are left alone for them to reopen. Without it this is the
 * admin's reopen, which takes back anything.
 */
export function reopenEntries(
  sel: Selection & { actorUserId: number; now?: number; ownSubmissionsOnly?: boolean },
): SignOffResult {
  const now = sel.now ?? Date.now();
  return db().transaction((): SignOffResult => {
    const rows = select(sel);
    const result: SignOffResult = { changed: 0, unchanged: 0, skipped: 0 };
    for (const row of rows) {
      if (row.status === "open" || row.status === "draft") {
        result.unchanged++;
        continue;
      }
      if (!REOPENABLE_STATUSES.has(row.status) || (sel.ownSubmissionsOnly && row.approved_by != null)) {
        result.skipped++;
        continue;
      }
      db()
        .query(
          `UPDATE time_entries
              SET status = 'draft', submitted_at = NULL, submitted_by = NULL,
                  approved_at = NULL, approved_by = NULL, rate_snapshot = NULL, updated_at = ?,
                  ${RESET_SYNC}
            WHERE id = ?`,
        )
        .run(now, row.id);
      audit({
        actorUserId: sel.actorUserId,
        entity: "entry",
        entityId: row.id,
        action: sel.ownSubmissionsOnly ? "unsubmit" : "reopen",
        before: { status: row.status, rate: row.rate_snapshot },
        after: { status: "draft" },
        at: now,
      });
      result.changed++;
    }
    return result;
  })();
}

/** Which sign-off happened, for the sentence describing it. */
export type SignOff = "submit" | "approve" | "reopen" | "take-back";

const WORDS: Record<SignOff, { done: string; nothing: string; again: string }> = {
  submit: { done: "Submitted", nothing: "Nothing to submit.", again: "submit" },
  approve: { done: "Approved", nothing: "Nothing to approve.", again: "approve" },
  reopen: { done: "Reopened", nothing: "Nothing to reopen.", again: "reopen" },
  "take-back": { done: "Took back", nothing: "Nothing to take back.", again: "take back" },
};

/** "Submitted 12 entries; 1 running timer was left for later." */
export function describeSignOff(what: SignOff, r: SignOffResult): string {
  const words = WORDS[what];
  const one = (count: number) => count === 1;
  const parts = [
    r.changed ? `${words.done} ${r.changed} ${one(r.changed) ? "entry" : "entries"}.` : words.nothing,
  ];
  if (!r.skipped) return parts.join(" ");
  if (what === "submit" || what === "approve") {
    parts.push(
      one(r.skipped)
        ? `A running timer was left out; ${words.again} again once it stops.`
        : `${r.skipped} running timers were left out; ${words.again} again once they stop.`,
    );
  } else {
    parts.push(
      one(r.skipped)
        ? "One entry an admin has approved was left as it is."
        : `${r.skipped} entries an admin has approved were left as they are.`,
    );
  }
  return parts.join(" ");
}
