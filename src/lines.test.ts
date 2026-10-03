import { beforeEach, describe, expect, test } from "bun:test";

import { approveEntries, submitEntries } from "./approvals.ts";
import { db } from "./db.server.ts";
import { getEntry, getOpenEntry, listEntriesForDate } from "./entries.ts";
import { listNotesForDate } from "./notes.ts";
import { applyOp } from "./ops.ts";
import type { OpPayload, OpResult, OpType } from "./ops-schema.ts";
import { setRequireApproval } from "./settings.ts";
import { freshDb } from "./testing/db.ts";
import { createUser } from "./users.ts";
import { uuidv7 } from "./uuid.ts";

/**
 * One line of hours per person, job and day: a timer, a typed-in duration or
 * notes turned into hours all join the job's line when it has one, and the
 * ids the device made stand for that line from then on.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
// 2026-09-16 09:00 in America/Los_Angeles.
const NINE = Date.parse("2026-09-16T16:00:00Z");
const TODAY = "2026-09-16";

let userId = 0;
let admin = 0;
let jobA = "";
let jobB = "";

beforeEach(() => {
  process.env.TZ = "America/Los_Angeles";
  freshDb();
  admin = createUser({ name: "Boss", role: "admin", actorUserId: null }).id;
  userId = createUser({ name: "Worker", role: "employee", actorUserId: admin }).id;
  const customer = uuidv7();
  jobA = uuidv7();
  jobB = uuidv7();
  ok(send("job.create", { jobId: customer, name: "Acme" }));
  ok(send("job.create", { jobId: jobA, name: "Alpha", parentId: customer }));
  ok(send("job.create", { jobId: jobB, name: "Bravo", parentId: customer }));
});

function send<T extends OpType>(type: T, payload: OpPayload<T>, who: number | { userId: number; actorUserId: number } = userId): OpResult {
  return applyOp(who, { opId: uuidv7(), type, deviceId: "test-device", clientTime: NINE, payload }, NINE);
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

const lines = () => listEntriesForDate(userId, TODAY);

/** A stopped timer on a job, from..to (ms offsets from 09:00). */
function timer(jobId: string, from: number, to: number, note?: string): string {
  const entryId = uuidv7();
  ok(send("timer.start", { entryId, jobId, at: NINE + from }));
  ok(send("timer.stop", { entryId, at: NINE + to, ...(note ? { note } : {}) }));
  return entryId;
}

