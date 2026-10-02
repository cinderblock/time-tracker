import type { FoundTime, Performed, SyncFailure, SyncRequest, TimeRecord } from "./accounting/types.ts";
import { audit } from "./audit.ts";
import { db } from "./db.server.ts";
import { type EntryStatus, sendableStatuses } from "./entry-status.ts";
import { QB_NAME_MAX_LENGTH } from "./accounting/qbxml.ts";
import { PATH_SEPARATOR } from "./job-names.ts";
import { applyPull, categoryPayrollItems } from "./remote-lists.ts";
import {
  defaultPayrollItemId,
  defaultServiceItemId,
  requireApproval,
  syncState,
  updateSyncState,
} from "./settings.ts";
import { reopenEntries } from "./approvals.ts";
import { OpError } from "./op-error.ts";

/**
 * Sending time to the accounting system.
 *
 * Nothing is queued: what needs doing is read from the tables every time
 * (`listWork`), so it can never disagree with them. A backend asks for the
 * next piece of work, marks it begun, carries it out, and hands the outcome
 * back; the outcome updates the rows, and with them the next answer.
 *
 * Work, in the order it's done:
 *   pull         refresh the job, people and item lists (when stale or asked)
 *   job.add      create a provisional job there, when an admin asked
 *   entry.delete remove the record of time deleted here after it was sent
 *   entry.find   look for a record whose send had an unknown outcome
 *   entry.check  before a first send, ask what is already there for that
 *                person, date and job (see "time that is already there")
 *   entry.add    send signed-off time
 *   entry.mod    send signed-off time that was sent before and taken back
 *
 * Time is signed off by its owner submitting it, and — where the organisation
 * requires it — by an admin approving that (`sendableSql`).
 *
 * Failures back off (a minute, doubling, up to six hours) and are shown to
 * admins; signed-off time that can't be sent yet (person not linked, job
 * provisional) isn't work at all — `syncOverview` lists it with the reason.
 */

export const PULL_EVERY_MS = 60 * 60_000;
const PULL_RETRY_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;

export type WorkKind = "pull" | "job.add" | "entry.delete" | "entry.find" | "entry.check" | "entry.add" | "entry.mod";

export interface Work {
  kind: WorkKind;
  /** Entry or job id; empty for a pull. */
  id: string;
  request: SyncRequest;
  /** For logs and admin pages: what this is about. */
  label: string;
  /** An `entry.check`: whose day is being asked about. The answer covers all their unsent time that day. */
  check?: { userId: number; txnDate: string; personRemoteId: string };
}

/**
 * The reference appended to every note sent, so a record whose send had an
 * unknown outcome can be found again rather than sent twice. The random tail
 * of the entry's UUID v7 (the head is a timestamp, shared by entries created
 * in the same millisecond).
 */
export function entryRef(entryId: string): string {
  return `[ref ${entryId.replace(/-/g, "").slice(-12)}]`;
}

export function backoff(failures: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
}

// ---- readiness ----------------------------------------------------------------------

interface EntryRow {
  id: string;
  user_id: number;
  job_id: string | null;
  work_date: string;
  duration_seconds: number;
  note: string | null;
  billable: number;
  status: EntryStatus;
  service_item_id: string | null;
  remote_txn_id: string | null;
  remote_edit_sequence: string | null;
  remote_deleted_at: number | null;
  sync_uncertain: string | null;
  sync_next_at: number | null;
  deleted_at: number | null;
  duplicate_check: string | null;
}

const ENTRY_COLUMNS =
  "id, user_id, job_id, work_date, duration_seconds, note, billable, status, service_item_id, remote_txn_id, remote_edit_sequence, remote_deleted_at, sync_uncertain, sync_next_at, deleted_at, duplicate_check";

/**
 * `status IN (…)` for time the sync may send as the organisation is set up
 * right now: submitted time, unless an admin's approval is required as well.
 * Interpolated rather than bound because the values come from a closed union
 * in entry-status.ts, never from anything a person typed.
 */
function sendableSql(): string {
  return `status IN (${sendableStatuses(requireApproval())
    .map((s) => `'${s}'`)
    .join(",")})`;
}

interface Lookups {
  people: Map<number, { name: string; remotePersonId: string | null; payrollItemId: string | null; categoryId: number | null }>;
  remotePeople: Map<string, { name: string; kind: string; active: boolean }>;
  items: Map<string, { kind: string; active: boolean; fullName: string }>;
  jobs: Map<string, { name: string; parentId: string | null; remoteId: string | null; remoteActive: boolean; serviceItemId: string | null; mergedInto: string | null; billable: boolean | null }>;
  categoryItems: Map<number, string | null>;
  defaultService: string | null;
  defaultPayroll: string | null;
}

