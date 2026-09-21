import { beforeEach, describe, expect, test } from "bun:test";

import { approveEntries, describeSignOff, reopenEntries, submitEntries } from "./approvals.ts";
import { auditFor } from "./audit.ts";
import { createCategory, deleteCategory, listCategories, renameCategory, setUserCategory } from "./categories.ts";
import { db } from "./db.server.ts";
import { getEntry, unsubmittedDatesBefore } from "./entries.ts";
import { applyOp } from "./ops.ts";
import type { OpPayload, OpResult, OpType } from "./ops-schema.ts";
import { costOf, listRates, parseHourlyRate, removeRate, resolveRate, setRate } from "./rates.ts";
import { calendarWeek, linesToCsv, reportLines, summarize, timesheet, total } from "./reports.ts";
import { setWeekStartsOn, weekStartsOn } from "./settings.ts";
import { freshDb } from "./testing/db.ts";
import { datesBetween, isWorkDate, weekStartOf } from "./time.ts";
import { createUser, getUser, updateUserAccess } from "./users.ts";
import { uuidv7 } from "./uuid.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
// Wednesday 2026-09-16, 09:00 in America/Los_Angeles.
const NINE = Date.parse("2026-09-16T16:00:00Z");
const WED = "2026-09-16";
const SUN = "2026-09-13";

let admin = 0;
let alice = 0;
let bob = 0;
let acme = "";
let acmeInstall = "";
let other = "";
let otherJob = "";

beforeEach(() => {
  process.env.TZ = "America/Los_Angeles";
  freshDb();
  admin = createUser({ name: "Ada Admin", role: "admin", actorUserId: null }).id;
  alice = createUser({ name: "Alice", role: "employee", actorUserId: admin }).id;
  bob = createUser({ name: "Bob", role: "employee", actorUserId: admin }).id;
  // Two customers; time goes on the jobs under them.
  acme = uuidv7();
  acmeInstall = uuidv7();
  other = uuidv7();
  otherJob = uuidv7();
  ok(send(admin, "job.create", { jobId: acme, name: "Acme" }));
  ok(send(admin, "job.create", { jobId: acmeInstall, name: "Install", parentId: acme }));
  ok(send(admin, "job.create", { jobId: other, name: "Other Co" }));
  ok(send(admin, "job.create", { jobId: otherJob, name: "Service", parentId: other }));
});

function send<T extends OpType>(as: number | { userId: number; actorUserId: number }, type: T, payload: OpPayload<T>, opId = uuidv7()): OpResult {
  return applyOp(as, { opId, type, deviceId: "test-device", clientTime: NINE, payload }, NINE);
}