describe("timers", () => {
  test("a job worked again later in the day continues its line, times and all", () => {
    const first = timer(jobA, 0, HOUR, "Framing");
    timer(jobB, HOUR, 2 * HOUR);
    const again = uuidv7();
    ok(send("timer.start", { entryId: again, jobId: jobA, at: NINE + 2 * HOUR, note: "Trim" }));
    // Bravo stopped at the switch; Alpha runs again on its own line.
    expect(getOpenEntry(userId)!.id).toBe(first);
    // The device's id for the new start stands for the line: stopping it stops the line.
    ok(send("timer.stop", { entryId: again, at: NINE + 3 * HOUR }));

    const alpha = getEntry(first)!;
    expect(lines().map((e) => e.jobId)).toEqual([jobA, jobB]);
    expect(alpha.segments.map((s) => [s.startedAt - NINE, s.endedAt! - NINE])).toEqual([
      [0, HOUR],
      [2 * HOUR, 3 * HOUR],
    ]);
    expect(alpha.durationSeconds).toBe(2 * 3600);
    expect(alpha.note).toBe("Framing; Trim");
    expect(alpha.status).toBe("draft");
  });

  test("starting the job that's already running changes nothing; the paused one resumes", () => {
    const id = uuidv7();
    ok(send("timer.start", { entryId: id, jobId: jobA, at: NINE }));
    ok(send("timer.start", { entryId: uuidv7(), jobId: jobA, at: NINE + MIN }));
    expect(getEntry(id)!.segments).toHaveLength(1);

    ok(send("timer.pause", { entryId: id, at: NINE + HOUR }));
    const back = uuidv7();
    ok(send("timer.start", { entryId: back, jobId: jobA, at: NINE + 2 * HOUR }));
    expect(getEntry(id)!.segments.map((s) => s.endedAt)).toEqual([NINE + HOUR, null]);
    ok(send("timer.pause", { entryId: back, at: NINE + 3 * HOUR }));
    expect(getEntry(id)!.durationSeconds).toBe(2 * 3600);
  });

  test("continuing can't start before the line's time already ends", () => {
    timer(jobA, HOUR, 2 * HOUR);
    const error = rejected(send("timer.start", { entryId: uuidv7(), jobId: jobA, at: NINE + HOUR + 30 * MIN }), "conflict");
    expect(error).toContain("already runs past that moment");
  });

  test("stopped the moment it continued — its undo — leaves no empty segment", () => {
    const first = timer(jobA, 0, HOUR);
    const again = uuidv7();
    ok(send("timer.start", { entryId: again, jobId: jobA, at: NINE + 2 * HOUR }));
    ok(send("timer.stop", { entryId: first, at: NINE + 2 * HOUR }));
    expect(getEntry(first)!.segments).toHaveLength(1);
    expect(getEntry(first)!.durationSeconds).toBe(3600);
  });

  test("deleting by the id whose time joined a line is refused — it names only part of it", () => {
    timer(jobA, 0, HOUR);
    const again = uuidv7();
    ok(send("timer.start", { entryId: again, jobId: jobA, at: NINE + 2 * HOUR }));
    expect(rejected(send("entry.delete", { entryId: again, at: NINE + 3 * HOUR }), "conflict")).toContain("added to the job's other hours");
  });
});

describe("typed-in time", () => {
  test("a duration joins a timed line as untimed time; the total is both", () => {
    const first = timer(jobA, 0, HOUR, "Framing");
    const typed = uuidv7();
    ok(send("entry.create", { entryId: typed, jobId: jobA, workDate: TODAY, durationSeconds: 1800, note: "Paperwork" }));
    const line = getEntry(first)!;
    expect(lines()).toHaveLength(1);
    expect([line.durationSeconds, line.untimedSeconds, line.note]).toEqual([5400, 1800, "Framing; Paperwork"]);
    // Its id stands for the line: an edit through it lands there.
    ok(send("entry.update", { entryId: typed, note: "All of it" }));
    expect(getEntry(first)!.note).toBe("All of it");
  });

  test("times join as another segment, never overlapping the line's own", () => {
    const first = timer(jobA, 0, HOUR);
    expect(
      rejected(send("entry.create", { entryId: uuidv7(), jobId: jobA, startedAt: NINE + 30 * MIN, endedAt: NINE + 2 * HOUR }), "conflict"),
    ).toContain("overlap");
    ok(send("entry.create", { entryId: uuidv7(), jobId: jobA, startedAt: NINE + 2 * HOUR, endedAt: NINE + 3 * HOUR }));
    expect(getEntry(first)!.segments).toHaveLength(2);
    expect(getEntry(first)!.durationSeconds).toBe(7200);
  });

  test("no line on one job carries more than 24 hours", () => {
    ok(send("entry.create", { entryId: uuidv7(), jobId: jobA, workDate: TODAY, durationSeconds: 20 * 3600 }));
    expect(rejected(send("entry.create", { entryId: uuidv7(), jobId: jobA, workDate: TODAY, durationSeconds: 5 * 3600 }), "invalid")).toContain(
      "more than 24 hours",
    );
  });

  test("on a line with both, a duration edit sets the total; never below the timed part", () => {
    const first = timer(jobA, 0, HOUR);
    ok(send("entry.create", { entryId: uuidv7(), jobId: jobA, workDate: TODAY, durationSeconds: 1800 }));
    ok(send("entry.update", { entryId: first, durationSeconds: 3 * 3600 }));
    expect([getEntry(first)!.durationSeconds, getEntry(first)!.untimedSeconds]).toEqual([3 * 3600, 2 * 3600]);
    expect(rejected(send("entry.update", { entryId: first, durationSeconds: 1800 }), "invalid")).toContain("less than the timed part");
    // A plain duration again drops the times, as always.
    ok(send("entry.update", { entryId: first, convertTo: "duration", durationSeconds: 3600 }));
    expect([getEntry(first)!.segments.length, getEntry(first)!.untimedSeconds, getEntry(first)!.durationSeconds]).toEqual([0, 3600, 3600]);
  });

  test("moving hours onto a job and day that has a line is refused, not merged", () => {
    timer(jobA, 0, HOUR);
    const b = timer(jobB, HOUR, 2 * HOUR);
    expect(rejected(send("entry.update", { entryId: b, jobId: jobA }), "conflict")).toContain("already has hours");
    expect(getEntry(b)!.jobId).toBe(jobB);
  });
});