function lookups(): Lookups {
  return {
    people: new Map(
      db()
        .query<{ id: number; name: string; remote_person_id: string | null; default_payroll_item_id: string | null; category_id: number | null }, []>(
          "SELECT id, name, remote_person_id, default_payroll_item_id, category_id FROM users",
        )
        .all()
        .map((r) => [r.id, { name: r.name, remotePersonId: r.remote_person_id, payrollItemId: r.default_payroll_item_id, categoryId: r.category_id }]),
    ),
    remotePeople: new Map(
      db()
        .query<{ id: string; name: string; kind: string; active: number }, []>("SELECT id, name, kind, active FROM remote_people")
        .all()
        .map((r) => [r.id, { name: r.name, kind: r.kind, active: r.active === 1 }]),
    ),
    items: new Map(
      db()
        .query<{ id: string; kind: string; active: number; full_name: string }, []>("SELECT id, kind, active, full_name FROM remote_items")
        .all()
        .map((r) => [r.id, { kind: r.kind, active: r.active === 1, fullName: r.full_name }]),
    ),
    jobs: new Map(
      db()
        .query<{ id: string; name: string; parent_id: string | null; remote_id: string | null; remote_active: number; default_service_item_id: string | null; merged_into: string | null; billable: number | null }, []>(
          "SELECT id, name, parent_id, remote_id, remote_active, default_service_item_id, merged_into, billable FROM jobs",
        )
        .all()
        .map((r) => [
          r.id,
          {
            name: r.name,
            parentId: r.parent_id,
            remoteId: r.remote_id,
            remoteActive: r.remote_active === 1,
            serviceItemId: r.default_service_item_id,
            mergedInto: r.merged_into,
            billable: r.billable == null ? null : r.billable === 1,
          },
        ]),
    ),
    categoryItems: categoryPayrollItems(),
    defaultService: defaultServiceItemId(),
    defaultPayroll: defaultPayrollItemId(),
  };
}

/** Why signed-off time can't be sent yet, and which kind of fix it needs. */
export interface NotReady {
  reason: string;
  fix: "person" | "job" | "item" | "entry";
}

function jobChain(l: Lookups, jobId: string | null) {
  const chain: NonNullable<ReturnType<Lookups["jobs"]["get"]>>[] = [];
  const seen = new Set<string>();
  for (let id = jobId; id && !seen.has(id); ) {
    seen.add(id);
    const job = l.jobs.get(id);
    if (!job) break;
    chain.push(job);
    id = job.parentId;
  }
  return chain;
}

/** The record an entry becomes, or why it can't be sent yet. */
function recordFor(e: EntryRow, l: Lookups): { record: TimeRecord } | NotReady {
  const person = l.people.get(e.user_id);
  const personName = person?.name ?? "This person";
  if (!person?.remotePersonId) {
    return { reason: `${personName} isn't linked to a name in the accounting system.`, fix: "person" };
  }
  const remotePerson = l.remotePeople.get(person.remotePersonId);
  if (!remotePerson) {
    return { reason: `${personName}'s linked name is no longer in the accounting system.`, fix: "person" };
  }
  if (!remotePerson.active) {
    return { reason: `${personName}'s name (${remotePerson.name}) is inactive in the accounting system.`, fix: "person" };
  }

  const chain = jobChain(l, e.job_id);
  const job = chain[0];
  if (e.job_id && !job) return { reason: "Its job no longer exists.", fix: "job" };
  // Named by where it sits, the way the Jobs page writes it.
  const jobName = chain
    .map((j) => j.name)
    .reverse()
    .join(PATH_SEPARATOR);
  if (job && !job.remoteId) {
    return { reason: `The job “${jobName}” was made here and isn't in the accounting system yet.`, fix: "job" };
  }
  if (job && !job.remoteActive) {
    return { reason: `The job “${jobName}” is inactive in the accounting system.`, fix: "job" };
  }

  const serviceItemId =
    e.service_item_id ?? chain.find((j) => j.serviceItemId)?.serviceItemId ?? l.defaultService ?? null;
  if (serviceItemId) {
    const item = l.items.get(serviceItemId);
    if (!item?.active) return { reason: "Its service item is no longer active in the accounting system.", fix: "item" };
  }

  // Only Employees take payroll items; the accounting system refuses them for anyone else.
  let payrollItemId: string | null = null;
  if (remotePerson.kind === "employee") {
    const categoryItem = person.categoryId != null ? l.categoryItems.get(person.categoryId) : undefined;
    payrollItemId = person.payrollItemId ?? categoryItem ?? l.defaultPayroll;
    if (payrollItemId && !l.items.get(payrollItemId)?.active) {
      return { reason: "Its payroll item is no longer active in the accounting system.", fix: "item" };
    }
  }

  const minutes = Math.round(e.duration_seconds / 60);
  if (minutes === 0) return { reason: "Less than a minute of time: nothing to send. Delete it or fix its times.", fix: "entry" };

  // The nearest answer up the tree; with none given, time is billable.
  const jobBillable = chain.find((j) => j.billable != null)?.billable ?? true;

  const ref = entryRef(e.id);
  const note = e.note?.trim() ?? "";
  return {
    record: {
      txnDate: e.work_date,
      personRemoteId: person.remotePersonId,
      jobRemoteId: job?.remoteId ?? null,
      serviceItemRemoteId: serviceItemId,
      payrollItemRemoteId: payrollItemId,
      minutes,
      notes: note ? `${note} ${ref}` : ref,
      billable: e.billable === 1 && jobBillable && Boolean(job) && Boolean(serviceItemId),
    },
  };
}

