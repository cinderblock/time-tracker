import { beforeEach, describe, expect, test } from "bun:test";

import { db } from "./db.server.ts";
import { getEntry, getOpenEntry, listEntriesForDate, totalsByDate } from "./entries.ts";
import { loadDay } from "../app/tracker.server.ts";
import { getJob, listJobs, recentJobIds, updateJob } from "./jobs.ts";
import { listNotesForDate, pendingNotesBefore } from "./notes.ts";
import { applyOp, applyOps } from "./ops.ts";
import type { OpPayload, OpResult, OpType } from "./ops-schema.ts";
import { proposeRollup, rollupProblems } from "./rollup.ts";
import { setRequireNoteOnStop } from "./settings.ts";
import { freshDb } from "./testing/db.ts";
import { createUser, setTrackingMode } from "./users.ts";
import { uuidv7, uuidv7Time } from "./uuid.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
// 2026-09-16 09:00 in America/Los_Angeles is 16:00 UTC.
const NINE = Date.parse("2026-09-16T16:00:00Z");
const TODAY = "2026-09-16";

let userId = 0;
let customer = "";
let jobA = "";
let jobB = "";

beforeEach(() => {
  process.env.TZ = "America/Los_Angeles";
  freshDb();
  userId = createUser({ name: "Worker", role: "employee", actorUserId: null }).id;
  customer = uuidv7();
  jobA = uuidv7();
  jobB = uuidv7();
  ok(send("job.create", { jobId: customer, name: "Acme" }));
  ok(send("job.create", { jobId: jobA, name: "Alpha", parentId: customer }));
  ok(send("job.create", { jobId: jobB, name: "Bravo", parentId: customer }));
});

function send<T extends OpType>(type: T, payload: OpPayload<T>, as = userId, opId = uuidv7()): OpResult {
  return applyOp(as, { opId, type, deviceId: "test-device", clientTime: NINE, payload }, NINE);
}