function ok(result: OpResult): OpResult {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.error}`);
  return result;
}

/** A finished entry with start and end times. */
function worked(userId: number, jobId: string, start: number, minutes: number): string {
  const entryId = uuidv7();
  ok(send(userId, "entry.create", { entryId, jobId, startedAt: start, endedAt: start + minutes * MIN }));
  return entryId;
}

describe("week helpers", () => {
  test("weekStartOf honours the first weekday", () => {
    expect(weekStartOf(WED)).toBe(SUN);
    expect(weekStartOf(WED, 1)).toBe("2026-09-14");
    expect(weekStartOf(WED, 3)).toBe(WED);
    expect(weekStartOf(WED, 4)).toBe("2026-09-10");
    expect(weekStartOf(SUN, 1)).toBe("2026-09-07");
  });

  test("datesBetween is inclusive and crosses months", () => {
    expect(datesBetween("2026-09-29", "2026-10-02")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(datesBetween("2026-09-02", "2026-09-01")).toEqual([]);
  });

  test("isWorkDate rejects impossible dates", () => {
    expect(isWorkDate("2026-02-28")).toBe(true);
    expect(isWorkDate("2026-02-30")).toBe(false);
    expect(isWorkDate("2026-9-1")).toBe(false);
    expect(isWorkDate(20260901)).toBe(false);
  });

  test("the week start setting defaults to Sunday and is audited", () => {
    expect(weekStartsOn()).toBe(0);
    setWeekStartsOn(1, admin);
    expect(weekStartsOn()).toBe(1);
    expect(auditFor("setting", "week_starts_on")).toHaveLength(1);
    expect(() => setWeekStartsOn(7, admin)).toThrow();
  });
});

describe("categories", () => {
  test("create, rename, and names are unique regardless of case", () => {
    const field = createCategory({ name: "  Field   crew ", actorUserId: admin });
    expect(field.name).toBe("Field crew");
    expect(() => createCategory({ name: "field CREW", actorUserId: admin })).toThrow("already a category");
    const shop = createCategory({ name: "Shop", actorUserId: admin });
    expect(() => renameCategory({ id: shop.id, name: "Field Crew", actorUserId: admin })).toThrow("already");
    expect(renameCategory({ id: shop.id, name: "Workshop", actorUserId: admin }).name).toBe("Workshop");
    expect(listCategories().map((c) => c.name)).toEqual(["Field crew", "Workshop"]);
  });

  test("people are counted, and deleting a category uncategorises them and drops its rates", () => {
    const field = createCategory({ name: "Field", actorUserId: admin });
    setUserCategory({ userId: alice, categoryId: field.id, actorUserId: admin });
    setUserCategory({ userId: bob, categoryId: field.id, actorUserId: admin });
    updateUserAccess({ userId: bob, active: false, actorUserId: admin });
    expect(listCategories()[0]!.peopleCount).toBe(1); // active people only
    setRate({ scope: "category", categoryId: field.id, hourlyRate: 30, effectiveFrom: "2026-01-01", actorUserId: admin });

    deleteCategory({ id: field.id, actorUserId: admin });
    expect(getUser(alice)!.categoryId).toBeNull();
    expect(listRates()).toHaveLength(0);
    const [entry] = auditFor("category", field.id).filter((e) => e.action === "delete");
    expect(JSON.parse(entry!.before_json!)).toMatchObject({ name: "Field", people: [alice, bob] });
  });

  test("assigning a missing category is refused", () => {
    expect(() => setUserCategory({ userId: alice, categoryId: 999, actorUserId: admin })).toThrow("no longer exists");
  });
});

describe("rates", () => {
  test("parseHourlyRate accepts money-ish input and rounds to cents", () => {
    expect(parseHourlyRate("45")).toBe(45);
    expect(parseHourlyRate("$1,250.505")).toBe(1250.51);
    expect(parseHourlyRate(0)).toBe(0);
    expect(() => parseHourlyRate("")).toThrow();
    expect(() => parseHourlyRate("abc")).toThrow();
    expect(() => parseHourlyRate("-5")).toThrow("negative");
    expect(() => parseHourlyRate("1000000")).toThrow("too high");
  });

  test("the most specific rate wins, and job rates cover sub-jobs", () => {
    const field = createCategory({ name: "Field", actorUserId: admin });
    setUserCategory({ userId: alice, categoryId: field.id, actorUserId: admin });
    const at = (scope: Parameters<typeof setRate>[0]["scope"], hourlyRate: number, extra = {}) =>
      setRate({ scope, hourlyRate, effectiveFrom: "2026-01-01", actorUserId: admin, ...extra });

    expect(resolveRate(alice, acmeInstall, WED)).toBeNull();
    at("global", 20);
    expect(resolveRate(alice, acmeInstall, WED)).toMatchObject({ hourlyRate: 20, scope: "global" });
    at("category", 30, { categoryId: field.id });
    expect(resolveRate(alice, acmeInstall, WED)?.hourlyRate).toBe(30);
    expect(resolveRate(bob, acmeInstall, WED)?.hourlyRate).toBe(20); // not in the category
    at("user", 40, { userId: alice });
    expect(resolveRate(alice, acmeInstall, WED)?.hourlyRate).toBe(40);
    at("job", 50, { jobId: acme });
    expect(resolveRate(alice, acmeInstall, WED)).toMatchObject({ hourlyRate: 50, scope: "job" }); // parent's rate
    expect(resolveRate(alice, other, WED)?.hourlyRate).toBe(40);
    at("job", 55, { jobId: acmeInstall });
    expect(resolveRate(bob, acmeInstall, WED)?.hourlyRate).toBe(55); // nearest job wins
    at("user_job", 60, { userId: alice, jobId: acme });
    expect(resolveRate(alice, acmeInstall, WED)?.hourlyRate).toBe(60);
    expect(resolveRate(bob, acmeInstall, WED)?.hourlyRate).toBe(55);
  });

  test("effective dates: a raise applies from its date, and the same date replaces", () => {
    setRate({ scope: "user", userId: alice, hourlyRate: 40, effectiveFrom: "2026-01-01", actorUserId: admin });
    setRate({ scope: "user", userId: alice, hourlyRate: 45, effectiveFrom: "2026-09-14", actorUserId: admin });
    expect(resolveRate(alice, acme, "2026-09-13")?.hourlyRate).toBe(40);
    expect(resolveRate(alice, acme, "2026-09-14")?.hourlyRate).toBe(45);
    expect(resolveRate(alice, acme, "2025-12-31")).toBeNull();

    // Correcting the raise replaces it; the old row stays for the record.
    setRate({ scope: "user", userId: alice, hourlyRate: 47.5, effectiveFrom: "2026-09-14", actorUserId: admin });
    expect(resolveRate(alice, acme, WED)?.hourlyRate).toBe(47.5);
    expect(listRates()).toHaveLength(2);
    expect(db().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM rates").get()!.n).toBe(3);

    // A future-dated scope doesn't hide an older, broader rate before its date.
    setRate({ scope: "job", jobId: acme, hourlyRate: 90, effectiveFrom: "2026-10-01", actorUserId: admin });
    expect(resolveRate(alice, acme, WED)?.hourlyRate).toBe(47.5);
    expect(resolveRate(alice, acme, "2026-10-01")?.hourlyRate).toBe(90);

    const later = listRates().find((r) => r.hourlyRate === 90)!;
    removeRate({ id: later.id, actorUserId: admin });
    expect(resolveRate(alice, acme, "2026-10-01")?.hourlyRate).toBe(47.5);
  });

  test("a rate needs the right target and a real date", () => {
    const base = { hourlyRate: 10, effectiveFrom: "2026-01-01", actorUserId: admin };
    expect(() => setRate({ ...base, scope: "user" })).toThrow("Pick a person");
    expect(() => setRate({ ...base, scope: "job", jobId: "nope" })).toThrow("Pick a job");
    expect(() => setRate({ ...base, scope: "user_job", userId: alice })).toThrow("Pick a job");
    expect(() => setRate({ ...base, scope: "category", categoryId: 5 })).toThrow("Pick a category");
    expect(() => setRate({ ...base, scope: "global", effectiveFrom: "2026-02-31" })).toThrow("date");
    // Targets that don't belong to the scope are ignored rather than stored.
    const r = setRate({ ...base, scope: "global", userId: alice, jobId: acme });
    expect(r).toMatchObject({ userId: null, jobId: null, categoryId: null });
  });

  test("costOf rounds to the cent", () => {
    expect(costOf(3600, 45)).toBe(45);
    expect(costOf(20 * 60, 50)).toBe(16.67);
  });
});

describe("submitting", () => {
  test("submitting freezes the rate, locks the entry, and skips running timers", () => {
    setRate({ scope: "user", userId: alice, hourlyRate: 40, effectiveFrom: "2026-01-01", actorUserId: admin });
    const monday = worked(alice, acmeInstall, NINE - 2 * 24 * HOUR, 60);
    const running = uuidv7();
    ok(send(alice, "timer.start", { entryId: running, jobId: acmeInstall, at: NINE + HOUR }));

    const result = submitEntries({ userId: alice, from: SUN, to: "2026-09-19", actorUserId: alice });
    expect(result).toEqual({ changed: 1, unchanged: 0, skipped: 1 });
    expect(describeSignOff("submit", result)).toBe(
      "Submitted 1 entry. A running timer was left out; submit again once it stops.",
    );
    expect(getEntry(monday)).toMatchObject({ status: "submitted", rateSnapshot: 40, approvedBy: null });
    expect(getEntry(running)!.status).toBe("open");

    // A later rate change doesn't touch submitted time.
    setRate({ scope: "user", userId: alice, hourlyRate: 99, effectiveFrom: "2026-01-01", actorUserId: admin });
    expect(getEntry(monday)!.rateSnapshot).toBe(40);
  });

  test("submitted time is locked, and its owner is told they can take it back", () => {
    const id = worked(alice, acmeInstall, NINE, 60);
    submitEntries({ userId: alice, entryIds: [id], actorUserId: alice });

    const edit = send(alice, "entry.update", { entryId: id, note: "late edit" });
    expect(edit).toMatchObject({ ok: false, code: "conflict" });
    expect(!edit.ok && edit.error).toContain("Take the day back");
  });

  test("a person takes their own day back, and submits it again", () => {
    const id = worked(alice, acmeInstall, NINE, 60);
    ok(send(alice, "day.submit", { workDate: WED }));
    expect(getEntry(id)!.status).toBe("submitted");

    ok(send(alice, "day.unsubmit", { workDate: WED }));
    expect(getEntry(id)).toMatchObject({ status: "draft", rateSnapshot: null });
    ok(send(alice, "entry.update", { entryId: id, note: "fixed" }));

    ok(send(alice, "day.submit", { workDate: WED }));
    expect(getEntry(id)!.status).toBe("submitted");
    expect(auditFor("entry", id).map((e) => e.action)).toEqual(["submit", "unsubmit", "update", "submit"]);
  });

  test("what an admin approved is not the person's to take back", () => {
    const id = worked(alice, acmeInstall, NINE, 60);
    submitEntries({ userId: alice, entryIds: [id], actorUserId: alice });
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });

    ok(send(alice, "day.unsubmit", { workDate: WED }));
    expect(getEntry(id)!.status).toBe("approved");
    const edit = send(alice, "entry.update", { entryId: id, note: "no" });
    expect(!edit.ok && edit.error).toContain("Ask an admin to reopen it");

    // The admin's own reopen still takes it back.
    expect(reopenEntries({ userId: alice, entryIds: [id], actorUserId: admin }).changed).toBe(1);
  });

  test("approving keeps the rate the submission froze, and records the submission", () => {
    setRate({ scope: "user", userId: alice, hourlyRate: 40, effectiveFrom: "2026-01-01", actorUserId: admin });
    const id = worked(alice, acmeInstall, NINE, 60);
    submitEntries({ userId: alice, entryIds: [id], actorUserId: alice });
    setRate({ scope: "user", userId: alice, hourlyRate: 99, effectiveFrom: "2026-01-01", actorUserId: admin });
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });
    expect(getEntry(id)!.rateSnapshot).toBe(40);

    // Approving time nobody submitted counts as submitting it for them.
    const straight = worked(alice, otherJob, NINE + 2 * HOUR, 30);
    approveEntries({ userId: alice, entryIds: [straight], actorUserId: admin });
    const row = db()
      .query<{ submitted_by: number | null }, [string]>("SELECT submitted_by FROM time_entries WHERE id = ?")
      .get(straight);
    expect(row!.submitted_by).toBe(admin);
  });

  test("earlier days with time nobody submitted are listed, newest first", () => {
    worked(alice, acmeInstall, NINE - 2 * 24 * HOUR, 60);
    const yesterday = worked(alice, acmeInstall, NINE - 24 * HOUR, 60);
    worked(alice, acmeInstall, NINE, 60);
    expect(unsubmittedDatesBefore(alice, WED)).toEqual(["2026-09-15", "2026-09-14"]);

    submitEntries({ userId: alice, entryIds: [yesterday], actorUserId: alice });
    expect(unsubmittedDatesBefore(alice, WED)).toEqual(["2026-09-14"]);
  });
});

describe("approval", () => {
  test("approving a week locks the entries, freezes the rate, and skips running timers", () => {
    setRate({ scope: "user", userId: alice, hourlyRate: 40, effectiveFrom: "2026-01-01", actorUserId: admin });
    const monday = worked(alice, acmeInstall, NINE - 2 * 24 * HOUR, 60);
    const wednesday = worked(alice, otherJob, NINE, 30);
    const running = uuidv7();
    ok(send(alice, "timer.start", { entryId: running, jobId: acmeInstall, at: NINE + HOUR }));
    const bobs = worked(bob, acmeInstall, NINE, 60);

    const result = approveEntries({ userId: alice, from: SUN, to: "2026-09-19", actorUserId: admin, now: NINE + 2 * HOUR });
    expect(result).toEqual({ changed: 2, unchanged: 0, skipped: 1 });
    expect(describeSignOff("approve", result)).toBe(
      "Approved 2 entries. A running timer was left out; approve again once it stops.",
    );
    expect(getEntry(monday)).toMatchObject({ status: "approved", rateSnapshot: 40, approvedBy: admin });
    expect(getEntry(wednesday)!.status).toBe("approved");
    expect(getEntry(running)!.status).toBe("open");
    expect(getEntry(bobs)!.status).toBe("draft"); // someone else's time is untouched

    // Approving again changes nothing.
    expect(approveEntries({ userId: alice, from: SUN, to: "2026-09-19", actorUserId: admin })).toEqual({
      changed: 0,
      unchanged: 2,
      skipped: 1,
    });

    // A later rate change doesn't touch approved time.
    setRate({ scope: "user", userId: alice, hourlyRate: 99, effectiveFrom: "2026-01-01", actorUserId: admin });
    expect(getEntry(monday)!.rateSnapshot).toBe(40);
  });

  test("approved time can't be changed or deleted — not even by an admin — until reopened", () => {
    const id = worked(alice, acmeInstall, NINE, 60);
    approveEntries({ userId: alice, entryIds: [id], actorUserId: admin });

    const edit = send(alice, "entry.update", { entryId: id, note: "late edit" });
    expect(edit).toMatchObject({ ok: false, code: "conflict" });
    expect(!edit.ok && edit.error).toContain("Ask an admin to reopen it");
    expect(send(alice, "entry.delete", { entryId: id, at: NINE })).toMatchObject({ ok: false, code: "conflict" });
    expect(send({ userId: alice, actorUserId: admin }, "entry.delete", { entryId: id, at: NINE })).toMatchObject({
      ok: false,
      code: "conflict",
    });

    expect(reopenEntries({ userId: alice, entryIds: [id], actorUserId: admin })).toEqual({
      changed: 1,
      unchanged: 0,
      skipped: 0,
    });
    expect(getEntry(id)).toMatchObject({ status: "draft", rateSnapshot: null, approvedAt: null, approvedBy: null });
    ok(send(alice, "entry.update", { entryId: id, note: "fixed" }));
    expect(auditFor("entry", id).map((e) => e.action)).toEqual(["approve", "reopen", "update"]);
  });

  test("time already sent to accounting is locked, and reopens keeping its link there", () => {
    const id = worked(alice, acmeInstall, NINE, 60);
    db().query("UPDATE time_entries SET status = 'synced', remote_txn_id = 'T1' WHERE id = ?").run(id);
    const locked = send(alice, "entry.update", { entryId: id, note: "x" });
    expect(!locked.ok && locked.error).toContain("sent to accounting");
    const result = reopenEntries({ userId: alice, from: WED, to: WED, actorUserId: admin });
    expect(result).toEqual({ changed: 1, unchanged: 0, skipped: 0 });
    expect(describeSignOff("reopen", result)).toBe("Reopened 1 entry.");
    expect(
      db().query<{ status: string; remote_txn_id: string }, [string]>("SELECT status, remote_txn_id FROM time_entries WHERE id = ?").get(id),
    ).toEqual({ status: "draft", remote_txn_id: "T1" });
  });

  test("deleted entries and entries of other people aren't selected by id", () => {
    const mine = worked(alice, acmeInstall, NINE, 60);
    const gone = worked(alice, acmeInstall, NINE + HOUR, 60);
    ok(send(alice, "entry.delete", { entryId: gone, at: NINE }));
    const bobs = worked(bob, acmeInstall, NINE, 60);
    const result = approveEntries({ userId: alice, entryIds: [mine, gone, bobs], actorUserId: admin });
    expect(result.changed).toBe(1);
    expect(getEntry(bobs)!.status).toBe("draft");
    expect(() => approveEntries({ userId: alice, actorUserId: admin })).toThrow();
  });
});

describe("acting for someone", () => {
  test("the change is theirs, and the ledger and audit log record who made it", () => {
    const opId = uuidv7();
    const entryId = uuidv7();
    ok(
      send({ userId: alice, actorUserId: admin }, "entry.create", {
        entryId,
        jobId: acmeInstall,
        workDate: WED,
        durationSeconds: 3600,
      }, opId),
    );
    expect(getEntry(entryId)!.userId).toBe(alice);
    const row = db()
      .query<{ user_id: number; actor_user_id: number }, [string]>(
        "SELECT user_id, actor_user_id FROM applied_ops WHERE op_id = ?",
      )
      .get(opId)!;
    expect(row).toEqual({ user_id: alice, actor_user_id: admin });

    ok(send({ userId: alice, actorUserId: admin }, "entry.update", { entryId, note: "added by admin" }));
    expect(auditFor("entry", entryId).at(-1)!.actor_user_id).toBe(admin);

    // Her own ops record her as the actor.
    const own = uuidv7();
    ok(send(alice, "entry.update", { entryId, note: "hers" }, own));
    expect(
      db().query<{ actor_user_id: number }, [string]>("SELECT actor_user_id FROM applied_ops WHERE op_id = ?").get(own)!
        .actor_user_id,
    ).toBe(alice);

    // An op id already used for her can't be replayed against someone else.
    expect(send({ userId: bob, actorUserId: admin }, "entry.update", { entryId, note: "x" }, opId)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });
});

describe("reports", () => {
  test("lines carry people, customers, live running time, and approved vs estimated costs", () => {
    const field = createCategory({ name: "Field", actorUserId: admin });
    setUserCategory({ userId: alice, categoryId: field.id, actorUserId: admin });
    setRate({ scope: "user", userId: alice, hourlyRate: 40, effectiveFrom: "2026-01-01", actorUserId: admin });
    const approved = worked(alice, acmeInstall, NINE, 90);
    approveEntries({ userId: alice, entryIds: [approved], actorUserId: admin });
    setRate({ scope: "user", userId: alice, hourlyRate: 50, effectiveFrom: "2026-01-01", actorUserId: admin });
    worked(alice, otherJob, NINE + 2 * HOUR, 30);
    const running = uuidv7();
    ok(send(bob, "timer.start", { entryId: running, jobId: acmeInstall, at: NINE }));

    const lines = reportLines({ from: SUN, to: "2026-09-19" }, NINE + 45 * MIN);
    expect(lines).toHaveLength(3);
    const [first, second, third] = lines;
    // Ordered by date, then person, then start.
    expect(first).toMatchObject({
      userName: "Alice",
      categoryName: "Field",
      jobName: "Acme:Install",
      customerName: "Acme",
      seconds: 5400,
      status: "approved",
      hourlyRate: 40,
      rateFrom: "submission",
      cost: 60,
    });
    expect(second).toMatchObject({ jobName: "Other Co:Service", customerName: "Other Co", hourlyRate: 50, rateFrom: "user", cost: 25 });
    expect(third).toMatchObject({ userName: "Bob", status: "open", seconds: 45 * 60, cost: null, endedAt: null });
    expect(third!.runningSince).toBe(NINE);

    expect(reportLines({ from: SUN, to: "2026-09-19", categoryId: field.id }, NINE)).toHaveLength(2);
    // Filtering by the customer covers its jobs.
    expect(reportLines({ from: SUN, to: "2026-09-19", jobId: acme }, NINE).map((l) => l.jobName)).toEqual([
      "Acme:Install",
      "Acme:Install",
    ]);
    expect(reportLines({ from: SUN, to: "2026-09-19", userIds: [bob] }, NINE)).toHaveLength(1);
    expect(reportLines({ from: "2026-09-17", to: "2026-09-19" }, NINE)).toHaveLength(0);

    const byCustomer = summarize(lines, "customer");
    expect(byCustomer.map((g) => [g.label, g.seconds])).toEqual([
      ["Acme", 5400 + 2700],
      ["Other Co", 1800],
    ]);
    expect(byCustomer[0]).toMatchObject({ signedOffSeconds: 5400, cost: 60, unratedSeconds: 2700, running: true });
    expect(summarize(lines, "category").map((g) => g.label)).toEqual(["Field", "No category"]);
    expect(summarize(lines, "day").map((g) => g.label)).toEqual([WED]);
    expect(total(lines)).toMatchObject({ seconds: 9900, cost: 85, entries: 3 });
  });

  test("CSV quotes what needs quoting and defuses formulas", () => {
    const id = worked(alice, acmeInstall, NINE, 90);
    ok(send(alice, "entry.update", { entryId: id, note: '=HYPERLINK("x"), then "quotes"\nand a line' }));
    const csv = linesToCsv(reportLines({ from: WED, to: WED }, NINE), "America/Los_Angeles");
    const [header, row] = csv.split("\r\n");
    expect(header).toBe("Date,Person,Category,Customer,Job,Start,End,Hours,Status,Rate,Cost,Note,Entry ID");
    expect(csv).toContain(`2026-09-16,Alice,,Acme,Acme:Install,9:00 AM,10:30 AM,1.5,Not submitted,,,"'=HYPERLINK(""x""), then ""quotes""\nand a line",${id}`);
    expect(row!.startsWith("2026-09-16,Alice")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  test("timesheet: everyone active, plus anyone deactivated who has time that week", () => {
    const carol = createUser({ name: "carol", role: "employee", actorUserId: admin }).id;
    worked(carol, acmeInstall, NINE, 60);
    updateUserAccess({ userId: carol, active: false, actorUserId: admin });
    const dave = createUser({ name: "Dave", role: "employee", actorUserId: admin }).id;
    updateUserAccess({ userId: dave, active: false, actorUserId: admin });

    const a = worked(alice, acmeInstall, NINE, 60);
    worked(alice, acmeInstall, NINE - 24 * HOUR, 30);
    approveEntries({ userId: alice, entryIds: [a], actorUserId: admin });
    ok(send(bob, "timer.start", { entryId: uuidv7(), jobId: acmeInstall, at: NINE }));

    const sheet = timesheet(SUN, {}, NINE + 30 * MIN);
    expect(sheet.days).toEqual(datesBetween(SUN, "2026-09-19"));
    expect(sheet.rows.map((r) => r.name)).toEqual(["Ada Admin", "Alice", "Bob", "carol"]);
    const aliceRow = sheet.rows[1]!;
    expect(aliceRow).toMatchObject({ seconds: 5400, approved: 1, unsubmitted: 1, submitted: 0, running: false });
    expect(aliceRow.days[3]).toMatchObject({ date: WED, seconds: 3600, approved: 1, unsubmitted: 0 });
    expect(aliceRow.days[2]).toMatchObject({ seconds: 1800, unsubmitted: 1 });
    expect(sheet.rows[2]).toMatchObject({ running: true, seconds: 1800 });
    expect(sheet.rows[3]).toMatchObject({ active: false, seconds: 3600 });

    const field = createCategory({ name: "Field", actorUserId: admin });
    setUserCategory({ userId: bob, categoryId: field.id, actorUserId: admin });
    expect(timesheet(SUN, { categoryId: field.id }, NINE).rows.map((r) => r.name)).toEqual(["Bob"]);
  });

  test("calendar: a block per segment, typed-in durations apart", () => {
    const id = uuidv7();
    ok(send(alice, "timer.start", { entryId: id, jobId: acmeInstall, at: NINE }));
    ok(send(alice, "timer.pause", { entryId: id, at: NINE + 30 * MIN }));
    ok(send(alice, "timer.resume", { entryId: id, at: NINE + HOUR }));
    ok(send(bob, "entry.create", { entryId: uuidv7(), jobId: otherJob, workDate: WED, durationSeconds: 7200 }));

    const week = calendarWeek(SUN, {}, NINE + 2 * HOUR);
    expect(week.people.map((p) => p.name)).toEqual(["Alice", "Bob"]);
    expect(week.blocks).toEqual([
      expect.objectContaining({ entryId: id, start: NINE, end: NINE + 30 * MIN, status: "open" }),
      expect.objectContaining({ entryId: id, start: NINE + HOUR, end: null }),
    ]);
    expect(week.untimed).toEqual([
      expect.objectContaining({ userId: bob, jobName: "Other Co:Service", seconds: 7200, workDate: WED }),
    ]);
    expect(calendarWeek(SUN, { userIds: [bob] }, NINE).blocks).toHaveLength(0);
  });
});