// ---- time that is already there ------------------------------------------------------
//
// An organisation moving over from another tracker runs both for a while, and
// the other one keeps feeding the same accounting system. So before an entry
// is sent for the first time, the sync asks what is already there for that
// person and date — one question per person and day, answering for all their
// unsent time that day. A record on the same job that this app didn't put
// there holds the entry until an admin says which it is: the same time (the
// entry takes the record over and amends it to match) or different time (both
// go). Hours and notes are not compared: two systems rarely agree on either.

export interface DuplicateFound {
  txnId: string;
  editSequence: string;
  minutes: number;
  notes: string;
}

/** What `time_entries.duplicate_check` holds. `key` is what was checked. */
type DuplicateCheck =
  | { state: "clear"; key: string; at: number }
  | { state: "held"; key: string; at: number; found: DuplicateFound[] }
  | { state: "separate"; key: string; at: number; by: number }
  | { state: "replaced"; key: string; at: number; by: number; txnId: string };

function duplicateCheckOf(row: { duplicate_check: string | null }): DuplicateCheck | null {
  return row.duplicate_check ? (JSON.parse(row.duplicate_check) as DuplicateCheck) : null;
}

/** An answer only stands for the date, person and job it was given about. */
const checkKey = (r: TimeRecord) => `${r.txnDate}|${r.personRemoteId}|${r.jobRemoteId ?? ""}`;

/** The check that applies to this record as it would be sent now, if it has had one. */
function currentCheck(row: { duplicate_check: string | null }, record: TimeRecord): DuplicateCheck | null {
  const check = duplicateCheckOf(row);
  return check && check.key === checkKey(record) ? check : null;
}

/** Whether a note carries one of this app's references (`entryRef`): such a record was sent from here. */
const sentFromHere = (notes: string) => notes.includes("[ref ");

function setDuplicateCheck(entryId: string, check: DuplicateCheck | null): void {
  db()
    .query("UPDATE time_entries SET duplicate_check = ? WHERE id = ?")
    .run(check ? JSON.stringify(check) : null, entryId);
}

/**
 * Judge what the accounting system has for one person's day against their
 * time that has yet to be sent for the first time: the entry asked about, and
 * any other that hasn't had an answer for what it is now.
 */
function applyCheck(askedFor: string, asked: NonNullable<Work["check"]>, records: FoundTime[], now: number): void {
  const l = lookups();
  const rows = db()
    .query<EntryRow, [number, string]>(
      `SELECT ${ENTRY_COLUMNS} FROM time_entries
        WHERE user_id = ? AND work_date = ? AND deleted_at IS NULL AND ${sendableSql()}
          AND (remote_txn_id IS NULL OR remote_deleted_at IS NOT NULL) AND sync_uncertain IS NULL`,
    )
    .all(asked.userId, asked.txnDate);
  const standsFor = db().query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM time_entries WHERE remote_txn_id = ?");
  for (const row of rows) {
    const built = recordFor(row, l);
    if (!("record" in built) || built.record.personRemoteId !== asked.personRemoteId || built.record.txnDate !== asked.txnDate) continue;
    if (row.id !== askedFor && currentCheck(row, built.record)) continue; // already answered
    const key = checkKey(built.record);
    const mine = records.find((r) => r.notes.includes(entryRef(row.id)));
    if (mine) {
      // It's there already, from a send whose outcome was never recorded. Adopt it.
      db()
        .query("UPDATE time_entries SET remote_txn_id = ?, remote_edit_sequence = ?, remote_deleted_at = NULL WHERE id = ?")
        .run(mine.txnId, mine.editSequence, row.id);
      setDuplicateCheck(row.id, { state: "clear", key, at: now });
      continue;
    }
    const found = records.filter(
      (r) => r.jobRemoteId === built.record.jobRemoteId && !sentFromHere(r.notes) && standsFor.get(r.txnId)!.n === 0,
    );
    setDuplicateCheck(
      row.id,
      found.length
        ? {
            state: "held",
            key,
            at: now,
            found: found.map((r) => ({ txnId: r.txnId, editSequence: r.editSequence, minutes: r.minutes, notes: r.notes })),
          }
        : { state: "clear", key, at: now },
    );
  }
}

