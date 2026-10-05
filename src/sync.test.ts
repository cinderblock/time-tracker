import { beforeEach, describe, expect, test } from "bun:test";

import { QbBridgeBackend } from "./accounting/qb-bridge.ts";
import { approveEntries, reopenEntries, submitEntries } from "./approvals.ts";
import { createCategory, setUserCategory } from "./categories.ts";
import { db } from "./db.server.ts";
import { getEntry } from "./entries.ts";
import { getJob, listJobs, resolveJob, updateJob } from "./jobs.ts";
import { listNotesForDate, pendingNotesBefore } from "./notes.ts";
import { applyOp } from "./ops.ts";
import type { OpPayload, OpResult, OpType } from "./ops-schema.ts";
import {
  linkJob,
  linkPerson,
  listRemoteItems,
  listRemotePeople,
  requestJobCreation,
  requestPull,
  setCategoryPayrollItem,
  setJobServiceItem,
  setPersonPayrollItem,
} from "./remote-lists.ts";
import { setDefaultPayrollItemId, setDefaultServiceItemId, setRequireApproval, syncState } from "./settings.ts";
import { PULL_EVERY_MS, heldEntries, listWork, recheckDuplicates, resolveDuplicate, retryFailedNow, syncOverview } from "./sync.ts";
import { runSync } from "./sync-worker.ts";
import { fakeBridgeFetch } from "./testing/fake-bridge.ts";
import { type FakeQuickBooks, sampleCompany } from "./testing/fake-quickbooks.ts";
import { freshDb } from "./testing/db.ts";
import { createUser } from "./users.ts";
import { uuidv7 } from "./uuid.ts";

const MIN = 60_000;
const NINE = Date.parse("2026-09-16T16:00:00Z"); // 09:00 in Los Angeles
const DAY = "2026-09-16";

let qb: FakeQuickBooks;
let down = false;
let noEndpoint = false;
let shadowed = false;
let now = NINE;
let backend: QbBridgeBackend;
let admin = 0;
let alice = 0; // an Employee in QuickBooks
let bob = 0; // a Vendor
let walkIn = "";
let local = "";

beforeEach(() => {
  process.env.TZ = "America/Los_Angeles";
  freshDb();
  qb = sampleCompany();
  down = false;
  noEndpoint = false;
  shadowed = false;
  now = NINE;
  backend = new QbBridgeBackend({
    baseUrl: "http://bridge.test",
    apiKey: "secret",
    fetch: fakeBridgeFetch(qb, {
      apiKey: "secret",
      down: () => down,
      noTimeTracking: () => noEndpoint,
      shadowedServiceItems: () => shadowed,
    }),
  });
  admin = createUser({ name: "Ada", role: "admin", actorUserId: null }).id;
  alice = createUser({ name: "Alice", role: "employee", actorUserId: admin }).id;
  bob = createUser({ name: "Bob", role: "employee", actorUserId: admin }).id;
  // A customer and a job made here, ahead of the accounting system.
  walkIn = uuidv7();
  local = uuidv7();
  ok(send(admin, "job.create", { jobId: walkIn, name: "Walk-in" }));
  ok(send(admin, "job.create", { jobId: local, name: "Repair", parentId: walkIn }));
});

const sync = () => runSync(backend, () => now);

function send<T extends OpType>(as: number, type: T, payload: OpPayload<T>): OpResult {
  return applyOp(as, { opId: uuidv7(), type, deviceId: "t", clientTime: now, payload }, now);
}

function ok(result: OpResult): OpResult {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result;
}

const jobByRemote = (remoteId: string) => listJobs({ includeInactive: true }).find((j) => j.remoteId === remoteId)!;

function work(userId: number, jobId: string, minutes: number, note: string | null = "Framing", start = NINE): string {
  const entryId = uuidv7();
  ok(send(userId, "entry.create", { entryId, jobId, startedAt: start, endedAt: start + minutes * MIN, note }));
  return entryId;
}

/** The same time of day, a day later: another day's line. */
const NEXT_DAY = NINE + 24 * 60 * MIN;

/**
 * A second line for a job and day, as days from before one line per job can
 * have them — written straight to the table, since no op makes one now.
 */
function legacy(userId: number, jobId: string, minutes: number, note: string, start: number): string {
  const id = uuidv7();
  db()
    .query(
      `INSERT INTO time_entries
         (id, user_id, job_id, work_date, duration_seconds, untimed_seconds, note, source, status,
          device_id, client_created_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 'manual', 'draft', 'old-device', ?, ?, ?)`,
    )
    .run(id, userId, jobId, DAY, minutes * 60, note, start, now, now);
  db().query("INSERT INTO time_segments (entry_id, started_at, ended_at) VALUES (?, ?, ?)").run(id, start, start + minutes * MIN);
  return id;
}

/** Pull, link Alice and Bob, set a default service and payroll item. */
async function connected() {
  expect((await sync()).reached).toBe(true);
  linkPerson({ userId: alice, remoteId: "E-ALICE", actorUserId: admin });
  linkPerson({ userId: bob, remoteId: "V-SUB", actorUserId: admin });
  setDefaultServiceItemId("I-LABOR", admin);
  setDefaultPayrollItemId("W-HOURLY", admin);
}

