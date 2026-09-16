import { beforeEach, describe, expect, test } from "bun:test";

import { QbBridgeBackend } from "./accounting/qb-bridge.ts";
import { approveEntries, reopenEntries } from "./approvals.ts";
import { createCategory, setUserCategory } from "./categories.ts";
import { db } from "./db.server.ts";
import { getEntry } from "./entries.ts";
import { getJob, listJobs, resolveJob } from "./jobs.ts";
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
import { setDefaultPayrollItemId, setDefaultServiceItemId, syncState } from "./settings.ts";
import { PULL_EVERY_MS, entryRef, listWork, retryFailedNow, syncOverview } from "./sync.ts";
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
let now = NINE;
let backend: QbBridgeBackend;
let admin = 0;
let alice = 0; // an Employee in QuickBooks
let bob = 0; // a Vendor
let local = "";

beforeEach(() => {
  process.env.TZ = "America/Los_Angeles";
  freshDb();
  qb = sampleCompany();
  down = false;
  noEndpoint = false;
  now = NINE;
  backend = new QbBridgeBackend({
    baseUrl: "http://bridge.test",
    apiKey: "secret",
    fetch: fakeBridgeFetch(qb, { apiKey: "secret", down: () => down, noEndpoint: () => noEndpoint }),
  });
  admin = createUser({ name: "Ada", role: "admin", actorUserId: null }).id;
  alice = createUser({ name: "Alice", role: "employee", actorUserId: admin }).id;
  bob = createUser({ name: "Bob", role: "employee", actorUserId: admin }).id;
  local = uuidv7();
  ok(send(admin, "job.create", { jobId: local, name: "Walk-in repair" }));
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
    expect(listJobs().map((j) => j.fullName)).toEqual(["Acme", "Acme:Phase 2", "Walk-in repair"]);
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
    expect(() => updateJob({ id: jobByRemote("C-ACME").id, name: "Acme Corp", actorUserId: admin })).toThrow("Rename it there");
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
    expect(await sync()).toMatchObject({ reached: true, done: 1 });
    expect(qb.summary()).toEqual([
      {
        date: DAY,
        entity: "E-ALICE",
        customer: "C-ACME-2",
        item: "I-LABOR",
        payrollItem: "W-HOURLY",
        duration: "PT1H35M0S",
        notes: `Framing & <trim> ${entryRef(id)}`,
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

  test("items: a job's own service item wins, sub-jobs inherit it, and only Employees get payroll items", async () => {
    await connected();
    setJobServiceItem({ jobId: jobByRemote("C-ACME").id, itemId: "I-DESIGN", actorUserId: admin });
    const field = createCategory({ name: "Field", actorUserId: admin });
    setUserCategory({ userId: alice, categoryId: field.id, actorUserId: admin });
    qb.wages.push({ id: "W-FIELD", name: "Field rate", active: true });
    now += MIN;
    requestPull(now);
    await sync();
    setCategoryPayrollItem({ categoryId: field.id, itemId: "W-FIELD", actorUserId: admin });

    const a = work(alice, jobByRemote("C-ACME-2").id, 30, null);
    const b = work(bob, jobByRemote("C-ACME").id, 60, "Sub work");
    approveEntries({ userId: alice, from: DAY, to: DAY, actorUserId: admin });
    approveEntries({ userId: bob, from: DAY, to: DAY, actorUserId: admin });
    await sync();
    const byNote = (ref: string) => qb.summary().find((r) => r.notes.endsWith(ref))!;
    expect(byNote(entryRef(a))).toMatchObject({ item: "I-DESIGN", payrollItem: "W-FIELD", notes: entryRef(a) });
    expect(byNote(entryRef(b))).toMatchObject({ entity: "V-SUB", item: "I-DESIGN", payrollItem: null });

    // A person's own payroll item beats their category's.
    setPersonPayrollItem({ userId: alice, itemId: "W-HOURLY", actorUserId: admin });
    const c = work(alice, jobByRemote("C-ACME").id, 15);
    approveEntries({ userId: alice, entryIds: [c], actorUserId: admin });
    await sync();
    expect(byNote(entryRef(c)).payrollItem).toBe("W-HOURLY");
  });

  test("with no service item anywhere, time goes as not billable", async () => {
    await sync();
    linkPerson({ userId: alice, remoteId: "E-ALICE", actorUserId: admin });
    const id = work(alice, jobByRemote("C-ACME").id, 60);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    await sync();
    expect(qb.summary()[0]).toMatchObject({ item: null, payrollItem: null, billable: "NotBillable" });
  });

  test("what can't be sent says why", async () => {
    await connected();
    const zero = work(alice, jobByRemote("C-ACME").id, 0.2);
    const provisional = work(alice, local, 30);
    const unlinked = createUser({ name: "Carol", role: "employee", actorUserId: admin }).id;
    const carols = work(unlinked, jobByRemote("C-ACME").id, 30);
    linkPerson({ userId: bob, remoteId: "O-GONE", actorUserId: admin }); // an inactive name
    const bobs = work(bob, jobByRemote("C-ACME").id, 30);
    for (const u of [alice, unlinked, bob]) approveEntries({ userId: u, from: DAY, to: DAY, actorUserId: admin });

    const reasons = Object.fromEntries(syncOverview(now).blocked.map((b) => [b.entryId, [b.fix, b.reason]]));
    expect(reasons).toEqual({
      [zero]: ["entry", "Less than a minute of time: nothing to send. Delete it or fix its times."],
      [provisional]: ["job", "The job “Walk-in repair” was made here and isn't in the accounting system yet."],
      [carols]: ["person", "Carol isn't linked to a name in the accounting system."],
      [bobs]: ["person", "Bob's name (Former Helper) is inactive in the accounting system."],
    });
    await sync();
    expect(qb.records).toHaveLength(0);
    expect(() => linkPerson({ userId: unlinked, remoteId: "O-GONE", actorUserId: admin })).toThrow("already linked to Bob");
    expect(() => linkPerson({ userId: unlinked, remoteId: "NOPE", actorUserId: admin })).toThrow("isn't in the accounting system");
  });
});

describe("provisional jobs", () => {
  test("linking merges the job into the real one; the old id keeps working", async () => {
    await connected();
    const sub = uuidv7();
    ok(send(alice, "job.create", { jobId: sub, name: "Back room", parentId: local }));
    const id = work(alice, local, 45);
    const noteId = uuidv7();
    ok(send(alice, "note.create", { noteId, at: NINE, text: "arrived", jobId: local }));
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    const acme = jobByRemote("C-ACME").id;

    expect(() => linkJob({ jobId: local, targetId: local, actorUserId: admin })).toThrow("Pick a job from the accounting system");
    linkJob({ jobId: local, targetId: acme, actorUserId: admin });
    expect(getEntry(id)!.jobId).toBe(acme);
    expect(getJob(local)).toMatchObject({ mergedInto: acme, active: false });
    expect(resolveJob(local)!.id).toBe(acme);
    expect(getJob(sub)!.parentId).toBe(acme);
    expect(listJobs().map((j) => j.fullName)).toEqual(["Acme", "Acme:Back room", "Acme:Phase 2"]);

    // A phone that still has the old id offline books to the real job.
    const later = uuidv7();
    ok(send(alice, "timer.start", { entryId: later, jobId: local, at: NINE + 60 * MIN }));
    expect(getEntry(later)!.jobId).toBe(acme);

    await sync();
    expect(qb.summary()).toMatchObject([{ customer: "C-ACME", duration: "PT0H45M0S" }]);
  });

  test("creating one in the accounting system, then sending its time", async () => {
    await connected();
    const id = work(alice, local, 30);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    const child = uuidv7();
    ok(send(admin, "job.create", { jobId: child, name: "Upstairs", parentId: local }));
    expect(() => requestJobCreation({ jobId: child, create: true, actorUserId: admin })).toThrow("parent job isn't in the accounting system");

    requestJobCreation({ jobId: local, create: true, actorUserId: admin });
    expect(listWork(now).map((w) => w.kind)).toEqual(["job.add"]);
    await sync();
    const created = qb.customers.find((c) => c.name === "Walk-in repair")!;
    expect(getJob(local)).toMatchObject({ remoteId: created.id, provisional: false, createRequestedAt: null });
    expect(qb.summary()).toMatchObject([{ customer: created.id }]);

    // Now the child can go too, under it.
    requestJobCreation({ jobId: child, create: true, actorUserId: admin });
    await sync();
    expect(qb.customers.find((c) => c.name === "Upstairs")).toMatchObject({ parent: created.id });
    expect(qb.fullNameOf(qb.customers.at(-1)!.id)).toBe("Walk-in repair:Upstairs");
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
    const id = work(alice, jobByRemote("C-ACME").id, 60);
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
    expect(qb.records[0]).toMatchObject({ txnId, duration: "PT1H30M0S", notes: `Longer ${entryRef(id)}`, editSequence: "2" });
    expect(getEntry(id)!.status).toBe("synced");
  });

  test("reopened and deleted: the record is removed there too", async () => {
    await connected();
    const id = work(alice, jobByRemote("C-ACME").id, 60);
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
    const id = work(alice, jobByRemote("C-ACME").id, 60);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    qb.loseNextAnswer();
    expect(await sync()).toMatchObject({ reached: false });
    expect(qb.records).toHaveLength(1); // it did arrive
    expect(getEntry(id)!.status).toBe("approved");
    expect(listWork(now).map((w) => w.kind)).toEqual(["entry.find"]);

    await sync();
    expect(qb.records).toHaveLength(1);
    expect(getEntry(id)!.status).toBe("synced");
    expect(qb.requests.filter((r) => r.includes("TimeTrackingAddRq"))).toHaveLength(1);
  });

  test("unreachable before anything was sent: found missing, then sent once", async () => {
    await connected();
    const id = work(alice, jobByRemote("C-ACME").id, 60);
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
    const id = work(alice, jobByRemote("C-ACME").id, 60);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    await sync();
    qb.touch(qb.records[0]!.txnId);
    reopenEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    ok(send(alice, "entry.update", { entryId: id, note: "Edited" }));
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    await sync();
    expect(qb.records).toHaveLength(1);
    expect(qb.records[0]!.notes).toBe(`Edited ${entryRef(id)}`);
    expect(getEntry(id)!.status).toBe("synced");
  });

  test("deleted in QuickBooks meanwhile: sent again", async () => {
    await connected();
    const id = work(alice, jobByRemote("C-ACME").id, 60);
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
    const id = work(alice, jobByRemote("C-ACME").id, 60);
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
    const again = work(alice, jobByRemote("C-ACME").id, 30);
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
    const id = work(alice, jobByRemote("C-ACME").id, 60);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    qb.failNext(3175, "The record is in use.");
    await sync();
    expect(getEntry(id)!.status).toBe("sync_failed");
    now += MIN;
    await sync();
    expect(getEntry(id)!.status).toBe("synced");
  });

  test("a bridge without the endpoint, or with the wrong key, is unreachable — not a failure of the time", async () => {
    await connected();
    const id = work(alice, jobByRemote("C-ACME").id, 60);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    noEndpoint = true;
    expect((await sync()).detail).toContain("no /api/v1/qbxml endpoint");
    noEndpoint = false;
    const wrongKey = new QbBridgeBackend({
      baseUrl: "http://bridge.test",
      apiKey: "wrong",
      fetch: fakeBridgeFetch(qb, { apiKey: "secret" }),
    });
    expect((await runSync(wrongKey, () => now)).detail).toContain("UNAUTHORIZED");
    expect(await wrongKey.health()).toMatchObject({ ok: false });
    expect(await backend.health()).toEqual({ ok: true, detail: "Connected to QuickBooks Pretend Edition." });
    expect(getEntry(id)!.status).toBe("approved");
    await sync();
    expect(getEntry(id)!.status).toBe("synced");

    // Every try is logged. The first add may have gone out, so later tries
    // look for it first.
    const attempts = db()
      .query<{ work: string; ok: number }, []>("SELECT work, ok FROM sync_attempts WHERE work != 'pull' ORDER BY id")
      .all()
      .map((a) => `${a.work} ${a.ok ? "ok" : "failed"}`);
    expect(attempts).toEqual(["entry.add failed", "entry.find failed", "entry.find ok", "entry.add ok"]);
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