describe("notes into hours", () => {
  function note(jobId: string, at: number, text: string): string {
    const noteId = uuidv7();
    ok(send("note.create", { noteId, at: NINE + at, text, jobId }));
    return noteId;
  }

  test("join the job's hours: time added, notes joined, the notes part of that line", () => {
    const first = timer(jobA, 0, HOUR, "Framing");
    const n1 = note(jobA, 2 * HOUR, "Paint");
    const lineId = uuidv7();
    const result = ok(
      send("rollup.commit", { workDate: TODAY, lines: [{ entryId: lineId, jobId: jobA, durationSeconds: 1800, note: "Paint", noteIds: [n1] }] }),
    );
    expect(result.ok && (result.data as { entryIds: string[] }).entryIds).toEqual([first]);
    expect(lines()).toHaveLength(1);
    expect([getEntry(first)!.durationSeconds, getEntry(first)!.note]).toEqual([5400, "Framing; Paint"]);
    expect(listNotesForDate(userId, TODAY).find((n) => n.id === n1)!.rolledIntoEntryId).toBe(first);
  });

  test("with no time added: the notes are attached to hours already counted", () => {
    const first = timer(jobA, 0, HOUR);
    const n1 = note(jobA, 2 * HOUR, "Paint");
    ok(send("rollup.commit", { workDate: TODAY, lines: [{ entryId: uuidv7(), jobId: jobA, durationSeconds: 0, note: "Paint", noteIds: [n1] }] }));
    expect([getEntry(first)!.durationSeconds, getEntry(first)!.note]).toEqual([3600, "Paint"]);
    // With nothing to join, a line still needs time.
    const n2 = note(jobB, 3 * HOUR, "Haul");
    expect(rejected(send("rollup.commit", { workDate: TODAY, lines: [{ entryId: uuidv7(), jobId: jobB, durationSeconds: 0, noteIds: [n2] }] }), "invalid")).toContain(
      "needs some time",
    );
  });

  test("undone by taking back exactly what was added: time, description, and the notes", () => {
    const first = timer(jobA, 0, HOUR, "Framing");
    const n1 = note(jobA, 2 * HOUR, "Paint");
    ok(send("rollup.commit", { workDate: TODAY, lines: [{ entryId: uuidv7(), jobId: jobA, durationSeconds: 1800, note: "Paint", noteIds: [n1] }] }));
    ok(send("entry.unmerge", { entryId: first, removeSeconds: 1800, note: "Framing", releaseNoteIds: [n1] }));
    expect([getEntry(first)!.durationSeconds, getEntry(first)!.untimedSeconds, getEntry(first)!.note]).toEqual([3600, 0, "Framing"]);
    expect(listNotesForDate(userId, TODAY).find((n) => n.id === n1)!.rolledIntoEntryId).toBeNull();
  });

  test("a job's notes are one line: two lines for one job in one commit are refused", () => {
    const n1 = note(jobA, 0, "a");
    const n2 = note(jobA, HOUR, "b");
    expect(
      rejected(
        send("rollup.commit", {
          workDate: TODAY,
          lines: [
            { entryId: uuidv7(), jobId: jobA, durationSeconds: 60, noteIds: [n1] },
            { entryId: uuidv7(), jobId: jobA, durationSeconds: 60, noteIds: [n2] },
          ],
        }),
        "invalid",
      ),
    ).toContain("one line");
  });
});