describe("pulling lists", () => {
  test("jobs, people and items arrive; jobs follow the accounting system", async () => {
    const summary = await sync();
    expect(summary).toMatchObject({ reached: true, done: 1 });
    const acme = jobByRemote("C-ACME");
    expect(jobByRemote("C-ACME-2")).toMatchObject({ fullName: "Acme:Phase 2", parentId: acme.id, provisional: false });
    expect(jobByRemote("C-OLD")).toMatchObject({ remoteActive: false });
    expect(listJobs().map((j) => j.fullName)).toEqual(["Acme", "Acme:Phase 2", "Walk-in", "Walk-in:Repair"]);
    expect(getJob(local)).toMatchObject({ remoteId: null });
    expect(listRemotePeople().map((p) => [p.name, p.kind, p.active])).toEqual([
      ["Alice A", "employee", true],
      ["Former Helper", "other", false],
      ["Sub Contracting LLC", "vendor", true],
    ]);
    expect(listRemoteItems().map((i) => i.fullName)).toEqual(["Hourly", "Labor", "Labor:Design"]);
    expect(syncState().lastPullAt).toBe(NINE);

    // Nothing more to do until the lists go stale or someone asks.
    expect(listWork(now)).toEqual([]);
    now += 10 * MIN;
    requestPull(now);
    expect(listWork(now).map((w) => w.kind)).toEqual(["pull"]);

    // Renamed, moved and removed in QuickBooks.
    qb.customers[1]!.name = "Phase Two";
    qb.customers = qb.customers.filter((c) => c.id !== "C-OLD");
    qb.employees[0]!.active = false;
    await sync();
    expect(jobByRemote("C-ACME-2").fullName).toBe("Acme:Phase Two");
    expect(jobByRemote("C-OLD").remoteActive).toBe(false);
    expect(listRemotePeople().find((p) => p.remoteId === "E-ALICE")!.active).toBe(false);

    // An hour on, it pulls again by itself.
    now += PULL_EVERY_MS;
    expect(listWork(now).map((w) => w.kind)).toEqual(["pull"]);
  });

  test("renaming a job that comes from the accounting system is refused; booking on an inactive one too", async () => {
    await sync();
    const { updateJob } = await import("./jobs.ts");
    expect(() => updateJob({ id: jobByRemote("C-ACME").id, name: "Acme Corp", actorUserId: admin })).toThrow("Change it there");
    expect(send(alice, "entry.create", { entryId: uuidv7(), jobId: jobByRemote("C-OLD").id, workDate: DAY, durationSeconds: 600 })).toMatchObject({
      ok: false,
      code: "conflict",
    });
  });

  test("with payroll switched off, the rest still arrives and the wage items already known are kept", async () => {
    await sync();
    qb.payrollEnabled = false;
    qb.services.push({ id: "I-NEW", name: "Cleanup", fullName: "Cleanup", active: true });
    now += 10 * MIN;
    requestPull(now);
    expect((await sync()).reached).toBe(true);
    expect(listRemoteItems("payroll_wage")).toEqual([
      { remoteId: "W-HOURLY", kind: "payroll_wage", name: "Hourly", fullName: "Hourly", active: true },
    ]);
    expect(listRemoteItems("service").map((i) => i.name)).toContain("Cleanup");
  });
});