/**
 * This person's entries waiting on an answer about time the accounting
 * system already has: by entry id, with what was found. Whatever the entry's
 * status — the screen decides when it matters — so a day taken back and
 * submitted again shows the same thing without asking again.
 */
export function heldEntries(userId: number): Map<string, { workDate: string; status: EntryStatus; found: DuplicateFound[] }> {
  const l = lookups();
  const rows = db()
    .query<EntryRow, [number]>(
      `SELECT ${ENTRY_COLUMNS} FROM time_entries
        WHERE user_id = ? AND deleted_at IS NULL AND json_extract(duplicate_check, '$.state') = 'held'`,
    )
    .all(userId);
  const held = new Map<string, { workDate: string; status: EntryStatus; found: DuplicateFound[] }>();
  for (const row of rows) {
    if (row.remote_txn_id != null && row.remote_deleted_at == null) continue;
    const built = recordFor(row, l);
    if (!("record" in built)) continue;
    const check = currentCheck(row, built.record);
    if (check?.state === "held") held.set(row.id, { workDate: row.work_date, status: row.status, found: check.found });
  }
  return held;
}

/**
 * An answer about a held entry. Rejections are OpErrors: this is reached as
 * an op from the person's own day (`duplicate.resolve`) and from the admin
 * page, which turns them into its own kind of refusal.
 *
 *   replace   it is the same time: this entry takes the record over, and the
 *             next pass amends it to match
 *   discard   it is the same time, and the record there is right: this entry
 *             is deleted here (the person's own submission is taken back
 *             first; an admin's approval stops it, as it stops any reopening)
 *   separate  it is different time: both go
 *   recheck   look again, after fixing it in the accounting system by hand
 */