describe("signed-off lines", () => {
  test("the person's own submission is taken back to add to it; the day then needs submitting again", () => {
    const first = timer(jobA, 0, HOUR);
    submitEntries({ userId, from: TODAY, to: TODAY, actorUserId: userId, now: NINE });
    expect(getEntry(first)!.status).toBe("submitted");
    ok(send("entry.create", { entryId: uuidv7(), jobId: jobA, workDate: TODAY, durationSeconds: 1800 }));
    expect([getEntry(first)!.status, getEntry(first)!.durationSeconds]).toEqual(["draft", 5400]);
  });

  test("time an admin approved isn't the person's to add to; the admin can", () => {
    setRequireApproval(true, admin);
    const first = timer(jobA, 0, HOUR);
    submitEntries({ userId, from: TODAY, to: TODAY, actorUserId: userId, now: NINE });
    approveEntries({ userId, from: TODAY, to: TODAY, actorUserId: admin, now: NINE });
    expect(rejected(send("entry.create", { entryId: uuidv7(), jobId: jobA, workDate: TODAY, durationSeconds: 1800 }), "conflict")).toContain(
      "locked",
    );
    ok(send("entry.create", { entryId: uuidv7(), jobId: jobA, workDate: TODAY, durationSeconds: 1800 }, { userId, actorUserId: admin }));
    expect([getEntry(first)!.status, getEntry(first)!.durationSeconds]).toEqual(["draft", 5400]);
  });
});

describe("old duplicates", () => {
  /** Two lines for one job, as days before this rule could have them. */
  function duplicate(): [string, string] {
    const a = timer(jobA, 0, HOUR, "Morning");
    const b = uuidv7();
    db()
      .query(
        `INSERT INTO time_entries (id, user_id, job_id, work_date, duration_seconds, untimed_seconds, note, source, status, device_id, client_created_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1800, 1800, 'Afternoon', 'manual', 'draft', 'old', ?, ?, ?)`,
      )
      .run(b, userId, jobA, TODAY, NINE, NINE + 1, NINE + 1);
    return [a, b];
  }

  test("combine folds them into the first: time, descriptions, notes, and the other's id", () => {
    const [a, b] = duplicate();
    const n = uuidv7();
    ok(send("note.create", { noteId: n, at: NINE + 5 * HOUR, text: "x", jobId: jobA }));
    db().query("UPDATE day_notes SET rolled_into_entry_id = ? WHERE id = ?").run(b, n);

    ok(send("entry.combine", { intoEntryId: a, entryIds: [b] }));
    expect(lines().map((e) => e.id)).toEqual([a]);
    expect([getEntry(a)!.durationSeconds, getEntry(a)!.note]).toEqual([5400, "Morning; Afternoon"]);
    expect(getEntry(b)!.deletedAt).not.toBeNull();
    expect(listNotesForDate(userId, TODAY)[0]!.rolledIntoEntryId).toBe(a);
    // An op still naming the other lands on the combined line.
    ok(send("entry.update", { entryId: b, note: "Whole day" }));
    expect(getEntry(a)!.note).toBe("Whole day");
  });

  test("not while one is submitted or running", () => {
    const [a, b] = duplicate();
    submitEntries({ userId, from: TODAY, to: TODAY, actorUserId: userId, now: NINE });
    expect(rejected(send("entry.combine", { intoEntryId: a, entryIds: [b] }), "conflict")).toContain("submitted");
  });
});