describe("sending time", () => {
  test("approved time waits for its person to be linked, then goes with the right fields", async () => {
    await sync();
    setDefaultServiceItemId("I-LABOR", admin);
    setDefaultPayrollItemId("W-HOURLY", admin);
    const acme2 = jobByRemote("C-ACME-2").id;
    const id = work(alice, acme2, 95, "Framing & <trim>");
    await sync();
    expect(qb.records).toHaveLength(0); // not approved yet
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });

    expect(syncOverview(now)).toMatchObject({
      ready: 0,
      blocked: [{ entryId: id, fix: "person", reason: "Alice isn't linked to a name in the accounting system." }],
    });
    await sync();
    expect(qb.records).toHaveLength(0);

    linkPerson({ userId: alice, remoteId: "E-ALICE", actorUserId: admin });
    expect(syncOverview(now).ready).toBe(1);
    // Two requests: what's there for Alice that day already, then the time.
    expect(listWork(now).map((w) => w.kind)).toEqual(["entry.check"]);
    expect(await sync()).toMatchObject({ reached: true, done: 2 });
    expect(qb.summary()).toEqual([
      {
        date: DAY,
        entity: "E-ALICE",
        customer: "C-ACME-2",
        item: "I-LABOR",
        payrollItem: "W-HOURLY",
        duration: "PT1H35M0S",
        notes: "Framing & <trim>",
        billable: "Billable",
      },
    ]);
    expect(getEntry(id)).toMatchObject({ status: "synced" });
    const row = db()
      .query<{ remote_txn_id: string; synced_at: number }, [string]>("SELECT remote_txn_id, synced_at FROM time_entries WHERE id = ?")
      .get(id)!;
    expect(row).toEqual({ remote_txn_id: qb.records[0]!.txnId, synced_at: NINE });
    expect(syncOverview(now)).toMatchObject({ ready: 0, sent: 1, blocked: [], failed: [] });

    // Sent time stays locked.
    expect(send(alice, "entry.update", { entryId: id, note: "x" })).toMatchObject({ ok: false, code: "conflict" });
  });

  test("items: a job's own service item wins, jobs inherit their customer's, and only Employees get payroll items", async () => {
    await connected();
    const field = createCategory({ name: "Field", actorUserId: admin });
    setUserCategory({ userId: alice, categoryId: field.id, actorUserId: admin });
    qb.wages.push({ id: "W-FIELD", name: "Field rate", active: true });
    qb.customers.push({ id: "C-ACME-3", name: "Phase 3", parent: "C-ACME", active: true });
    now += MIN;
    requestPull(now);
    await sync();
    setCategoryPayrollItem({ categoryId: field.id, itemId: "W-FIELD", actorUserId: admin });
    // The customer's item, and one job's own.
    setJobServiceItem({ jobId: jobByRemote("C-ACME").id, itemId: "I-DESIGN", actorUserId: admin });
    setJobServiceItem({ jobId: jobByRemote("C-ACME-3").id, itemId: "I-LABOR", actorUserId: admin });

    const a = work(alice, jobByRemote("C-ACME-2").id, 30, null);
    const b = work(bob, jobByRemote("C-ACME-3").id, 60, "Sub work");
    approveEntries({ userId: alice, from: DAY, to: DAY, actorUserId: admin });
    approveEntries({ userId: bob, from: DAY, to: DAY, actorUserId: admin });
    await sync();
    const byMinutes = (minutes: number) => qb.summary().find((r) => r.duration === `PT${Math.floor(minutes / 60)}H${minutes % 60}M0S`)!;
    // No note here means no note there: nothing of this app's is written into the note.
    expect(byMinutes(30)).toMatchObject({ item: "I-DESIGN", payrollItem: "W-FIELD", notes: "" });
    expect(byMinutes(60)).toMatchObject({ entity: "V-SUB", item: "I-LABOR", payrollItem: null, notes: "Sub work" });

    // A person's own payroll item beats their category's.
    setPersonPayrollItem({ userId: alice, itemId: "W-HOURLY", actorUserId: admin });
    const c = work(alice, jobByRemote("C-ACME-2").id, 15, "Framing", NEXT_DAY);
    approveEntries({ userId: alice, entryIds: [c], actorUserId: admin });
    await sync();
    expect(byMinutes(15).payrollItem).toBe("W-HOURLY");
  });

  test("with no service item anywhere, time goes as not billable", async () => {
    await sync();
    linkPerson({ userId: alice, remoteId: "E-ALICE", actorUserId: admin });
    const id = work(alice, jobByRemote("C-ACME-2").id, 60);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    await sync();
    expect(qb.summary()[0]).toMatchObject({ item: null, payrollItem: null, billable: "NotBillable" });
  });

  test("a job that isn't billable sends its time as not billable; the nearest answer up the tree applies", async () => {
    await connected();
    qb.customers.push({ id: "C-ACME-3", name: "Phase 3", parent: "C-ACME", active: true });
    now += MIN;
    requestPull(now);
    await sync();
    const acme = jobByRemote("C-ACME");
    expect(acme).toMatchObject({ billable: null, billed: true });

    // The customer's answer covers its jobs; one job answers for itself.
    updateJob({ id: acme.id, billable: false, actorUserId: admin });
    updateJob({ id: jobByRemote("C-ACME-3").id, billable: true, actorUserId: admin });
    expect(jobByRemote("C-ACME-2")).toMatchObject({ billable: null, billed: false });
    expect(jobByRemote("C-ACME-3")).toMatchObject({ billable: true, billed: true });

    const internal = work(alice, jobByRemote("C-ACME-2").id, 60, "Tidying");
    const forPay = work(alice, jobByRemote("C-ACME-3").id, 30, "Drawings", NINE + 2 * 60 * MIN);
    approveEntries({ userId: alice, from: DAY, to: DAY, actorUserId: admin });
    await sync();
    const byNote = (note: string) => qb.summary().find((r) => r.notes === note)!;
    // Still carries its service item: what the work was doesn't change, only whether it's billed.
    expect(byNote("Tidying")).toMatchObject({ item: "I-LABOR", billable: "NotBillable" });
    expect(byNote("Drawings")).toMatchObject({ item: "I-LABOR", billable: "Billable" });

    // Back to following the customer.
    updateJob({ id: jobByRemote("C-ACME-3").id, billable: null, actorUserId: admin });
    expect(jobByRemote("C-ACME-3")).toMatchObject({ billable: null, billed: false });
  });

  test("what can't be sent says why", async () => {
    await connected();
    const zero = work(alice, jobByRemote("C-ACME-2").id, 0.2);
    const provisional = work(alice, local, 30);
    const unlinked = createUser({ name: "Carol", role: "employee", actorUserId: admin }).id;
    const carols = work(unlinked, jobByRemote("C-ACME-2").id, 30);
    linkPerson({ userId: bob, remoteId: "O-GONE", actorUserId: admin }); // an inactive name
    const bobs = work(bob, jobByRemote("C-ACME-2").id, 30);
    for (const u of [alice, unlinked, bob]) approveEntries({ userId: u, from: DAY, to: DAY, actorUserId: admin });

    const reasons = Object.fromEntries(syncOverview(now).blocked.map((b) => [b.entryId, [b.fix, b.reason]]));
    expect(reasons).toEqual({
      [zero]: ["entry", "Less than a minute of time: nothing to send. Delete it or fix its times."],
      [provisional]: ["job", "The job “Walk-in › Repair” was made here and isn't in the accounting system yet."],
      [carols]: ["person", "Carol isn't linked to a name in the accounting system."],
      [bobs]: ["person", "Bob's name (Former Helper) is inactive in the accounting system."],
    });
    await sync();
    expect(qb.records).toHaveLength(0);
    expect(() => linkPerson({ userId: unlinked, remoteId: "O-GONE", actorUserId: admin })).toThrow("already linked to Bob");
    expect(() => linkPerson({ userId: unlinked, remoteId: "NOPE", actorUserId: admin })).toThrow("isn't in the accounting system");
  });
});

describe("the approval gate", () => {
  test("submitted time goes on its own, and waits for an admin once approval is required", async () => {
    await connected();
    const acme2 = jobByRemote("C-ACME-2").id;

    // Off by default: submitting is the whole gate.
    const first = work(alice, acme2, 60);
    submitEntries({ userId: alice, entryIds: [first], actorUserId: alice });
    expect(syncOverview(now).ready).toBe(1);
    expect(await sync()).toMatchObject({ done: 2 });
    expect(getEntry(first)!.status).toBe("synced");

    // On: the same submission is no longer enough.
    setRequireApproval(true, admin);
    const second = work(alice, acme2, 30, "Trim", NEXT_DAY);
    submitEntries({ userId: alice, entryIds: [second], actorUserId: alice });
    expect(syncOverview(now).ready).toBe(0);
    expect(await sync()).toMatchObject({ done: 0 });
    expect(getEntry(second)!.status).toBe("submitted");

    approveEntries({ userId: alice, entryIds: [second], actorUserId: admin });
    expect(await sync()).toMatchObject({ done: 2 });
    expect(getEntry(second)!.status).toBe("synced");

    // Time approved while the gate was on still goes after it's switched off.
    setRequireApproval(false, admin);
    const third = work(alice, acme2, 15, "Punch list", NEXT_DAY + 24 * 60 * MIN);
    approveEntries({ userId: alice, entryIds: [third], actorUserId: admin });
    expect(await sync()).toMatchObject({ done: 2 });
    expect(getEntry(third)!.status).toBe("synced");
  });

  test("taking back time that was sent amends it there when it's submitted again", async () => {
    await connected();
    const id = work(alice, jobByRemote("C-ACME-2").id, 60);
    submitEntries({ userId: alice, entryIds: [id], actorUserId: alice });
    await sync();
    expect(qb.records).toHaveLength(1);

    reopenEntries({ userId: alice, entryIds: [id], actorUserId: alice, ownSubmissionsOnly: true });
    expect(syncOverview(now).reopened).toHaveLength(1);
    ok(send(alice, "entry.update", { entryId: id, note: "Framing, corrected" }));
    submitEntries({ userId: alice, entryIds: [id], actorUserId: alice });
    await sync();
    expect(qb.records).toHaveLength(1); // amended, not duplicated
    expect(qb.records[0]!.notes).toContain("Framing, corrected");
  });
});