function ok(result: OpResult): OpResult {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.error}`);
  return result;
}

function rejected(result: OpResult, code: string): string {
  expect(result.ok).toBe(false);
  if (result.ok) return "";
  expect(result.code).toBe(code as never);
  return result.error;
}

describe("uuidv7", () => {
  test("is a valid v7 id carrying its timestamp, and sorts by time", () => {
    const a = uuidv7(NINE);
    const b = uuidv7(NINE + 1);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidv7Time(a)).toBe(NINE);
    expect(a < b).toBe(true);
  });

  test("ids made in the same millisecond sort in the order they were made", () => {
    const ids = Array.from({ length: 500 }, () => uuidv7(NINE + 5));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(uuidv7Time(id)).toBe(NINE + 5);
    }
  });

  test("an earlier time is kept as given", () => {
    uuidv7(NINE + 10);
    const earlier = uuidv7(NINE + 9);
    expect(uuidv7Time(earlier)).toBe(NINE + 9);
    expect(earlier < uuidv7(NINE + 10)).toBe(true);
  });
});

describe("timers", () => {
  test("start, pause, resume, stop — pauses are real gaps", () => {
    const id = uuidv7();
    ok(send("timer.start", { entryId: id, jobId: jobA, at: NINE }));
    expect(getOpenEntry(userId)?.id).toBe(id);
    ok(send("timer.pause", { entryId: id, at: NINE + 30 * MIN }));
    ok(send("timer.resume", { entryId: id, at: NINE + 45 * MIN }));
    ok(send("timer.stop", { entryId: id, at: NINE + 75 * MIN }));

    const entry = getEntry(id)!;
    expect(entry.status).toBe("draft");
    expect(entry.durationSeconds).toBe(60 * 60); // 30 + 30 minutes, not 75
    expect(entry.segments).toHaveLength(2);
    expect(entry.workDate).toBe(TODAY);
    expect(getOpenEntry(userId)).toBeNull();
  });

  test("starting another timer switches: the first stops at the same instant", () => {
    const first = uuidv7();
    const second = uuidv7();
    ok(send("timer.start", { entryId: first, jobId: jobA, at: NINE }));
    ok(send("timer.start", { entryId: second, jobId: jobB, at: NINE + 20 * MIN }));

    expect(getEntry(first)!.status).toBe("draft");
    expect(getEntry(first)!.durationSeconds).toBe(20 * 60);
    expect(getEntry(first)!.segments[0]!.endedAt).toBe(NINE + 20 * MIN);
    expect(getOpenEntry(userId)?.id).toBe(second);
  });

  test("the work date is the local date the timer started, even late at night", () => {
    const id = uuidv7();
    const lateEvening = Date.parse("2026-09-17T05:30:00Z"); // 22:30 on the 16th in LA
    ok(send("timer.start", { entryId: id, jobId: jobA, at: lateEvening }));
    ok(send("timer.stop", { entryId: id, at: lateEvening + 2 * HOUR }));
    expect(getEntry(id)!.workDate).toBe(TODAY);
  });

  test("impossible transitions are rejected, not silently fixed", () => {
    const id = uuidv7();
    rejected(send("timer.stop", { entryId: id, at: NINE }), "not_found");
    ok(send("timer.start", { entryId: id, jobId: jobA, at: NINE }));
    rejected(send("timer.resume", { entryId: id, at: NINE + MIN }), "conflict");
    rejected(send("timer.pause", { entryId: id, at: NINE - MIN }), "conflict"); // before start
    rejected(send("timer.stop", { entryId: id, at: NINE - MIN }), "conflict");
    ok(send("timer.stop", { entryId: id, at: NINE + MIN }));
    rejected(send("timer.stop", { entryId: id, at: NINE + 2 * MIN }), "conflict");
    rejected(send("timer.start", { entryId: id, jobId: jobA, at: NINE + 3 * MIN }), "conflict");
  });

  test("a closed job can't take new time", () => {
    const admin = createUser({ name: "Admin", role: "admin", actorUserId: null });
    updateJob({ id: jobA, active: false, actorUserId: admin.id });
    const error = rejected(send("timer.start", { entryId: uuidv7(), jobId: jobA, at: NINE }), "conflict");
    expect(error).toContain("Alpha");
    rejected(send("timer.start", { entryId: uuidv7(), jobId: uuidv7(), at: NINE }), "not_found");
  });

  test("another person's timer is invisible", () => {
    const other = createUser({ name: "Other", role: "employee", actorUserId: null }).id;
    const id = uuidv7();
    ok(send("timer.start", { entryId: id, jobId: jobA, at: NINE }, other));
    rejected(send("timer.stop", { entryId: id, at: NINE + MIN }), "not_found");
    rejected(send("entry.delete", { entryId: id, at: NINE + MIN }), "not_found");
    expect(getOpenEntry(other)?.id).toBe(id);
  });
});

describe("required notes", () => {
  test("a job that requires a note refuses a bare stop, including a switch", () => {
    const admin = createUser({ name: "Admin", role: "admin", actorUserId: null });
    updateJob({ id: jobA, requiresNote: true, actorUserId: admin.id });
    const id = uuidv7();
    ok(send("timer.start", { entryId: id, jobId: jobA, at: NINE }));

    rejected(send("timer.stop", { entryId: id, at: NINE + MIN }), "note_required");
    rejected(send("timer.start", { entryId: uuidv7(), jobId: jobB, at: NINE + MIN }), "note_required");
    rejected(send("timer.stop", { entryId: id, at: NINE + MIN, note: "   " }), "note_required");
    expect(getOpenEntry(userId)?.id).toBe(id); // nothing half-applied

    ok(send("timer.stop", { entryId: id, at: NINE + MIN, note: "Fixed the gate" }));
    expect(getEntry(id)!.note).toBe("Fixed the gate");
  });

  test("a note given at start satisfies the requirement", () => {
    setRequireNoteOnStop(true, null);
    const id = uuidv7();
    ok(send("timer.start", { entryId: id, jobId: jobA, at: NINE, note: "Framing" }));
    ok(send("timer.stop", { entryId: id, at: NINE + MIN }));
  });

  test("the global setting applies to every job", () => {
    setRequireNoteOnStop(true, null);
    const id = uuidv7();
    ok(send("timer.start", { entryId: id, jobId: jobB, at: NINE }));
    rejected(send("timer.stop", { entryId: id, at: NINE + MIN }), "note_required");
  });
});

describe("manual entries and edits", () => {
  test("by start and end", () => {
    const id = uuidv7();
    ok(send("entry.create", { entryId: id, jobId: jobA, startedAt: NINE, endedAt: NINE + 90 * MIN, note: "Site visit" }));
    const e = getEntry(id)!;
    expect(e.source).toBe("manual");
    expect(e.durationSeconds).toBe(90 * 60);
    expect(e.workDate).toBe(TODAY);
  });

  test("by date and duration", () => {
    const id = uuidv7();
    ok(send("entry.create", { entryId: id, jobId: jobA, workDate: "2026-09-10", durationSeconds: 3600 }));
    expect(getEntry(id)!.workDate).toBe("2026-09-10");
    expect(getEntry(id)!.segments).toHaveLength(0);
  });

  test("rejects a mix of both, backwards spans and over-long spans", () => {
    rejected(
      send("entry.create", { entryId: uuidv7(), jobId: jobA, startedAt: NINE, endedAt: NINE + MIN, durationSeconds: 60 }),
      "invalid",
    );
    rejected(send("entry.create", { entryId: uuidv7(), jobId: jobA, startedAt: NINE, endedAt: NINE }), "invalid");
    rejected(send("entry.create", { entryId: uuidv7(), jobId: jobA, startedAt: NINE, endedAt: NINE + 25 * HOUR }), "invalid");
    rejected(send("entry.create", { entryId: uuidv7(), jobId: jobA, workDate: "Tuesday", durationSeconds: 60 }), "invalid");
  });

  test("editing times moves the span and the work date with it", () => {
    const id = uuidv7();
    ok(send("entry.create", { entryId: id, jobId: jobA, startedAt: NINE, endedAt: NINE + HOUR }));
    ok(send("entry.update", { entryId: id, startedAt: NINE - 24 * HOUR, endedAt: NINE - 22 * HOUR, jobId: jobB, note: "moved" }));
    const e = getEntry(id)!;
    expect(e.workDate).toBe("2026-09-15");
    expect(e.durationSeconds).toBe(2 * 3600);
    expect(e.jobId).toBe(jobB);
    expect(e.note).toBe("moved");

    ok(send("entry.update", { entryId: id, note: null }));
    expect(getEntry(id)!.note).toBeNull();
    rejected(send("entry.update", { entryId: id, durationSeconds: 60 }), "invalid");
    rejected(send("entry.update", { entryId: id, endedAt: NINE - 30 * HOUR }), "invalid");
  });

  test("a running timer's end can't be edited, but its start can", () => {
    const id = uuidv7();
    ok(send("timer.start", { entryId: id, jobId: jobA, at: NINE }));
    rejected(send("entry.update", { entryId: id, endedAt: NINE + HOUR }), "conflict");
    ok(send("entry.update", { entryId: id, startedAt: NINE - 15 * MIN }));
    expect(getEntry(id)!.segments[0]!.startedAt).toBe(NINE - 15 * MIN);
  });

  test("duration-only entries change by duration and date, not times", () => {
    const id = uuidv7();
    ok(send("entry.create", { entryId: id, jobId: jobA, workDate: TODAY, durationSeconds: 3600 }));
    ok(send("entry.update", { entryId: id, durationSeconds: 5400, workDate: "2026-09-15" }));
    expect(getEntry(id)!.durationSeconds).toBe(5400);
    rejected(send("entry.update", { entryId: id, startedAt: NINE }), "invalid");
  });
});

describe("an entry changing shape", () => {
  test("a stopped timer becomes a plain duration, keeping its job and note", () => {
    const id = uuidv7();
    ok(send("timer.start", { entryId: id, jobId: jobA, at: NINE }));
    ok(send("timer.pause", { entryId: id, at: NINE + 30 * MIN }));
    ok(send("timer.resume", { entryId: id, at: NINE + 45 * MIN }));
    ok(send("timer.stop", { entryId: id, at: NINE + HOUR, note: "Framing" }));
    expect(getEntry(id)!.segments).toHaveLength(2);

    ok(send("entry.update", { entryId: id, convertTo: "duration", durationSeconds: 2 * 3600 }));
    const e = getEntry(id)!;
    // The pauses go with the times; that is what was asked for.
    expect(e.segments).toHaveLength(0);
    expect(e.durationSeconds).toBe(2 * 3600);
    expect(e.workDate).toBe(TODAY);
    expect(e.jobId).toBe(jobA);
    expect(e.note).toBe("Framing");
    // Where it came from is a fact about it, not something to tidy away.
    expect(e.source).toBe("timer");
  });

  test("and back again, the work date following the new start", () => {
    const id = uuidv7();
    ok(send("entry.create", { entryId: id, jobId: jobA, workDate: TODAY, durationSeconds: 3600 }));
    ok(
      send("entry.update", {
        entryId: id,
        convertTo: "times",
        startedAt: NINE - 24 * HOUR,
        endedAt: NINE - 21 * HOUR,
      }),
    );
    const e = getEntry(id)!;
    expect(e.segments).toHaveLength(1);
    // Taken from the span, not from what the duration used to be.
    expect(e.durationSeconds).toBe(3 * 3600);
    expect(e.workDate).toBe("2026-09-15");
  });

  test("the job, the note and the date can change in the same breath", () => {
    const id = uuidv7();
    ok(send("entry.create", { entryId: id, jobId: jobA, startedAt: NINE, endedAt: NINE + HOUR }));
    ok(
      send("entry.update", {
        entryId: id,
        convertTo: "duration",
        durationSeconds: 90 * 60,
        workDate: "2026-09-14",
        jobId: jobB,
        note: "Guessed",
      }),
    );
    const e = getEntry(id)!;
    expect(e.durationSeconds).toBe(90 * 60);
    expect(e.workDate).toBe("2026-09-14");
    expect(e.jobId).toBe(jobB);
    expect(e.note).toBe("Guessed");
  });

  test("a running timer has to be stopped first", () => {
    const id = uuidv7();
    ok(send("timer.start", { entryId: id, jobId: jobA, at: NINE }));
    rejected(send("entry.update", { entryId: id, convertTo: "duration", durationSeconds: 3600 }), "conflict");
    expect(getEntry(id)!.segments).toHaveLength(1);
  });

  test("each direction needs the fields that shape is made of", () => {
    const id = uuidv7();
    ok(send("entry.create", { entryId: id, jobId: jobA, startedAt: NINE, endedAt: NINE + HOUR }));
    rejected(send("entry.update", { entryId: id, convertTo: "duration" }), "invalid");
    rejected(send("entry.update", { entryId: id, convertTo: "times", startedAt: NINE }), "invalid");
    // A backwards span is no more allowed here than anywhere else.
    const plain = uuidv7();
    ok(send("entry.create", { entryId: plain, jobId: jobA, workDate: TODAY, durationSeconds: 3600 }));
    rejected(send("entry.update", { entryId: plain, convertTo: "times", startedAt: NINE, endedAt: NINE }), "invalid");
  });

  test("asking for the shape it already has is an ordinary edit", () => {
    const id = uuidv7();
    ok(send("entry.create", { entryId: id, jobId: jobA, startedAt: NINE, endedAt: NINE + HOUR }));
    // No second segment, and no duplicate span: this is just an edit.
    ok(send("entry.update", { entryId: id, convertTo: "times", startedAt: NINE, endedAt: NINE + 2 * HOUR }));
    const e = getEntry(id)!;
    expect(e.segments).toHaveLength(1);
    expect(e.durationSeconds).toBe(2 * 3600);
  });

  test("without asking, the shape still can't be changed by accident", () => {
    const id = uuidv7();
    ok(send("entry.create", { entryId: id, jobId: jobA, startedAt: NINE, endedAt: NINE + HOUR }));
    rejected(send("entry.update", { entryId: id, durationSeconds: 7200 }), "invalid");
    expect(getEntry(id)!.segments).toHaveLength(1);
    expect(getEntry(id)!.durationSeconds).toBe(3600);
  });

  test("submitted time can't change shape either", () => {
    const id = uuidv7();
    ok(send("entry.create", { entryId: id, jobId: jobA, startedAt: NINE, endedAt: NINE + HOUR }));
    ok(send("day.submit", { workDate: TODAY }));
    rejected(send("entry.update", { entryId: id, convertTo: "duration", durationSeconds: 3600 }), "conflict");
  });
});

describe("delete and undo", () => {
  test("an accidental timer is deleted without fuss and undone seamlessly", () => {
    const id = uuidv7();
    ok(send("timer.start", { entryId: id, jobId: jobA, at: NINE }));
    ok(send("entry.delete", { entryId: id, at: NINE + MIN }));
    expect(getOpenEntry(userId)).toBeNull();
    expect(listEntriesForDate(userId, TODAY)).toHaveLength(0);

    ok(send("entry.restore", { entryId: id, at: NINE + MIN + 5000 }));
    const restored = getOpenEntry(userId)!;
    expect(restored.id).toBe(id);
    expect(restored.segments[0]!.endedAt).toBeNull(); // still running from the original start
  });

  test("a deleted timer comes back stopped if another has started since", () => {
    const first = uuidv7();
    const second = uuidv7();
    ok(send("timer.start", { entryId: first, jobId: jobA, at: NINE }));
    ok(send("entry.delete", { entryId: first, at: NINE + 10 * MIN }));
    ok(send("timer.start", { entryId: second, jobId: jobB, at: NINE + 11 * MIN }));
    ok(send("entry.restore", { entryId: first, at: NINE + 12 * MIN }));

    expect(getEntry(first)!.status).toBe("draft");
    expect(getEntry(first)!.durationSeconds).toBe(10 * 60);
    expect(getOpenEntry(userId)?.id).toBe(second);
  });

  test("deletes are soft: the row and its history remain", () => {
    const id = uuidv7();
    ok(send("entry.create", { entryId: id, jobId: jobA, workDate: TODAY, durationSeconds: 60 }));
    ok(send("entry.delete", { entryId: id, at: NINE }));
    expect(getEntry(id)!.deletedAt).toBe(NINE);
    rejected(send("entry.update", { entryId: id, note: "x" }), "not_found");
    ok(send("entry.restore", { entryId: id, at: NINE }));
    ok(send("entry.restore", { entryId: id, at: NINE })); // restoring twice is harmless
  });
});

describe("the op ledger", () => {
  test("replaying an op has no second effect and returns the same answer", () => {
    const opId = uuidv7();
    const entryId = uuidv7();
    const first = send("timer.start", { entryId, jobId: jobA, at: NINE }, userId, opId);
    const again = send("timer.start", { entryId, jobId: jobA, at: NINE }, userId, opId);
    expect(again).toEqual(first);
    expect(db().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM time_entries").get()!.n).toBe(1);
  });

  test("rejections are recorded, so a replay is rejected the same way", () => {
    const opId = uuidv7();
    const first = send("timer.stop", { entryId: uuidv7(), at: NINE }, userId, opId);
    expect(send("timer.stop", { entryId: uuidv7(), at: NINE }, userId, opId)).toEqual(first);
  });

  test("keeps the payload, device and outcome of every op", () => {
    const entryId = uuidv7();
    send("timer.start", { entryId, jobId: jobA, at: NINE });
    const row = db()
      .query<{ type: string; device_id: string; payload_json: string; ok: number }, []>(
        "SELECT type, device_id, payload_json, ok FROM applied_ops WHERE type = 'timer.start'",
      )
      .get()!;
    expect(row.device_id).toBe("test-device");
    expect(row.ok).toBe(1);
    expect(JSON.parse(row.payload_json).entryId).toBe(entryId);
  });

  test("someone else's op id is refused", () => {
    const other = createUser({ name: "Other", role: "employee", actorUserId: null }).id;
    const opId = uuidv7();
    ok(send("timer.start", { entryId: uuidv7(), jobId: jobA, at: NINE }, userId, opId));
    rejected(send("timer.start", { entryId: uuidv7(), jobId: jobA, at: NINE }, other, opId), "forbidden");
  });

  test("malformed ops are refused with a readable reason", () => {
    const bad = applyOp(userId, { opId: "nope", type: "timer.start", deviceId: "d", clientTime: 0, payload: {} });
    expect(bad.ok).toBe(false);
    const badPayload = send("timer.start", { entryId: "not-a-uuid", jobId: jobA, at: NINE } as never);
    expect(rejected(badPayload, "invalid")).toContain("entryId");
    const badTime = send("timer.start", { entryId: uuidv7(), jobId: jobA, at: 1_700_000 });
    expect(rejected(badTime, "invalid")).toContain("out of range");
    expect(applyOp(userId, { opId: uuidv7(), type: "time.travel", deviceId: "d", clientTime: 0, payload: {} }).ok).toBe(
      false,
    );
  });

  test("a batch applies in order and one rejection doesn't stop the rest", () => {
    const a = uuidv7();
    const results = applyOps(
      userId,
      [
        { opId: uuidv7(), type: "timer.start", deviceId: "d", clientTime: NINE, payload: { entryId: a, jobId: jobA, at: NINE } },
        { opId: uuidv7(), type: "timer.resume", deviceId: "d", clientTime: NINE, payload: { entryId: a, at: NINE } },
        { opId: uuidv7(), type: "timer.stop", deviceId: "d", clientTime: NINE, payload: { entryId: a, at: NINE + MIN } },
      ],
      NINE,
    );
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(getEntry(a)!.status).toBe("draft");
    expect(() => applyOps(userId, "nope")).toThrow();
  });
});

describe("jobs", () => {
  test("names are unique per level, case-insensitively, and can't contain ':'", () => {
    rejected(send("job.create", { jobId: uuidv7(), name: "alpha", parentId: customer }), "conflict");
    rejected(send("job.create", { jobId: uuidv7(), name: "ACME" }), "conflict");
    rejected(send("job.create", { jobId: uuidv7(), name: "A:B" }), "invalid");
    const child = uuidv7();
    ok(send("job.create", { jobId: child, name: "Alpha", parentId: jobB }));
    expect(getJob(child)!.fullName).toBe("Acme:Bravo:Alpha");
    expect(getJob(child)!.provisional).toBe(false); // no accounting backend to link to
    expect(getJob(child)).toMatchObject({ customerId: customer, bookable: true });
  });

  test("time goes on jobs, never on a customer", () => {
    expect(getJob(customer)).toMatchObject({ open: true, bookable: false, customerId: customer });
    expect(getJob(jobA)).toMatchObject({ open: true, bookable: true, customerId: customer });
    const error = rejected(send("timer.start", { entryId: uuidv7(), jobId: customer, at: NINE }), "conflict");
    expect(error).toContain("is a customer");
    rejected(send("entry.create", { entryId: uuidv7(), jobId: customer, workDate: TODAY, durationSeconds: 60 }), "conflict");
    rejected(send("note.create", { noteId: uuidv7(), at: NINE, text: "x", jobId: customer }), "conflict");
    expect(listEntriesForDate(userId, TODAY)).toHaveLength(0);
  });

  test("a job that holds sub-jobs takes no hours itself, unless an admin says otherwise", () => {
    const admin = createUser({ name: "Admin", role: "admin", actorUserId: null });
    const sub = uuidv7();
    ok(send("job.create", { jobId: sub, name: "Punch list", parentId: jobA }));
    // The default follows the tree: hours go on the sub-job, not on Alpha.
    expect(getJob(jobA)).toMatchObject({ hasSubJobs: true, takesTime: null, bookable: false });
    expect(getJob(sub)).toMatchObject({ hasSubJobs: false, takesTime: null, bookable: true });
    const refused = rejected(send("timer.start", { entryId: uuidv7(), jobId: jobA, at: NINE }), "conflict");
    expect(refused).toContain("only holds its sub-jobs");
    // The name in the refusal is written for people, so never with a ":".
    expect(refused).toContain("Acme › Alpha");

    // An admin can say this one takes hours anyway…
    updateJob({ id: jobA, takesTime: true, actorUserId: admin.id });
    expect(getJob(jobA)).toMatchObject({ takesTime: true, bookable: true });
    const id = uuidv7();
    ok(send("timer.start", { entryId: id, jobId: jobA, at: NINE }));
    ok(send("timer.stop", { entryId: id, at: NINE + MIN }));

    // …and back to the default, which still says no.
    updateJob({ id: jobA, takesTime: null, actorUserId: admin.id });
    expect(getJob(jobA)).toMatchObject({ takesTime: null, bookable: false });
    // Time already booked stays where it is.
    expect(getEntry(id)!.jobId).toBe(jobA);

    // The same answer the other way: a job with no sub-jobs that takes none.
    updateJob({ id: jobB, takesTime: false, actorUserId: admin.id });
    expect(getJob(jobB)).toMatchObject({ hasSubJobs: false, bookable: false });
    rejected(send("entry.create", { entryId: uuidv7(), jobId: jobB, workDate: TODAY, durationSeconds: 60 }), "conflict");

    // A customer never takes hours, so there is nothing to answer there.
    expect(() => updateJob({ id: customer, takesTime: true, actorUserId: admin.id })).toThrow("A customer never takes hours");
  });

  test("a customer's note rule applies to its jobs, and closing it closes them", () => {
    const admin = createUser({ name: "Admin", role: "admin", actorUserId: null });
    updateJob({ id: customer, requiresNote: true, actorUserId: admin.id });
    expect(getJob(jobA)).toMatchObject({ requiresNote: false, noteRequired: true });
    const id = uuidv7();
    ok(send("timer.start", { entryId: id, jobId: jobA, at: NINE }));
    rejected(send("timer.stop", { entryId: id, at: NINE + MIN }), "note_required");
    ok(send("timer.stop", { entryId: id, at: NINE + MIN, note: "Done" }));
    expect(recentJobIds(userId)).toEqual([jobA]);

    updateJob({ id: customer, active: false, actorUserId: admin.id });
    expect(getJob(jobA)).toMatchObject({ active: true, open: false, bookable: false });
    expect(rejected(send("timer.start", { entryId: uuidv7(), jobId: jobA, at: NINE }), "conflict")).toContain("closed customer");
    expect(listJobs()).toEqual([]);
    expect(listJobs({ includeInactive: true }).map((j) => j.name)).toEqual(["Acme", "Alpha", "Bravo"]);
    expect(recentJobIds(userId)).toEqual([]);

    updateJob({ id: customer, active: true, actorUserId: admin.id });
    expect(getJob(jobA)!.bookable).toBe(true);
  });

  test("recent jobs follow what the person last booked", () => {
    ok(send("entry.create", { entryId: uuidv7(), jobId: jobA, workDate: TODAY, durationSeconds: 60 }));
    ok(send("entry.create", { entryId: uuidv7(), jobId: jobB, workDate: TODAY, durationSeconds: 60 }));
    // created_at comes from the op's server time; give the second a later one.
    db().query("UPDATE time_entries SET created_at = created_at + 1000 WHERE job_id = ?").run(jobB);
    expect(recentJobIds(userId)).toEqual([jobB, jobA]);
    expect(listJobs().map((j) => j.name)).toEqual(["Acme", "Alpha", "Bravo"]);
  });
});

describe("totals", () => {
  test("sum live entries per date, ignoring deleted ones", () => {
    ok(send("entry.create", { entryId: uuidv7(), jobId: jobA, workDate: TODAY, durationSeconds: 1800 }));
    const gone = uuidv7();
    ok(send("entry.create", { entryId: gone, jobId: jobA, workDate: TODAY, durationSeconds: 999 }));
    ok(send("entry.delete", { entryId: gone, at: NINE }));
    ok(send("entry.create", { entryId: uuidv7(), jobId: jobB, workDate: "2026-09-15", durationSeconds: 60 }));
    const totals = totalsByDate(userId, "2026-09-14", TODAY);
    expect(totals.get(TODAY)).toBe(1800);
    expect(totals.get("2026-09-15")).toBe(60);
  });
});

describe("notes and rollup", () => {
  const n = (id: string, at: number, jobId: string | null, text = id) => ({ id, at, jobId, text });

  test("each note runs until the next; same-job neighbours merge; the last runs to the end", () => {
    const lines = proposeRollup(
      [
        n("c", NINE + 2 * HOUR, "B"),
        n("a", NINE, "A"),
        n("b", NINE + HOUR, "A", "still A"),
        n("d", NINE + 3 * HOUR, null, "lunch"),
      ],
      NINE + 5 * HOUR,
    );
    expect(lines.map((l) => [l.jobId, (l.endedAt - l.startedAt) / HOUR, l.noteIds])).toEqual([
      ["A", 2, ["a", "b"]],
      ["B", 1, ["c"]],
      [null, 2, ["d"]],
    ]);
    expect(lines[0]!.note).toBe("a; still A");
  });

  test("jobless notes don't merge, and the end never precedes the last note", () => {
    const lines = proposeRollup([n("a", NINE, null), n("b", NINE + HOUR, null)], NINE);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endedAt).toBe(lines[1]!.startedAt);
    expect(rollupProblems(lines)).toContain("Every line needs a job (or remove the line).");
    expect(rollupProblems(lines)).toContain("Every line must end after it starts.");
    expect(proposeRollup([], NINE)).toEqual([]);
  });

  test("overlapping lines are a problem", () => {
    expect(
      rollupProblems([
        { jobId: "a", startedAt: 0, endedAt: 10 },
        { jobId: "b", startedAt: 5, endedAt: 20 },
      ]),
    ).toEqual(["Two lines overlap."]);
  });

  test("committing creates entries and freezes the notes", () => {
    const [n1, n2, n3] = [uuidv7(), uuidv7(), uuidv7()];
    ok(send("note.create", { noteId: n1, at: NINE, text: "Framing", jobId: jobA }));
    ok(send("note.create", { noteId: n2, at: NINE + HOUR, text: "More framing", jobId: jobA }));
    ok(send("note.create", { noteId: n3, at: NINE + 2 * HOUR, text: "Bravo punch list", jobId: jobB }));

    const notes = listNotesForDate(userId, TODAY);
    const lines = proposeRollup(notes, NINE + 4 * HOUR).map((l) => ({
      entryId: uuidv7(),
      jobId: l.jobId!,
      startedAt: l.startedAt,
      endedAt: l.endedAt,
      note: l.note,
      noteIds: l.noteIds,
    }));
    const result = ok(send("rollup.commit", { workDate: TODAY, lines }));
    expect((result as { data: { entryIds: string[] } }).data.entryIds).toHaveLength(2);

    const entries = listEntriesForDate(userId, TODAY);
    expect(entries.map((e) => [e.source, e.durationSeconds / 3600, e.note])).toEqual([
      ["note_rollup", 2, "Framing; More framing"],
      ["note_rollup", 2, "Bravo punch list"],
    ]);
    expect(listNotesForDate(userId, TODAY).every((x) => x.rolledIntoEntryId)).toBe(true);

    // Frozen: can't edit, delete, or roll up again.
    rejected(send("note.update", { noteId: n1, text: "changed" }), "conflict");
    rejected(send("note.delete", { noteId: n1, at: NINE }), "conflict");
    rejected(send("rollup.commit", { workDate: TODAY, lines: [{ ...lines[0]!, entryId: uuidv7() }] }), "conflict");
  });

  test("a failed commit changes nothing", () => {
    const note = uuidv7();
    ok(send("note.create", { noteId: note, at: NINE, text: "Framing", jobId: jobA }));
    const closed = uuidv7();
    ok(send("job.create", { jobId: closed, name: "Closed", parentId: customer }));
    const admin = createUser({ name: "Admin", role: "admin", actorUserId: null });
    updateJob({ id: closed, active: false, actorUserId: admin.id });

    rejected(
      send("rollup.commit", {
        workDate: TODAY,
        lines: [{ entryId: uuidv7(), jobId: closed, startedAt: NINE, endedAt: NINE + HOUR, noteIds: [note] }],
      }),
      "conflict",
    );
    expect(listEntriesForDate(userId, TODAY)).toHaveLength(0);
    expect(listNotesForDate(userId, TODAY)[0]!.rolledIntoEntryId).toBeNull();
  });

  test("a start marker bounds the timeline but adds no words; duration lines are checked too", () => {
    const lines = proposeRollup(
      [
        { id: "s", at: NINE, text: "", jobId: jobA },
        { id: "a", at: NINE + HOUR, text: "Framing", jobId: jobA },
        { id: "b", at: NINE + 2 * HOUR, text: "", jobId: jobB },
      ],
      NINE + 3 * HOUR,
    );
    expect(lines.map((l) => [l.jobId, l.startedAt, l.endedAt, l.note])).toEqual([
      [jobA, NINE, NINE + 2 * HOUR, "Framing"],
      [jobB, NINE + 2 * HOUR, NINE + 3 * HOUR, ""],
    ]);
    expect(rollupProblems([{ jobId: jobA, durationSeconds: 3600 }])).toEqual([]);
    expect(rollupProblems([{ jobId: jobA, durationSeconds: 0 }])).toContain("Every line needs some time.");
    expect(rollupProblems([{ jobId: jobA, durationSeconds: 25 * 3600 }])).toContain("A line can't be longer than 24 hours.");
    expect(rollupProblems([{ jobId: jobA, startedAt: NINE }])).toContain("A line needs both a start and an end, or a duration.");
  });

  test("a start marks being on a job; its notes become hours as one entry with the notes as the description", () => {
    const start = uuidv7();
    ok(send("note.create", { noteId: start, at: NINE, kind: "start", jobId: jobA }));
    expect(listNotesForDate(userId, TODAY)[0]).toMatchObject({ kind: "start", text: "", jobId: jobA });
    rejected(send("note.create", { noteId: uuidv7(), at: NINE, kind: "start" }), "invalid"); // a start needs a job
    rejected(send("note.create", { noteId: uuidv7(), at: NINE, text: "   ", jobId: jobA }), "invalid"); // a note needs words
    rejected(send("note.update", { noteId: start, text: "Actually" }), "invalid"); // a start has none

    const n1 = uuidv7();
    ok(send("note.create", { noteId: n1, at: NINE + HOUR, text: "Framing", jobId: jobA }));
    const entryId = uuidv7();
    ok(
      send("rollup.commit", {
        workDate: TODAY,
        lines: [{ entryId, jobId: jobA, durationSeconds: 2 * 3600, note: "Framing", noteIds: [start, n1] }],
      }),
    );
    expect(getEntry(entryId)).toMatchObject({
      jobId: jobA,
      workDate: TODAY,
      durationSeconds: 7200,
      note: "Framing",
      source: "note_rollup",
      segments: [],
    });
    expect(listNotesForDate(userId, TODAY).map((n) => n.rolledIntoEntryId)).toEqual([entryId, entryId]);
    // A line is a span or a duration, never neither.
    rejected(
      send("rollup.commit", { workDate: TODAY, lines: [{ entryId: uuidv7(), jobId: jobA, noteIds: [uuidv7()] }] }),
      "invalid",
    );
  });

  test("in notes mode, the latest earlier day with notes not yet turned into time holds later days", () => {
    const yesterday = NINE - 24 * HOUR; // 2026-09-15
    const older = NINE - 4 * 24 * HOUR; // 2026-09-12
    const n1 = uuidv7();
    ok(send("note.create", { noteId: n1, at: yesterday, text: "Framing", jobId: jobA }));
    ok(send("note.create", { noteId: uuidv7(), at: older, text: "Older", jobId: jobA }));
    const gone = uuidv7();
    ok(send("note.create", { noteId: gone, at: yesterday + HOUR, text: "Mistake" }));
    ok(send("note.delete", { noteId: gone, at: NINE }));

    expect(pendingNotesBefore(userId, TODAY)).toEqual({ date: "2026-09-15", count: 1 });
    expect(pendingNotesBefore(userId, "2026-09-15")).toEqual({ date: "2026-09-12", count: 1 });
    expect(pendingNotesBefore(userId, "2026-09-12")).toBeNull();

    // Only in notes mode does the tracking screen hear about it.
    expect(loadDay(userId, TODAY)).toMatchObject({ mode: "timer", notesToRollUp: null });
    setTrackingMode({ userId, mode: "notes", actorUserId: userId });
    expect(loadDay(userId, TODAY)).toMatchObject({ mode: "notes", notesToRollUp: { date: "2026-09-15", count: 1 } });

    ok(
      send("rollup.commit", {
        workDate: "2026-09-15",
        lines: [{ entryId: uuidv7(), jobId: jobA, startedAt: yesterday, endedAt: yesterday + HOUR, noteIds: [n1] }],
      }),
    );
    expect(loadDay(userId, TODAY).notesToRollUp).toEqual({ date: "2026-09-12", count: 1 });
  });

  test("notes from another day, or someone else's, can't be committed", () => {
    const other = createUser({ name: "Other", role: "employee", actorUserId: null }).id;
    const theirs = uuidv7();
    ok(send("note.create", { noteId: theirs, at: NINE, text: "theirs", jobId: jobA }, other));
    rejected(
      send("rollup.commit", {
        workDate: TODAY,
        lines: [{ entryId: uuidv7(), jobId: jobA, startedAt: NINE, endedAt: NINE + HOUR, noteIds: [theirs] }],
      }),
      "not_found",
    );
    const yesterday = uuidv7();
    ok(send("note.create", { noteId: yesterday, at: NINE - 24 * HOUR, text: "old", jobId: jobA }));
    rejected(
      send("rollup.commit", {
        workDate: TODAY,
        lines: [{ entryId: uuidv7(), jobId: jobA, startedAt: NINE, endedAt: NINE + HOUR, noteIds: [yesterday] }],
      }),
      "invalid",
    );
  });

  test("notes can be edited, deleted and restored before rollup", () => {
    const id = uuidv7();
    ok(send("note.create", { noteId: id, at: NINE, text: "  typo  " }));
    expect(listNotesForDate(userId, TODAY)[0]!.text).toBe("typo");
    ok(send("note.update", { noteId: id, text: "fixed", jobId: jobB }));
    expect(listNotesForDate(userId, TODAY)[0]).toMatchObject({ text: "fixed", jobId: jobB });
    ok(send("note.delete", { noteId: id, at: NINE }));
    expect(listNotesForDate(userId, TODAY)).toHaveLength(0);
    ok(send("note.restore", { noteId: id, at: NINE }));
    expect(listNotesForDate(userId, TODAY)).toHaveLength(1);
    rejected(send("note.create", { noteId: uuidv7(), at: NINE, text: "   " }), "invalid");
  });
});
