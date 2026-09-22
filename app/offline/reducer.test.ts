import { beforeEach, describe, expect, test } from "bun:test";

import { approveEntries } from "../../src/approvals.ts";
import { applyOp } from "../../src/ops.ts";
import type { Op, OpPayload, OpType } from "../../src/ops-schema.ts";
import { freshDb } from "../../src/testing/db.ts";
import { setRequireNoteOnStop, setWeekStartsOn } from "../../src/settings.ts";
import { createUser } from "../../src/users.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { loadDay } from "../tracker.server.ts";
import type { DayModel } from "../tracker/model.ts";
import { applyPending } from "./reducer.ts";

/**
 * The reducer is a mirror of the server. These tests hold it to that: the
 * same ops go through the real server code and through the reducer, and the
 * two resulting day models must match.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const NINE = Date.parse("2026-09-16T16:00:00Z"); // 09:00 in Los Angeles
const DAY = "2026-09-16";

let userId = 0;
let jobA = "";
let jobB = "";

const op = <T extends OpType>(type: T, payload: OpPayload<T>): Op =>
  ({ opId: uuidv7(), type, deviceId: "t", clientTime: NINE, payload }) as Op;

beforeEach(() => {
  freshDb();
  userId = createUser({ name: "W", role: "employee", actorUserId: null }).id;
  const customer = uuidv7();
  jobA = uuidv7();
  jobB = uuidv7();
  for (const [id, name, parentId] of [
    [customer, "Acme", null],
    [jobA, "Alpha", customer],
    [jobB, "Bravo", customer],
  ] as const) {
    const r = applyOp(userId, op("job.create", { jobId: id, name, parentId }), NINE);
    if (!r.ok) throw new Error(r.error);
  }
});

/** The comparable part of a day model. */
function shape(m: DayModel) {
  const entry = (e: DayModel["entries"][number]) => ({ ...e });
  return {
    open: m.open ? entry(m.open) : null,
    entries: m.entries.map(entry),
    notes: m.notes.map((n) => ({ ...n })),
    jobs: m.jobs.map((j) => ({ id: j.id, fullName: j.fullName })),
    week: m.week,
  };
}

/**
 * Run `ops` on the server and through the reducer (from the state before
 * them), and require the same result. Also require that re-applying them to
 * the server's result changes nothing — the reducer's idempotence.
 */
function mirror(ops: Op[], opts: { date?: string; expectRejected?: number } = {}) {
  const date = opts.date ?? DAY;
  const before = loadDay(userId, date);
  let rejected = 0;
  for (const o of ops) if (!applyOp(userId, o, NINE).ok) rejected++;
  expect(rejected).toBe(opts.expectRejected ?? 0);
  const server = loadDay(userId, date);

  const local = applyPending(before, ops);
  expect(shape(local)).toEqual(shape(server));
  expect(shape(applyPending(server, ops))).toEqual(shape(server));
  // Recent jobs are deliberately approximate locally (see touchRecent): every
  // job the server lists must be there, extras are allowed.
  for (const id of server.recentJobIds) expect(local.recentJobIds).toContain(id);
  return server;
}