describe("time the accounting system already has", () => {
  // Another tracker has been feeding the same books: an hour for Alice on Phase 2, that day.
  const theirs = () => qb.addForeign({ txnDate: DAY, entity: "E-ALICE", customer: "C-ACME-2", duration: "PT1H0M0S", notes: "Framing" });

  test("a record for the same person, day and job that didn't come from here holds the entry", async () => {
    await connected();
    const record = theirs();
    // Not matches: someone else's time, another day, and another job.
    qb.addForeign({ txnDate: DAY, entity: "V-SUB", customer: "C-ACME-2", duration: "PT1H0M0S" });
    qb.addForeign({ txnDate: "2026-09-15", entity: "E-ALICE", customer: "C-ACME-2", duration: "PT1H0M0S" });
    qb.addForeign({ txnDate: DAY, entity: "E-ALICE", customer: "C-ACME", duration: "PT1H0M0S" });
    const id = work(alice, jobByRemote("C-ACME-2").id, 240, "Framing all morning");
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });

    expect(await sync()).toMatchObject({ reached: true, done: 1 }); // asked, and stopped there
    expect(qb.records).toHaveLength(4);
    expect(getEntry(id)!.status).toBe("approved");
    expect(listWork(now)).toEqual([]);
    expect(syncOverview(now)).toMatchObject({
      ready: 0,
      failed: [],
      blocked: [],
      duplicates: [
        {
          entryId: id,
          person: "Alice",
          workDate: DAY,
          minutes: 240,
          job: "Acme:Phase 2",
          note: "Framing all morning",
          found: [{ txnId: record.txnId, minutes: 60, notes: "Framing" }],
        },
      ],
    });
    // It stays held however often the sync runs.
    now += 10 * MIN;
    expect(await sync()).toMatchObject({ done: 0 });
    expect(qb.records).toHaveLength(4);
  });

  test("the same time: the entry takes the record over and amends it, rather than adding a second", async () => {
    await connected();
    const record = theirs();
    const id = work(alice, jobByRemote("C-ACME-2").id, 240, "Framing all morning");
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    await sync();

    expect(() => resolveDuplicate({ entryId: id, action: "replace", txnId: "nope", actorUserId: admin })).toThrow(/isn't one of those found/);
    resolveDuplicate({ entryId: id, action: "replace", txnId: record.txnId, actorUserId: admin });
    expect(listWork(now).map((w) => w.kind)).toEqual(["entry.mod"]);
    expect(syncOverview(now)).toMatchObject({ ready: 1, duplicates: [] });
    await sync();
    expect(qb.records).toHaveLength(1);
    expect(qb.records[0]).toMatchObject({
      txnId: record.txnId,
      duration: "PT4H0M0S",
      notes: "Framing all morning",
      item: "I-LABOR",
      billable: "Billable",
      editSequence: "2",
    });
    expect(getEntry(id)!.status).toBe("synced");
    expect(() => resolveDuplicate({ entryId: id, action: "separate", actorUserId: admin })).toThrow(/isn't waiting/);
  });

  test("different time: both go, and a record can only be taken over once", async () => {
    await connected();
    const record = theirs();
    const acme2 = jobByRemote("C-ACME-2").id;
    const morning = work(alice, acme2, 60, "Framing");
    const afternoon = legacy(alice, acme2, 30, "Trim", NINE + 5 * 60 * MIN);
    approveEntries({ userId: alice, from: DAY, to: DAY, actorUserId: admin });

    // One question answers for both.
    expect(await sync()).toMatchObject({ done: 1 });
    expect(syncOverview(now).duplicates.map((d) => d.entryId).sort()).toEqual([morning, afternoon].sort());

    resolveDuplicate({ entryId: morning, action: "replace", txnId: record.txnId, actorUserId: admin });
    expect(() => resolveDuplicate({ entryId: afternoon, action: "replace", txnId: record.txnId, actorUserId: admin })).toThrow(
      /already stands for that record/,
    );
    resolveDuplicate({ entryId: afternoon, action: "separate", actorUserId: admin });
    await sync();
    expect(qb.records.map((r) => r.notes).sort()).toEqual(["Framing", "Trim"]);
    expect([morning, afternoon].map((e) => getEntry(e)!.status)).toEqual(["synced", "synced"]);
  });

  test("this app's own records don't hold anything, and fixing it at the desk clears it on a second look", async () => {
    await connected();
    const acme2 = jobByRemote("C-ACME-2").id;
    const first = work(alice, acme2, 60, "Framing");
    approveEntries({ userId: alice, entryIds: [first], actorUserId: admin });
    await sync();
    expect(getEntry(first)!.status).toBe("synced");

    // Another line on the same job and day (from before one line per job):
    // what's there is ours.
    const second = legacy(alice, acme2, 30, "Trim", NINE + 5 * 60 * MIN);
    approveEntries({ userId: alice, entryIds: [second], actorUserId: admin });
    await sync();
    expect(getEntry(second)!.status).toBe("synced");
    expect(syncOverview(now).duplicates).toEqual([]);

    // Then a record from elsewhere holds the next one — until it's removed there.
    const record = theirs();
    const third = legacy(alice, acme2, 15, "Punch list", NINE + 7 * 60 * MIN);
    approveEntries({ userId: alice, entryIds: [third], actorUserId: admin });
    await sync();
    expect(syncOverview(now).duplicates.map((d) => d.entryId)).toEqual([third]);
    qb.records.splice(qb.records.indexOf(record), 1);
    await sync();
    expect(getEntry(third)!.status).toBe("approved"); // nobody has looked again yet
    expect(recheckDuplicates()).toBe(1);
    await sync();
    expect(getEntry(third)!.status).toBe("synced");
    expect(qb.records).toHaveLength(3);
  });

  test("an answer stands only for what was asked: moved to another job, the entry is checked afresh", async () => {
    await connected();
    qb.customers.push({ id: "C-ACME-3", name: "Phase 3", parent: "C-ACME", active: true });
    now += MIN;
    requestPull(now);
    await sync();
    theirs();
    const id = work(alice, jobByRemote("C-ACME-2").id, 60);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    await sync();
    expect(syncOverview(now).duplicates).toHaveLength(1);

    reopenEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    ok(send(alice, "entry.update", { entryId: id, jobId: jobByRemote("C-ACME-3").id }));
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    expect(syncOverview(now)).toMatchObject({ ready: 1, duplicates: [] });
    expect(listWork(now).map((w) => w.kind)).toEqual(["entry.check"]);
    await sync();
    expect(getEntry(id)!.status).toBe("synced");
    expect(qb.records.at(-1)).toMatchObject({ customer: "C-ACME-3" });
  });

  test("the person answers from their own day: it's marked for them, and each way out does what it says", async () => {
    await connected();
    const acme2 = jobByRemote("C-ACME-2").id;
    const record = theirs();
    const mine = work(alice, acme2, 60, "Framing");
    const theirsToo = legacy(alice, acme2, 30, "Trim", NINE + 5 * 60 * MIN);
    const different = legacy(alice, acme2, 15, "Punch list", NINE + 7 * 60 * MIN);
    submitEntries({ userId: alice, from: DAY, to: DAY, actorUserId: alice });
    await sync();
    expect([...heldEntries(alice).keys()].sort()).toEqual([mine, theirsToo, different].sort());
    expect(heldEntries(alice).get(mine)).toMatchObject({ workDate: DAY, status: "submitted", found: [{ txnId: record.txnId, minutes: 60 }] });
    // Someone else's day shows nothing of it, and Bob can't answer for Alice.
    expect(heldEntries(bob).size).toBe(0);
    expect(send(bob, "duplicate.resolve", { entryId: mine, action: "separate" })).toMatchObject({ ok: false, code: "not_found" });

    // Keep QuickBooks' record, delete mine: the submission is taken back and the entry is gone.
    ok(send(alice, "duplicate.resolve", { entryId: theirsToo, action: "discard" }));
    expect(getEntry(theirsToo)).toMatchObject({ deletedAt: expect.any(Number), status: "draft" });
    expect(heldEntries(alice).has(theirsToo)).toBe(false);
    // Keep mine: the record there becomes this entry.
    ok(send(alice, "duplicate.resolve", { entryId: mine, action: "replace", txnId: record.txnId }));
    // Different work: both go.
    ok(send(alice, "duplicate.resolve", { entryId: different, action: "separate" }));
    expect(heldEntries(alice).size).toBe(0);
    await sync();
    expect(qb.records.map((r) => [r.duration, r.notes]).sort()).toEqual([
      ["PT0H15M0S", "Punch list"],
      ["PT1H0M0S", "Framing"],
    ]);
    expect(getEntry(mine)!.status).toBe("synced");

    // Answering twice, or about an entry that isn't waiting, is refused.
    expect(send(alice, "duplicate.resolve", { entryId: mine, action: "separate" })).toMatchObject({ ok: false, code: "conflict" });
    expect(send(alice, "duplicate.resolve", { entryId: uuidv7(), action: "separate" })).toMatchObject({ ok: false, code: "not_found" });
  });

  test("keeping QuickBooks' record settles the notes that became the entry; restoring the entry hands them back", async () => {
    await connected();
    const acme2 = jobByRemote("C-ACME-2").id;
    theirs();
    // A day in notes: on the job, a note, turned into an hour, submitted.
    const start = uuidv7();
    const note = uuidv7();
    ok(send(alice, "note.create", { noteId: start, at: NINE, kind: "start", jobId: acme2 }));
    ok(send(alice, "note.create", { noteId: note, at: NINE + MIN, text: "Framing", jobId: acme2 }));
    const entryId = uuidv7();
    ok(
      send(alice, "rollup.commit", {
        workDate: DAY,
        lines: [{ entryId, jobId: acme2, durationSeconds: 3600, note: "Framing", noteIds: [start, note] }],
      }),
    );
    submitEntries({ userId: alice, from: DAY, to: DAY, actorUserId: alice });
    await sync();
    expect(heldEntries(alice).has(entryId)).toBe(true);

    ok(send(alice, "duplicate.resolve", { entryId, action: "discard" }));
    // The time is QuickBooks' record now: the day isn't left with notes to turn into hours again.
    expect(pendingNotesBefore(alice, "2026-09-17")).toBeNull();
    expect(listNotesForDate(alice, DAY).map((n) => [n.rolledIntoEntryId, n.settled])).toEqual([
      [null, "kept_in_accounting"],
      [null, "kept_in_accounting"],
    ]);
    // Settled like a note that is part of an entry: not edited, deleted, made
    // into hours again, or "brought back" as if it had only been left out.
    expect(send(alice, "note.update", { noteId: note, text: "More framing" })).toMatchObject({ ok: false, code: "conflict" });
    expect(send(alice, "note.delete", { noteId: note, at: now })).toMatchObject({ ok: false, code: "conflict" });
    expect(
      send(alice, "rollup.commit", {
        workDate: DAY,
        lines: [{ entryId: uuidv7(), jobId: acme2, durationSeconds: 3600, note: "Framing", noteIds: [start, note] }],
      }),
    ).toMatchObject({ ok: false, code: "conflict" });
    expect(send(alice, "notes.bring_back", { noteIds: [note], at: now })).toMatchObject({ ok: false, code: "conflict" });

    // The entry restored: the notes are its own again, and an ordinary delete
    // afterwards frees them, as it undoes any rollup.
    ok(send(alice, "entry.restore", { entryId, at: now }));
    expect(listNotesForDate(alice, DAY).map((n) => [n.rolledIntoEntryId, n.settled])).toEqual([
      [entryId, null],
      [entryId, null],
    ]);
    ok(send(alice, "entry.delete", { entryId, at: now }));
    expect(pendingNotesBefore(alice, "2026-09-17")).toEqual({ date: DAY, count: 2 });
  });

  test("once an admin has approved it, deleting it is the admin's call; and 'check again' asks once more", async () => {
    await connected();
    setRequireApproval(true, admin);
    const acme2 = jobByRemote("C-ACME-2").id;
    const record = theirs();
    const id = work(alice, acme2, 60, "Framing");
    submitEntries({ userId: alice, entryIds: [id], actorUserId: alice });
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    await sync();
    expect(heldEntries(alice).get(id)?.status).toBe("approved");
    expect(send(alice, "duplicate.resolve", { entryId: id, action: "discard" })).toMatchObject({ ok: false, code: "conflict" });

    // Taken back by the person: still marked for them, though nothing is held while it's a draft.
    ok(send(alice, "duplicate.resolve", { entryId: id, action: "recheck" }));
    expect(heldEntries(alice).size).toBe(0);
    await sync(); // asks again; the record is still there
    expect(heldEntries(alice).has(id)).toBe(true);
    qb.records.splice(qb.records.indexOf(record), 1);
    ok(send(alice, "duplicate.resolve", { entryId: id, action: "recheck" }));
    await sync();
    expect(getEntry(id)!.status).toBe("synced");

    // An admin acting for the person may delete it even though they approved it.
    const again = legacy(alice, acme2, 30, "Trim", NINE + 5 * 60 * MIN);
    theirs();
    submitEntries({ userId: alice, entryIds: [again], actorUserId: alice });
    approveEntries({ userId: alice, entryIds: [again], actorUserId: admin });
    await sync();
    expect(heldEntries(alice).has(again)).toBe(true);
    ok(applyOp({ userId: alice, actorUserId: admin }, { opId: uuidv7(), type: "duplicate.resolve", deviceId: "t", clientTime: now, payload: { entryId: again, action: "discard" } }, now));
    expect(getEntry(again)!.deletedAt).not.toBeNull();
  });

  test("the record changed there since it was found: its current version is fetched, then amended", async () => {
    await connected();
    const record = theirs();
    const id = work(alice, jobByRemote("C-ACME-2").id, 90, "Framing");
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    await sync();
    qb.touch(record.txnId);
    resolveDuplicate({ entryId: id, action: "replace", txnId: record.txnId, actorUserId: admin });
    await sync();
    expect(qb.records).toHaveLength(1);
    expect(qb.records[0]).toMatchObject({ txnId: record.txnId, duration: "PT1H30M0S", notes: "Framing" });
    expect(getEntry(id)!.status).toBe("synced");
  });
});