export function resolveDuplicate(args: {
  entryId: string;
  action: "replace" | "discard" | "separate" | "recheck";
  /** For `replace`: which of the records found. */
  txnId?: string;
  /** Whose time it is, when the answer comes from them: the entry must be theirs. */
  userId?: number;
  actorUserId: number;
  now?: number;
}): void {
  const now = args.now ?? Date.now();
  db().transaction(() => {
    const row = db()
      .query<
        { user_id: number; duplicate_check: string | null; deleted_at: number | null; status: EntryStatus; approved_by: number | null },
        [string]
      >("SELECT user_id, duplicate_check, deleted_at, status, approved_by FROM time_entries WHERE id = ?")
      .get(args.entryId);
    if (!row || row.deleted_at != null || (args.userId != null && row.user_id !== args.userId)) {
      throw new OpError("not_found", "That entry no longer exists.");
    }
    const check = duplicateCheckOf(row);
    if (check?.state !== "held") throw new OpError("conflict", "That entry isn't waiting on this any more.");
    const event = (action: string, detail: { before?: unknown; after?: unknown }) =>
      audit({ actorUserId: args.actorUserId, entity: "entry", entityId: args.entryId, action, at: now, ...detail });

    switch (args.action) {
      case "separate":
        setDuplicateCheck(args.entryId, { state: "separate", key: check.key, at: now, by: args.actorUserId });
        event("duplicate_separate", { before: { found: check.found } });
        return;

      case "recheck":
        setDuplicateCheck(args.entryId, null);
        event("duplicate_recheck", { before: { found: check.found } });
        return;

      case "discard": {
        const own = args.userId != null && args.userId === args.actorUserId;
        if (own && row.approved_by != null) {
          throw new OpError("conflict", "An admin has approved this time, so only an admin can delete it. Ask them.");
        }
        reopenEntries({ userId: row.user_id, entryIds: [args.entryId], actorUserId: args.actorUserId, now, ownSubmissionsOnly: own });
        db().query("UPDATE time_entries SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, args.entryId);
        event("duplicate_discard", { before: { status: row.status, found: check.found } });
        return;
      }

      case "replace": {
        const found = check.found.find((f) => f.txnId === args.txnId);
        if (!found) throw new OpError("not_found", "That record isn't one of those found. Check again.");
        const taken = db()
          .query<{ id: string }, [string, string]>("SELECT id FROM time_entries WHERE remote_txn_id = ? AND id != ?")
          .get(found.txnId, args.entryId);
        if (taken) {
          throw new OpError("conflict", "Another entry here already stands for that record. Check again, or send this one as well.");
        }
        // Adopt it; the next pass amends it to match exactly.
        db()
          .query("UPDATE time_entries SET remote_txn_id = ?, remote_edit_sequence = ?, remote_deleted_at = NULL WHERE id = ?")
          .run(found.txnId, found.editSequence, args.entryId);
        setDuplicateCheck(args.entryId, { state: "replaced", key: check.key, at: now, by: args.actorUserId, txnId: found.txnId });
        event("duplicate_replace", { after: { found } });
        return;
      }
    }
  })();
}

/** Ask again about every held entry, after fixing things in the accounting system by hand. */
export function recheckDuplicates(): number {
  return db()
    .query(
      "UPDATE time_entries SET duplicate_check = NULL WHERE json_extract(duplicate_check, '$.state') = 'held' AND deleted_at IS NULL",
    )
    .run().changes;
}

// ---- the work list ------------------------------------------------------------------

type Uncertain = { txnDate: string; personRemoteId: string } | { txnId: string };

function uncertainOf(row: EntryRow): Uncertain | null {
  return row.sync_uncertain ? (JSON.parse(row.sync_uncertain) as Uncertain) : null;
}

function pullDue(now: number): boolean {
  const s = syncState();
  if (s.lastPullAttemptAt != null && now - s.lastPullAttemptAt < PULL_RETRY_MS && (s.lastPullAt ?? 0) < s.lastPullAttemptAt) {
    return false; // the last attempt failed recently
  }
  if (s.lastPullAt == null) return true;
  if (s.pullRequestedAt != null && s.pullRequestedAt > s.lastPullAt) return true;
  return now - s.lastPullAt >= PULL_EVERY_MS;
}

const due = (next: number | null, now: number) => next == null || next <= now;

/** Everything that can be done now, in order. */
export function listWork(now: number = Date.now()): Work[] {
  const work: Work[] = [];
  if (pullDue(now)) work.push({ kind: "pull", id: "", request: { type: "pull" }, label: "Refresh jobs, people and items" });

  const l = lookups();

  const jobs = db()
    .query<{ id: string; name: string; parent_id: string | null; sync_next_at: number | null }, []>(
      `SELECT id, name, parent_id, sync_next_at FROM jobs
        WHERE create_requested_at IS NOT NULL AND remote_id IS NULL AND merged_into IS NULL
        ORDER BY create_requested_at`,
    )
    .all();
  for (const j of jobs) {
    if (!due(j.sync_next_at, now) || j.name.length > QB_NAME_MAX_LENGTH) continue;
    const parent = j.parent_id ? l.jobs.get(j.parent_id) : null;
    if (j.parent_id && !parent?.remoteId) continue; // the parent goes first
    work.push({
      kind: "job.add",
      id: j.id,
      request: { type: "job.add", name: j.name, parentRemoteId: parent?.remoteId ?? null },
      label: `Create job “${j.name}”`,
    });
  }

  const rows = db()
    .query<EntryRow, []>(
      `SELECT ${ENTRY_COLUMNS} FROM time_entries
        WHERE (deleted_at IS NOT NULL
                AND ((remote_txn_id IS NOT NULL AND remote_deleted_at IS NULL) OR sync_uncertain IS NOT NULL))
           OR (deleted_at IS NULL AND ${sendableSql()})
        ORDER BY work_date, id`,
    )
    .all();
  const deletes: Work[] = [];
  const finds: Work[] = [];
  const sends: Work[] = [];
  for (const row of rows) {
    if (!due(row.sync_next_at, now)) continue;
    const who = l.people.get(row.user_id)?.name ?? "someone";
    const label = `${who}, ${row.work_date}`;
    const uncertain = uncertainOf(row);
    if (uncertain) {
      // Whether it's to be sent or removed, first learn whether it's there.
      finds.push({ kind: "entry.find", id: row.id, request: { type: "time.find", by: uncertain }, label });
      continue;
    }
    if (row.deleted_at != null) {
      deletes.push({ kind: "entry.delete", id: row.id, request: { type: "time.delete", txnId: row.remote_txn_id! }, label });
      continue;
    }
    const built = recordFor(row, l);
    if (!("record" in built)) continue;
    const hasRemote = row.remote_txn_id != null && row.remote_deleted_at == null;
    if (!hasRemote) {
      // A first send: learn what's already there before adding to it.
      const check = currentCheck(row, built.record);
      if (!check) {
        const { txnDate, personRemoteId } = built.record;
        sends.push({
          kind: "entry.check",
          id: row.id,
          request: { type: "time.find", by: { txnDate, personRemoteId } },
          label,
          check: { userId: row.user_id, txnDate, personRemoteId },
        });
        continue;
      }
      if (check.state === "held") continue; // waits for an admin
    }
    sends.push(
      hasRemote
        ? {
            kind: "entry.mod",
            id: row.id,
            request: { type: "time.mod", txnId: row.remote_txn_id!, editSequence: row.remote_edit_sequence ?? "", record: built.record },
            label,
          }
        : { kind: "entry.add", id: row.id, request: { type: "time.add", record: built.record }, label },
    );
  }
  return [...work, ...deletes, ...finds, ...sends];
}

export function nextWork(now: number = Date.now()): Work | null {
  return listWork(now)[0] ?? null;
}

// ---- carrying it out ----------------------------------------------------------------

/**
 * Call just before sending. An add is marked uncertain until its outcome is
 * known: if the answer never arrives, the next attempt looks for the record
 * instead of adding a second one.
 */
export function beginWork(work: Work, now: number = Date.now()): void {
  if (work.kind === "pull") updateSyncState({ lastPullAttemptAt: now });
  if (work.request.type === "time.add") {
    const { txnDate, personRemoteId } = work.request.record;
    db()
      .query("UPDATE time_entries SET sync_uncertain = ? WHERE id = ?")
      .run(JSON.stringify({ txnDate, personRemoteId }), work.id);
  }
}

function logAttempt(backend: string, work: Work, ok: boolean, now: number, detail: { request?: string; response?: string; error?: string }) {
  const clip = (s: string | undefined) => (s == null ? null : s.length > 200_000 ? `${s.slice(0, 200_000)}…` : s);
  db()
    .query(
      `INSERT INTO sync_attempts (backend, work, entry_id, job_id, at, ok, request, response, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      backend,
      work.kind,
      work.kind.startsWith("entry.") ? work.id : null,
      work.kind === "job.add" ? work.id : null,
      now,
      ok ? 1 : 0,
      clip(detail.request),
      clip(detail.response),
      detail.error ?? null,
    );
}

function failEntry(id: string, failure: SyncFailure, now: number, opts: { keepStatus?: boolean } = {}): void {
  const row = db().query<{ sync_failures: number }, [string]>("SELECT sync_failures FROM time_entries WHERE id = ?").get(id);
  const failures = (row?.sync_failures ?? 0) + 1;
  const wait = failure.retryable ? 60_000 : backoff(failures);
  db()
    .query(
      `UPDATE time_entries SET sync_error = ?, sync_failures = ?, sync_next_at = ?
         ${opts.keepStatus ? "" : ", status = 'sync_failed'"}
       WHERE id = ?`,
    )
    .run(failure.message, failures, now + wait, id);
}

/** Apply the outcome of a request that got an answer. */
export function finishWork(backend: string, work: Work, performed: Performed, now: number = Date.now()): void {
  const { result } = performed;
  db().transaction(() => {
    logAttempt(backend, work, result.ok, now, {
      request: performed.request,
      response: performed.response,
      error: result.ok ? undefined : `${result.code}: ${result.message}`,
    });

    switch (work.kind) {
      case "pull":
        if (result.ok && result.type === "pull") {
          applyPull(result.lists, now);
          db().query("DELETE FROM sync_attempts WHERE at < ?").run(now - 90 * 24 * 60 * 60_000);
        }
        return;

      case "job.add":
        if (result.ok && result.type === "job.added") {
          db()
            .query(
              `UPDATE jobs SET remote_id = ?, remote_full_name = ?, remote_active = 1, provisional = 0,
                      create_requested_at = NULL, sync_error = NULL, sync_next_at = NULL, updated_at = ?
                WHERE id = ?`,
            )
            .run(result.job.remoteId, result.job.fullName, now, work.id);
          audit({ actorUserId: null, entity: "job", entityId: work.id, action: "created_remote", after: result.job, at: now });
        } else if (!result.ok && result.duplicate) {
          db()
            .query("UPDATE jobs SET create_requested_at = NULL, sync_error = ?, updated_at = ? WHERE id = ?")
            .run("The accounting system already has a job with this name there. Link this job to it instead.", now, work.id);
        } else if (!result.ok) {
          const failures = (db().query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM sync_attempts WHERE job_id = ? AND ok = 0",
          ).get(work.id)?.n ?? 1);
          db()
            .query("UPDATE jobs SET sync_error = ?, sync_next_at = ? WHERE id = ?")
            .run(result.message, now + (result.retryable ? 60_000 : backoff(failures)), work.id);
        }
        return;

      case "entry.delete":
        if (result.ok || result.missing) {
          db()
            .query("UPDATE time_entries SET remote_deleted_at = ?, sync_error = NULL, sync_failures = 0, sync_next_at = NULL WHERE id = ?")
            .run(now, work.id);
        } else {
          failEntry(work.id, result, now, { keepStatus: true });
        }
        return;

      case "entry.find": {
        if (!result.ok) {
          failEntry(work.id, result, now);
          return;
        }
        if (result.type !== "time.found") return;
        const ref = entryRef(work.id);
        const askedId = work.request.type === "time.find" && "txnId" in work.request.by ? work.request.by.txnId : null;
        const byId = askedId != null;
        // Asked for by id, the record is the one whatever its note says: it
        // may have been edited there, or taken over from another tracker and
        // not amended yet. Asked for by day, only our reference identifies it.
        const match = result.records.find((r) => (byId ? r.txnId === askedId : r.notes.includes(ref)));
        if (match) {
          // Adopt it; the next pass amends it to match exactly.
          db()
            .query(
              `UPDATE time_entries SET remote_txn_id = ?, remote_edit_sequence = ?, remote_deleted_at = NULL,
                      sync_uncertain = NULL WHERE id = ?`,
            )
            .run(match.txnId, match.editSequence, work.id);
        } else if (byId) {
          // Gone from the accounting system: send it afresh.
          db()
            .query("UPDATE time_entries SET remote_txn_id = NULL, remote_edit_sequence = NULL, sync_uncertain = NULL WHERE id = ?")
            .run(work.id);
        } else {
          // Never arrived: send it.
          db().query("UPDATE time_entries SET sync_uncertain = NULL WHERE id = ?").run(work.id);
        }
        return;
      }

      case "entry.check": {
        if (!result.ok) {
          failEntry(work.id, result, now);
          return;
        }
        if (result.type !== "time.found" || !work.check) return;
        db().query("UPDATE time_entries SET sync_error = NULL, sync_failures = 0, sync_next_at = NULL WHERE id = ?").run(work.id);
        applyCheck(work.id, work.check, result.records, now);
        return;
      }

      case "entry.add":
      case "entry.mod":
        if (result.ok && result.type === "time.saved") {
          db()
            .query(
              `UPDATE time_entries SET status = 'synced', remote_txn_id = ?, remote_edit_sequence = ?, synced_at = ?,
                      remote_deleted_at = NULL, sync_uncertain = NULL, sync_error = NULL, sync_failures = 0,
                      sync_next_at = NULL
                WHERE id = ?`,
            )
            .run(result.txnId, result.editSequence, now, work.id);
          return;
        }
        if (result.ok) return;
        if (work.kind === "entry.add") {
          // An answer came back, so nothing was added.
          db().query("UPDATE time_entries SET sync_uncertain = NULL WHERE id = ?").run(work.id);
        }
        if (work.kind === "entry.mod" && result.missing) {
          // Deleted there: add it again on the next pass.
          db()
            .query("UPDATE time_entries SET remote_txn_id = NULL, remote_edit_sequence = NULL WHERE id = ?")
            .run(work.id);
          return;
        }
        if (work.kind === "entry.mod" && result.stale && work.request.type === "time.mod") {
          // Changed there since we last saw it: fetch its current version first.
          db()
            .query("UPDATE time_entries SET sync_uncertain = ? WHERE id = ?")
            .run(JSON.stringify({ txnId: work.request.txnId }), work.id);
          const row = db().query<{ sync_failures: number }, [string]>("SELECT sync_failures FROM time_entries WHERE id = ?").get(work.id);
          // Three conflicts in a row means someone keeps editing it there; slow down.
          if ((row?.sync_failures ?? 0) >= 2) failEntry(work.id, result, now);
          else db().query("UPDATE time_entries SET sync_failures = sync_failures + 1 WHERE id = ?").run(work.id);
          return;
        }
        failEntry(work.id, result, now);
        return;
    }
  })();
}

/**
 * The accounting system couldn't be reached. Nothing about the work itself
 * is recorded against it — being unreachable is normal — but an add that may
 * have been sent stays uncertain (see beginWork).
 */
export function workUnreachable(backend: string, work: Work, detail: string, now: number = Date.now()): void {
  logAttempt(backend, work, false, now, { error: detail });
}

export function recordContact(ok: boolean, detail: string, now: number = Date.now()): void {
  updateSyncState({ lastContactAt: now, lastContactOk: ok, lastContactDetail: detail });
}

// ---- overview -----------------------------------------------------------------------

export interface SyncOverview {
  /** Signed off and ready: sent at the next contact. */
  ready: number;
  /** Signed off, but something must be fixed first. */
  blocked: { entryId: string; userId: number; person: string; workDate: string; minutes: number; reason: string; fix: NotReady["fix"] }[];
  /** Tried and refused; retried automatically. */
  failed: { entryId: string; person: string; workDate: string; minutes: number; error: string; retryAt: number | null }[];
  /** Sent, then taken back: the accounting system has the old values until it's signed off again. */
  reopened: { entryId: string; person: string; workDate: string }[];
  /** Held: the accounting system already has time for this person, date and job that didn't come from here. */
  duplicates: {
    entryId: string;
    userId: number;
    person: string;
    workDate: string;
    minutes: number;
    /** "Customer:Job", as stored. */
    job: string;
    note: string;
    found: { txnId: string; minutes: number; notes: string }[];
  }[];
  sent: number;
  jobsToCreate: { jobId: string; name: string; error: string | null }[];
  recent: { at: number; work: string; ok: boolean; error: string | null }[];
}

export function syncOverview(now: number = Date.now()): SyncOverview {
  const l = lookups();
  const rows = db()
    .query<EntryRow & { sync_error: string | null }, []>(
      `SELECT ${ENTRY_COLUMNS}, sync_error FROM time_entries
        WHERE deleted_at IS NULL AND (${sendableSql()} OR (status IN ('draft','open') AND remote_txn_id IS NOT NULL AND remote_deleted_at IS NULL))
        ORDER BY work_date, id`,
    )
    .all();
  const overview: SyncOverview = {
    ready: 0,
    blocked: [],
    failed: [],
    reopened: [],
    duplicates: [],
    sent: db().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM time_entries WHERE status = 'synced' AND deleted_at IS NULL").get()!.n,
    jobsToCreate: db()
      .query<{ id: string; name: string; sync_error: string | null }, []>(
        `SELECT id, name, sync_error FROM jobs
          WHERE merged_into IS NULL AND remote_id IS NULL AND (create_requested_at IS NOT NULL OR sync_error IS NOT NULL)
          ORDER BY name`,
      )
      .all()
      .map((j) => ({ jobId: j.id, name: j.name, error: j.sync_error })),
    recent: db()
      .query<{ at: number; work: string; ok: number; error: string | null }, []>(
        "SELECT at, work, ok, error FROM sync_attempts ORDER BY id DESC LIMIT 20",
      )
      .all()
      .map((r) => ({ at: r.at, work: r.work, ok: r.ok === 1, error: r.error })),
  };
  for (const row of rows) {
    const person = l.people.get(row.user_id)?.name ?? "Someone";
    const minutes = Math.round(row.duration_seconds / 60);
    if (row.status === "draft" || row.status === "open") {
      overview.reopened.push({ entryId: row.id, person, workDate: row.work_date });
      continue;
    }
    const built = recordFor(row, l);
    const hasRemote = row.remote_txn_id != null && row.remote_deleted_at == null;
    const check = "record" in built && !hasRemote ? currentCheck(row, built.record) : null;
    if (check?.state === "held") {
      overview.duplicates.push({
        entryId: row.id,
        userId: row.user_id,
        person,
        workDate: row.work_date,
        minutes,
        job: jobChain(l, row.job_id)
          .map((j) => j.name)
          .reverse()
          .join(":"),
        note: row.note?.trim() ?? "",
        found: check.found.map((f) => ({ txnId: f.txnId, minutes: f.minutes, notes: f.notes })),
      });
      continue;
    }
    if (row.status === "sync_failed") {
      overview.failed.push({
        entryId: row.id,
        person,
        workDate: row.work_date,
        minutes,
        error: row.sync_error ?? "Refused",
        retryAt: row.sync_next_at != null && row.sync_next_at > now ? row.sync_next_at : null,
      });
      continue;
    }
    if ("record" in built) overview.ready++;
    else overview.blocked.push({ entryId: row.id, userId: row.user_id, person, workDate: row.work_date, minutes, ...built });
  }
  return overview;
}

/** Try failed entries again now rather than at their scheduled time. */
export function retryFailedNow(): number {
  return db().query("UPDATE time_entries SET sync_next_at = NULL WHERE status = 'sync_failed' AND deleted_at IS NULL").run().changes;
}