describe("the reducer mirrors the server", () => {
  test("start, pause, resume, stop", () => {
    const id = uuidv7();
    const m = mirror([
      op("timer.start", { entryId: id, jobId: jobA, at: NINE, note: "  framing " }),
      op("timer.pause", { entryId: id, at: NINE + 30 * MIN }),
      op("timer.resume", { entryId: id, at: NINE + 40 * MIN }),
      op("timer.stop", { entryId: id, at: NINE + 70 * MIN }),
    ]);
    expect(m.entries[0]!.durationSeconds).toBe(60 * 60);
  });

  test("a running and a paused timer", () => {
    const id = uuidv7();
    mirror([op("timer.start", { entryId: id, jobId: jobA, at: NINE })]);
    mirror([op("timer.pause", { entryId: id, at: NINE + 5 * MIN })]);
    mirror([op("timer.stop", { entryId: id, at: NINE + 50 * MIN, note: "done" })]);
  });

  test("switching jobs", () => {
    const [a, b] = [uuidv7(), uuidv7()];
    mirror([
      op("timer.start", { entryId: a, jobId: jobA, at: NINE }),
      op("timer.start", { entryId: b, jobId: jobB, at: NINE + 20 * MIN }),
      op("timer.pause", { entryId: b, at: NINE + 30 * MIN }),
      op("timer.start", { entryId: uuidv7(), jobId: jobA, at: NINE + 45 * MIN }),
    ]);
  });

  test("approved time is locked", () => {
    const [done, other] = [uuidv7(), uuidv7()];
    mirror([
      op("entry.create", { entryId: done, jobId: jobA, startedAt: NINE, endedAt: NINE + HOUR }),
      op("entry.create", { entryId: other, jobId: jobB, workDate: DAY, durationSeconds: 1800 }),
    ]);
    approveEntries({ userId, from: DAY, to: DAY, actorUserId: userId });
    const m = mirror(
      [
        op("entry.update", { entryId: done, note: "too late", endedAt: NINE + 2 * HOUR }),
        op("entry.update", { entryId: other, durationSeconds: 60 }),
        op("entry.delete", { entryId: other, at: NINE }),
      ],
      { expectRejected: 3 },
    );
    expect(m.entries.map((e) => e.status)).toEqual(["approved", "approved"]);
  });

  test("submitting the day locks it, and taking it back frees it again", () => {
    const [a, b] = [uuidv7(), uuidv7()];
    mirror([
      op("entry.create", { entryId: a, jobId: jobA, startedAt: NINE, endedAt: NINE + HOUR }),
      op("entry.create", { entryId: b, jobId: jobB, workDate: DAY, durationSeconds: 1800 }),
    ]);
    const submitted = mirror([op("day.submit", { workDate: DAY })]);
    expect(submitted.entries.map((e) => e.status)).toEqual(["submitted", "submitted"]);

    mirror([op("entry.update", { entryId: b, durationSeconds: 60 })], { expectRejected: 1 });

    const back = mirror([op("day.unsubmit", { workDate: DAY })]);
    expect(back.entries.map((e) => e.status)).toEqual(["draft", "draft"]);
    mirror([op("entry.update", { entryId: b, durationSeconds: 60 })]);
  });

  test("a running timer is left out of a submitted day", () => {
    const running = uuidv7();
    mirror([
      op("entry.create", { entryId: uuidv7(), jobId: jobA, workDate: DAY, durationSeconds: 600 }),
      op("timer.start", { entryId: running, jobId: jobB, at: NINE }),
    ]);
    const m = mirror([op("day.submit", { workDate: DAY })]);
    expect(m.entries.map((e) => e.status).sort()).toEqual(["open", "submitted"]);
  });

  test("an admin's approval isn't the person's to take back", () => {
    const id = uuidv7();
    mirror([op("entry.create", { entryId: id, jobId: jobA, workDate: DAY, durationSeconds: 600 })]);
    approveEntries({ userId, from: DAY, to: DAY, actorUserId: userId });
    const m = mirror([op("day.unsubmit", { workDate: DAY })]);
    expect(m.entries.map((e) => e.status)).toEqual(["approved"]);
  });

  test("submitting an earlier day clears it from the reminder", () => {
    const earlier = "2026-09-15";
    // Set up on the server: the screen only ever dispatches ops for the day
    // it's showing, and the reducer doesn't track other days' entries.
    const made = applyOp(
      userId,
      op("entry.create", { entryId: uuidv7(), jobId: jobA, workDate: earlier, durationSeconds: 600 }),
      NINE,
    );
    if (!made.ok) throw new Error(made.error);
    expect(loadDay(userId, DAY).unsubmittedDays).toEqual([earlier]);
    const m = mirror([op("day.submit", { workDate: earlier })]);
    expect(m.unsubmittedDays).toEqual([]);
  });

  test("weeks start on the configured day", () => {
    setWeekStartsOn(3, userId);
    const m = mirror([op("entry.create", { entryId: uuidv7(), jobId: jobA, workDate: DAY, durationSeconds: 600 })]);
    expect(m.week[0]).toEqual({ date: DAY, seconds: 600 });
    expect(m.week.at(-1)!.date).toBe("2026-09-22");
  });

  test("manual entries, edits, deletes and restores", () => {
    const [timed, plain] = [uuidv7(), uuidv7()];
    mirror([
      op("entry.create", { entryId: timed, jobId: jobA, startedAt: NINE, endedAt: NINE + HOUR, note: "x" }),
      op("entry.create", { entryId: plain, jobId: jobB, workDate: DAY, durationSeconds: 1800 }),
      op("entry.update", { entryId: timed, startedAt: NINE - 30 * MIN, endedAt: NINE + 2 * HOUR, jobId: jobB, note: null }),
      op("entry.update", { entryId: plain, durationSeconds: 2700, note: "paperwork" }),
      op("entry.delete", { entryId: plain, at: NINE + 3 * HOUR }),
      op("entry.restore", { entryId: plain, at: NINE + 3 * HOUR }),
      op("entry.delete", { entryId: timed, at: NINE + 3 * HOUR }),
    ]);
  });

  test("moving an entry to another day takes it off this one", () => {
    const [timed, plain] = [uuidv7(), uuidv7()];
    mirror([
      op("entry.create", { entryId: timed, jobId: jobA, startedAt: NINE, endedAt: NINE + HOUR }),
      op("entry.create", { entryId: plain, jobId: jobA, workDate: DAY, durationSeconds: 600 }),
    ]);
    mirror([
      op("entry.update", { entryId: timed, startedAt: NINE - 25 * HOUR, endedAt: NINE - 24 * HOUR }),
      op("entry.update", { entryId: plain, workDate: "2026-09-15" }),
    ]);
  });

  test("editing a running timer's start", () => {
    const id = uuidv7();
    mirror([op("timer.start", { entryId: id, jobId: jobA, at: NINE })]);
    mirror([op("entry.update", { entryId: id, startedAt: NINE - 20 * MIN, jobId: jobB })]);
  });

  test("a stopped timer, pauses and all, becomes a plain duration", () => {
    const id = uuidv7();
    mirror([
      op("timer.start", { entryId: id, jobId: jobA, at: NINE }),
      op("timer.pause", { entryId: id, at: NINE + 20 * MIN }),
      op("timer.resume", { entryId: id, at: NINE + 40 * MIN }),
      op("timer.stop", { entryId: id, at: NINE + HOUR, note: "framing" }),
    ]);
    mirror([op("entry.update", { entryId: id, convertTo: "duration", durationSeconds: 2 * 3600 })]);
  });

  test("a plain duration gets times, and follows them to another day", () => {
    const id = uuidv7();
    mirror([op("entry.create", { entryId: id, jobId: jobA, workDate: DAY, durationSeconds: 600 })]);
    mirror([
      op("entry.update", {
        entryId: id,
        convertTo: "times",
        startedAt: NINE - 25 * HOUR,
        endedAt: NINE - 24 * HOUR,
        jobId: jobB,
      }),
    ]);
  });

  test("a running timer's shape is refused on both sides", () => {
    const id = uuidv7();
    mirror([op("timer.start", { entryId: id, jobId: jobA, at: NINE })]);
    mirror([op("entry.update", { entryId: id, convertTo: "duration", durationSeconds: 3600 })], {
      expectRejected: 1,
    });
  });

  test("converting to the shape it already has is just an edit", () => {
    const id = uuidv7();
    mirror([op("entry.create", { entryId: id, jobId: jobA, startedAt: NINE, endedAt: NINE + HOUR })]);
    mirror([op("entry.update", { entryId: id, convertTo: "times", startedAt: NINE, endedAt: NINE + 2 * HOUR })]);
  });

  test("editing a paused-and-resumed timer's start and end", () => {
    const id = uuidv7();
    mirror([
      op("timer.start", { entryId: id, jobId: jobA, at: NINE }),
      op("timer.pause", { entryId: id, at: NINE + 10 * MIN }),
      op("timer.resume", { entryId: id, at: NINE + 20 * MIN }),
      op("timer.stop", { entryId: id, at: NINE + 30 * MIN }),
    ]);
    mirror([op("entry.update", { entryId: id, startedAt: NINE - 5 * MIN, endedAt: NINE + 45 * MIN })]);
  });

  test("an accidental timer, discarded and undone", () => {
    const id = uuidv7();
    mirror([
      op("timer.start", { entryId: id, jobId: jobA, at: NINE }),
      op("entry.delete", { entryId: id, at: NINE + MIN }),
      op("entry.restore", { entryId: id, at: NINE + MIN }),
    ]);
  });

  test("a discarded timer restored after another started comes back stopped", () => {
    const [a, b] = [uuidv7(), uuidv7()];
    mirror([
      op("timer.start", { entryId: a, jobId: jobA, at: NINE }),
      op("entry.delete", { entryId: a, at: NINE + 10 * MIN }),
      op("timer.start", { entryId: b, jobId: jobB, at: NINE + 11 * MIN }),
      op("entry.restore", { entryId: a, at: NINE + 12 * MIN }),
    ]);
  });

  test("notes, and rolling them up", () => {
    const [n1, n2, n3] = [uuidv7(), uuidv7(), uuidv7()];
    mirror([
      op("note.create", { noteId: n1, at: NINE, text: " one ", jobId: jobA }),
      op("note.create", { noteId: n2, at: NINE + HOUR, text: "two" }),
      op("note.create", { noteId: n3, at: NINE + 2 * HOUR, text: "three", jobId: jobB }),
      op("note.update", { noteId: n2, text: "two, fixed", jobId: jobA }),
      op("note.delete", { noteId: n3, at: NINE }),
      op("note.restore", { noteId: n3, at: NINE }),
      op("rollup.commit", {
        workDate: DAY,
        lines: [
          { entryId: uuidv7(), jobId: jobA, startedAt: NINE, endedAt: NINE + 2 * HOUR, note: "one; two", noteIds: [n1, n2] },
          { entryId: uuidv7(), jobId: jobB, startedAt: NINE + 2 * HOUR, endedAt: NINE + 3 * HOUR, noteIds: [n3] },
        ],
      }),
    ]);
  });

  test("a note moved to another day leaves this one", () => {
    const n = uuidv7();
    mirror([op("note.create", { noteId: n, at: NINE, text: "x" })]);
    mirror([op("note.update", { noteId: n, at: NINE - 24 * HOUR })]);
  });

  test("a job started for the day, notes under it, and its hours made as one entry", () => {
    const [start, n1, entry] = [uuidv7(), uuidv7(), uuidv7()];
    mirror([
      op("note.create", { noteId: start, at: NINE, kind: "start", jobId: jobA }),
      op("note.create", { noteId: n1, at: NINE + HOUR, text: "Framing", jobId: jobA }),
      op("rollup.commit", {
        workDate: DAY,
        lines: [{ entryId: entry, jobId: jobA, durationSeconds: 5400, note: "Framing", noteIds: [start, n1] }],
      }),
    ]);
  });

  test("a job created on the spot, then used", () => {
    const [child, id] = [uuidv7(), uuidv7()];
    mirror([
      op("job.create", { jobId: child, name: "Phase 2", parentId: jobA }),
      op("timer.start", { entryId: id, jobId: child, at: NINE }),
    ]);
  });

  test("required notes carry through", () => {
    setRequireNoteOnStop(true, null);
    const id = uuidv7();
    mirror([op("timer.start", { entryId: id, jobId: jobA, at: NINE })]);
    mirror([op("timer.stop", { entryId: id, at: NINE + MIN, note: "why" })]);
  });

  test("ops the server rejects change nothing locally either", () => {
    const id = uuidv7();
    mirror([op("timer.start", { entryId: id, jobId: jobA, at: NINE })]);
    mirror(
      [
        op("timer.resume", { entryId: id, at: NINE + MIN }), // already running
        op("timer.stop", { entryId: uuidv7(), at: NINE + MIN }), // unknown timer
        op("entry.delete", { entryId: uuidv7(), at: NINE }), // unknown entry
      ],
      { expectRejected: 3 },
    );
  });

  test("a timer started on another day is shown as open but not listed", () => {
    const id = uuidv7();
    mirror([op("timer.start", { entryId: id, jobId: jobA, at: NINE - 24 * HOUR })]);
    mirror([op("timer.stop", { entryId: id, at: NINE })]);
  });
});