describe("provisional jobs", () => {
  test("linking merges the job into the real one; the old id keeps working", async () => {
    await connected();
    const id = work(alice, local, 45);
    const noteId = uuidv7();
    ok(send(alice, "note.create", { noteId, at: NINE, text: "arrived", jobId: local }));
    // A sub-job turns up under it afterwards. Time already booked stays put;
    // the job stops taking new hours unless an admin says it still does.
    const sub = uuidv7();
    ok(send(alice, "job.create", { jobId: sub, name: "Back room", parentId: local }));
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    const acme = jobByRemote("C-ACME").id;
    const phase2 = jobByRemote("C-ACME-2").id;

    expect(() => linkJob({ jobId: local, targetId: local, actorUserId: admin })).toThrow("Pick a job from the accounting system");
    // A job's time has to land on a job there, never on a customer.
    expect(() => linkJob({ jobId: local, targetId: acme, actorUserId: admin })).toThrow("is a customer");
    linkJob({ jobId: local, targetId: phase2, actorUserId: admin });
    expect(getEntry(id)!.jobId).toBe(phase2);
    expect(getJob(local)).toMatchObject({ mergedInto: phase2, active: false });
    expect(resolveJob(local)!.id).toBe(phase2);
    expect(getJob(sub)!.parentId).toBe(phase2);
    expect(listJobs().map((j) => j.fullName)).toEqual(["Acme", "Acme:Phase 2", "Acme:Phase 2:Back room", "Walk-in"]);

    // A phone that still has the old id offline books to the real job — which
    // now holds "Back room", so an admin says it takes hours of its own too.
    updateJob({ id: phase2, takesTime: true, actorUserId: admin });
    const later = uuidv7();
    ok(send(alice, "timer.start", { entryId: later, jobId: local, at: NEXT_DAY }));
    expect(getEntry(later)!.jobId).toBe(phase2);

    await sync();
    expect(qb.summary()).toMatchObject([{ customer: "C-ACME-2", duration: "PT0H45M0S" }]);

    // The customer made here links to a real customer, and what's left under it follows.
    ok(send(alice, "job.create", { jobId: uuidv7(), name: "Front room", parentId: walkIn }));
    linkJob({ jobId: walkIn, targetId: acme, actorUserId: admin });
    expect(listJobs().map((j) => j.fullName)).toEqual(["Acme", "Acme:Front room", "Acme:Phase 2", "Acme:Phase 2:Back room"]);
  });

  test("creating one in the accounting system, then sending its time", async () => {
    await connected();
    const id = work(alice, local, 30);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    // The customer has to be there before the job can be.
    expect(() => requestJobCreation({ jobId: local, create: true, actorUserId: admin })).toThrow("parent job isn't in the accounting system");

    requestJobCreation({ jobId: walkIn, create: true, actorUserId: admin });
    expect(listWork(now).map((w) => w.kind)).toEqual(["job.add"]);
    await sync();
    const customer = qb.customers.find((c) => c.name === "Walk-in")!;
    expect(getJob(walkIn)).toMatchObject({ remoteId: customer.id, provisional: false, createRequestedAt: null });
    // The time still waits: its job isn't there yet.
    expect(qb.summary()).toHaveLength(0);

    // Now the job can go too, under it, and its time follows.
    requestJobCreation({ jobId: local, create: true, actorUserId: admin });
    await sync();
    const created = qb.customers.find((c) => c.name === "Repair")!;
    expect(created).toMatchObject({ parent: customer.id });
    expect(qb.fullNameOf(created.id)).toBe("Walk-in:Repair");
    expect(getJob(local)).toMatchObject({ remoteId: created.id, provisional: false, createRequestedAt: null });
    expect(qb.summary()).toMatchObject([{ customer: created.id }]);
  });

  test("a name the accounting system already has, or one that's too long, is reported", async () => {
    await connected();
    // Names already pulled can't be reused here at all.
    expect(send(admin, "job.create", { jobId: uuidv7(), name: "acme" })).toMatchObject({ ok: false, code: "conflict" });

    // One added in QuickBooks since the last pull is only discovered on sending.
    const dup = uuidv7();
    ok(send(admin, "job.create", { jobId: dup, name: "Zeta" }));
    qb.customers.push({ id: "C-ZETA", name: "zeta", parent: null, active: true });
    requestJobCreation({ jobId: dup, create: true, actorUserId: admin });
    await sync();
    expect(getJob(dup)).toMatchObject({
      remoteId: null,
      createRequestedAt: null,
      syncError: "The accounting system already has a job with this name there. Link this job to it instead.",
    });
    expect(syncOverview(now).jobsToCreate).toEqual([{ jobId: dup, name: "Zeta", error: expect.stringContaining("Link this job") }]);

    const long = uuidv7();
    ok(send(admin, "job.create", { jobId: long, name: "A name that is far too long for QuickBooks to accept" }));
    expect(() => requestJobCreation({ jobId: long, create: true, actorUserId: admin })).toThrow("41 characters");
  });
});

describe("corrections and failures", () => {
  test("reopened, edited and approved again: the same record is amended", async () => {
    await connected();
    const id = work(alice, jobByRemote("C-ACME-2").id, 60);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    await sync();
    const txnId = qb.records[0]!.txnId;

    reopenEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    expect(syncOverview(now).reopened).toEqual([{ entryId: id, person: "Alice", workDate: DAY }]);
    ok(send(alice, "entry.update", { entryId: id, endedAt: NINE + 90 * MIN, note: "Longer" }));
    await sync();
    expect(qb.records[0]!.duration).toBe("PT1H0M0S"); // unchanged until approved again

    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    expect(listWork(now).map((w) => w.kind)).toEqual(["entry.mod"]);
    await sync();
    expect(qb.records).toHaveLength(1);
    expect(qb.records[0]).toMatchObject({ txnId, duration: "PT1H30M0S", notes: "Longer", editSequence: "2" });
    expect(getEntry(id)!.status).toBe("synced");
  });

  test("reopened and deleted: the record is removed there too", async () => {
    await connected();
    const id = work(alice, jobByRemote("C-ACME-2").id, 60);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    await sync();
    reopenEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    ok(send(alice, "entry.delete", { entryId: id, at: now }));
    expect(listWork(now).map((w) => w.kind)).toEqual(["entry.delete"]);
    await sync();
    expect(qb.records).toHaveLength(0);
    expect(listWork(now)).toEqual([]);
    expect(syncOverview(now).reopened).toEqual([]);

    // Restored and approved again: sent afresh.
    ok(send(alice, "entry.restore", { entryId: id, at: now }));
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    expect(listWork(now).map((w) => w.kind)).toEqual(["entry.add"]);
    await sync();
    expect(qb.records).toHaveLength(1);
  });

  test("an answer lost in transit doesn't cause a duplicate", async () => {
    await connected();
    const id = work(alice, jobByRemote("C-ACME-2").id, 60);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    qb.loseNextAnswer("TimeTrackingAddRq");
    expect(await sync()).toMatchObject({ reached: false });
    expect(qb.records).toHaveLength(1); // it did arrive
    expect(getEntry(id)!.status).toBe("approved");
    expect(listWork(now).map((w) => w.kind)).toEqual(["entry.find"]);

    await sync();
    expect(qb.records).toHaveLength(1);
    expect(getEntry(id)!.status).toBe("synced");
    expect(qb.requests.filter((r) => r.includes("TimeTrackingAddRq"))).toHaveLength(1);
  });

  test("a lost answer is recognised by what was sent, and not by someone else's identical record", async () => {
    await connected();
    const acme2 = jobByRemote("C-ACME-2").id;
    // The other tracker has an hour of "Framing" on the same job already, and
    // Bob's hour of it stands for a record of this app's own.
    const foreign = qb.addForeign({ txnDate: DAY, entity: "E-ALICE", customer: "C-ACME-2", duration: "PT1H0M0S", notes: "Framing" });
    const id = work(alice, acme2, 60, "Framing");
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    // The check finds the other tracker's record and holds the entry; it's different work.
    await sync();
    resolveDuplicate({ entryId: id, action: "separate", actorUserId: admin });
    qb.loseNextAnswer("TimeTrackingAddRq");
    expect(await sync()).toMatchObject({ reached: false });
    expect(qb.records).toHaveLength(2); // it did arrive
    expect(listWork(now).map((w) => w.kind)).toEqual(["entry.find"]);

    // Two identical records there now; the one nobody here stands for yet is the lost send.
    await sync();
    expect(qb.records).toHaveLength(2);
    expect(getEntry(id)!.status).toBe("synced");
    const mine = db().query<{ remote_txn_id: string }, [string]>("SELECT remote_txn_id FROM time_entries WHERE id = ?").get(id)!.remote_txn_id;
    expect(mine).not.toBe(foreign.txnId);
    expect(qb.requests.filter((r) => r.includes("TimeTrackingAddRq"))).toHaveLength(1);
  });

  test("a record still carrying the old reference is amended clean, without being taken back", async () => {
    await connected();
    const id = work(alice, jobByRemote("C-ACME-2").id, 60, "Framing");
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    await sync();
    expect(qb.records[0]!.notes).toBe("Framing");
    // As every record sent before 2026-10-02 was: the note, then the app's reference.
    qb.records[0]!.notes = "Framing [ref 0123456789ab]";
    // Migration 008 marks every sent entry this way on an existing database.
    db().query("UPDATE time_entries SET remote_stale_at = ? WHERE id = ?").run(now, id);
    expect(getEntry(id)!.status).toBe("synced");
    expect(listWork(now).map((w) => w.kind)).toEqual(["entry.mod"]);
    expect(syncOverview(now)).toMatchObject({ ready: 1 });
    await sync();
    expect(qb.records).toHaveLength(1);
    expect(qb.records[0]!.notes).toBe("Framing");
    expect(getEntry(id)!.status).toBe("synced");
    expect(listWork(now)).toEqual([]);
  });

  test("unreachable before anything was sent: found missing, then sent once", async () => {
    await connected();
    const id = work(alice, jobByRemote("C-ACME-2").id, 60);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    down = true;
    const summary = await sync();
    expect(summary).toMatchObject({ reached: false, done: 0 });
    expect(summary.detail).toContain("Can't reach the QB Bridge");
    expect(syncState()).toMatchObject({ lastContactOk: false });
    expect(getEntry(id)!.status).toBe("approved"); // nothing held against it
    down = false;
    await sync();
    expect(qb.records).toHaveLength(1);
    expect(getEntry(id)!.status).toBe("synced");
    expect(syncState()).toMatchObject({ lastContactOk: true });
  });

  test("changed in QuickBooks meanwhile: its current version is fetched, then it's amended", async () => {
    await connected();
    const id = work(alice, jobByRemote("C-ACME-2").id, 60);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    await sync();
    qb.touch(qb.records[0]!.txnId);
    reopenEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    ok(send(alice, "entry.update", { entryId: id, note: "Edited" }));
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    await sync();
    expect(qb.records).toHaveLength(1);
    expect(qb.records[0]!.notes).toBe("Edited");
    expect(getEntry(id)!.status).toBe("synced");
  });

  test("deleted in QuickBooks meanwhile: sent again", async () => {
    await connected();
    const id = work(alice, jobByRemote("C-ACME-2").id, 60);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    await sync();
    const first = qb.records[0]!.txnId;
    qb.records = [];
    reopenEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    await sync();
    expect(qb.records).toHaveLength(1);
    expect(qb.records[0]!.txnId).not.toBe(first);
    expect(getEntry(id)!.status).toBe("synced");
  });

  test("a refusal backs off and is shown; retry now sends it again", async () => {
    await connected();
    const id = work(alice, jobByRemote("C-ACME-2").id, 60);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    qb.failNext(3140, "There is an invalid reference to QuickBooks Customer.");
    expect(await sync()).toMatchObject({ reached: true, done: 1 });
    expect(getEntry(id)!.status).toBe("sync_failed");
    expect(syncOverview(now).failed).toEqual([
      {
        entryId: id,
        person: "Alice",
        workDate: DAY,
        minutes: 60,
        error: "There is an invalid reference to QuickBooks Customer.",
        retryAt: now + MIN,
      },
    ]);
    // Failed time is still locked, and can be reopened.
    expect(send(alice, "entry.delete", { entryId: id, at: now })).toMatchObject({ ok: false });

    expect((await sync()).done).toBe(0); // not due yet
    now += 30_000;
    expect(retryFailedNow()).toBe(1);
    await sync();
    expect(getEntry(id)!.status).toBe("synced");
    expect(syncOverview(now).failed).toEqual([]);

    // Backoff doubles with each failure.
    const again = work(alice, jobByRemote("C-ACME-2").id, 30, "Framing", NEXT_DAY);
    approveEntries({ userId: alice, entryIds: [again], actorUserId: admin });
    for (const wait of [MIN, 2 * MIN, 4 * MIN]) {
      qb.failNext(3140);
      await sync();
      expect(syncOverview(now).failed[0]!.retryAt).toBe(now + wait);
      now += wait;
    }
  });

  test("a busy record is retried a minute later", async () => {
    await connected();
    const id = work(alice, jobByRemote("C-ACME-2").id, 60);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    qb.failNext(3175, "The record is in use.");
    await sync();
    expect(getEntry(id)!.status).toBe("sync_failed");
    now += MIN;
    await sync();
    expect(getEntry(id)!.status).toBe("synced");
  });

  test("an older bridge that can't list service items still supplies jobs and people", async () => {
    // Before its route order was fixed (2026-09-18), the bridge answered
    // /items/service as a single item called "service". Everything that lets
    // people link themselves and their jobs must not wait on that.
    shadowed = true;
    expect((await sync()).reached).toBe(true);
    expect(jobByRemote("C-ACME")).toBeTruthy();
    expect(listRemotePeople().length).toBeGreaterThan(0);
    expect(listRemoteItems("service")).toEqual([]);
    const attempt = db().query<{ request: string }, []>("SELECT request FROM sync_attempts ORDER BY id DESC LIMIT 1").get();
    expect(attempt!.request).toContain("services skipped: The QB Bridge answered /api/v1/items/service as a single record");

    // The bridge gets updated: the next pull fills the items in and keeps the rest.
    shadowed = false;
    now += 60_000;
    requestPull(now);
    expect((await sync()).reached).toBe(true);
    expect(listRemoteItems("service").map((i) => i.remoteId)).toContain("I-LABOR");
    expect(jobByRemote("C-ACME")).toBeTruthy();
  });

  test("an older bridge, or the wrong key, is unreachable — not a failure of the time", async () => {
    await connected();
    const id = work(alice, jobByRemote("C-ACME-2").id, 60);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    noEndpoint = true;
    expect((await sync()).detail).toContain("The QB Bridge has no /api/v1/time-tracking — it needs updating");
    noEndpoint = false;
    const wrongKey = new QbBridgeBackend({
      baseUrl: "http://bridge.test",
      apiKey: "wrong",
      fetch: fakeBridgeFetch(qb, { apiKey: "secret" }),
    });
    expect((await runSync(wrongKey, () => now)).detail).toContain("INVALID_API_KEY");
    expect(await wrongKey.health()).toMatchObject({ ok: false });
    expect(await backend.health()).toEqual({ ok: true, detail: "Connected to QuickBooks (Pretend Company)." });
    expect(getEntry(id)!.status).toBe("approved");
    await sync();
    expect(getEntry(id)!.status).toBe("synced");

    // Every try is logged, and none of them counts against the time: the
    // question that comes before a first send never got an answer until the end.
    const attempts = db()
      .query<{ work: string; ok: number }, []>("SELECT work, ok FROM sync_attempts WHERE work != 'pull' ORDER BY id")
      .all()
      .map((a) => `${a.work} ${a.ok ? "ok" : "failed"}`);
    expect(attempts).toEqual(["entry.check failed", "entry.check failed", "entry.check ok", "entry.add ok"]);
  });

  test("a failed pull waits a few minutes before trying again", async () => {
    qb.failNext(3000, "Customer list unavailable");
    await sync();
    expect(syncState().lastPullAt).toBeNull();
    expect(listWork(now)).toEqual([]);
    now += 5 * MIN;
    expect(listWork(now).map((w) => w.kind)).toEqual(["pull"]);
  });
});
