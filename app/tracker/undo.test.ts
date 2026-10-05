import { beforeEach, describe, expect, test } from "bun:test";

import { applyOp } from "../../src/ops.ts";
import type { Op, OpPayload, OpType } from "../../src/ops-schema.ts";
import { freshDb } from "../../src/testing/db.ts";
import { createUser } from "../../src/users.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { loadDay } from "../tracker.server.ts";
import { type DayModel, liveSeconds } from "./model.ts";
import { inverseOf, inverseOfAll } from "./undo.ts";

/**
 * An undo is the op that puts things back. These tests hold it to that: a
 * change goes through the real server, then its inverse — worked out from
 * the day as it was before the change — goes through too, and the day must
 * be what it was. Clocks are frozen, so "back to what it was" is exact.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const NINE = Date.parse("2026-09-16T16:00:00Z"); // 09:00 in Los Angeles
const DAY = "2026-09-16";

let userId = 0;
let jobA = "";
let jobB = "";
let jobC = "";

const op = <T extends OpType>(type: T, payload: OpPayload<T>): Op =>
  ({ opId: uuidv7(), type, deviceId: "t", clientTime: NINE, payload }) as Op;

beforeEach(() => {
  freshDb();
  userId = createUser({ name: "W", role: "employee", actorUserId: null }).id;
  const customer = uuidv7();
  jobA = uuidv7();
  jobB = uuidv7();
  jobC = uuidv7();
  for (const [id, name, parentId] of [
    [customer, "Acme", null],
    [jobA, "Alpha", customer],
    [jobB, "Bravo", customer],
    [jobC, "Charlie", customer],
  ] as const) {
    apply(op("job.create", { jobId: id, name, parentId }));
  }
});

function apply(o: Op) {
  const r = applyOp(userId, o, NINE + 2 * HOUR);
  if (!r.ok) throw new Error(`${o.type}: ${r.error}`);
}

/**
 * What a day looks like to the person. A reopened timer is a new segment
 * from where the old one stopped, so its closed time and running-since
 * differ from the original's while the time it shows is the same — what is
 * compared is the time it shows at a fixed instant, and whether it is
 * running.
 */
function shape(m: DayModel) {
  const entry = (e: DayModel["entries"][number]) => ({
    ...e,
    durationSeconds: liveSeconds(e, NINE + 3 * HOUR),
    runningSince: e.runningSince != null,
    lastEndedAt: undefined,
    segmentCount: undefined,
  });
  // The strip's totals count closed time; the screen adds the running timer's
  // live time to its day (DayHeader), so that is what is compared.
  const running = m.open && m.open.runningSince != null ? liveSeconds(m.open, NINE + 3 * HOUR) - m.open.durationSeconds : 0;
  return {
    open: m.open ? entry(m.open) : null,
    entries: m.entries.map(entry),
    notes: m.notes.map((n) => ({ ...n })),
    week: m.week.map((d) => (m.open && d.date === m.open.workDate ? { ...d, seconds: d.seconds + running } : d)),
  };
}

/** Apply `setup`, then `change` and its undo, and require the day to be as it was after `setup`. */
function undone(setup: Op[], change: Op[], opts: { label?: string; days?: string[] } = {}) {
  for (const o of setup) apply(o);
  const days = opts.days ?? [DAY];
  const before = days.map((d) => shape(loadDay(userId, d)));
  const inverse = inverseOfAll(loadDay(userId, DAY), change, NINE + 2 * HOUR);
  expect(inverse).not.toBeNull();
  if (opts.label) expect(inverse!.label).toBe(opts.label);
  for (const o of change) apply(o);
  for (const o of inverse!.ops) apply(op(o.type, o.payload as never));
  expect(days.map((d) => shape(loadDay(userId, d)))).toEqual(before);
  return inverse!;
}

describe("undo puts the day back", () => {
  test("starting a timer", () => {
    const id = uuidv7();
    undone([], [op("timer.start", { entryId: id, jobId: jobA, at: NINE })], { label: "starting the timer" });
  });

  test("switching jobs: the new timer goes, the old one runs on", () => {
    const [a, b] = [uuidv7(), uuidv7()];
    const inverse = undone(
      [op("timer.start", { entryId: a, jobId: jobA, at: NINE })],
      [op("timer.start", { entryId: b, jobId: jobB, at: NINE + 30 * MIN })],
      { label: "switching jobs" },
    );
    expect(inverse.ops.map((o) => o.type)).toEqual(["entry.delete", "timer.reopen"]);
  });

  test("a switch made as a stop with a note and a start", () => {
    const [a, b] = [uuidv7(), uuidv7()];
    undone(
      [op("timer.start", { entryId: a, jobId: jobA, at: NINE })],
      [
        op("timer.stop", { entryId: a, at: NINE + 30 * MIN, note: "done with alpha" }),
        op("timer.start", { entryId: b, jobId: jobB, at: NINE + 30 * MIN }),
      ],
      { label: "switching jobs" },
    );
  });

  test("pausing, resuming, and stopping", () => {
    const id = uuidv7();
    undone([op("timer.start", { entryId: id, jobId: jobA, at: NINE })], [op("timer.pause", { entryId: id, at: NINE + 10 * MIN })], {
      label: "pausing the timer",
    });
    undone([op("timer.pause", { entryId: id, at: NINE + 20 * MIN })], [op("timer.resume", { entryId: id, at: NINE + 25 * MIN })], {
      label: "resuming the timer",
    });
    undone([], [op("timer.stop", { entryId: id, at: NINE + 30 * MIN, note: "with a note" })], { label: "stopping the timer" });
  });

  test("switching away from a paused timer brings it back paused", () => {
    const [a, b] = [uuidv7(), uuidv7()];
    const inverse = undone(
      [op("timer.start", { entryId: a, jobId: jobA, at: NINE }), op("timer.pause", { entryId: a, at: NINE + 10 * MIN })],
      [op("timer.start", { entryId: b, jobId: jobB, at: NINE + 30 * MIN })],
      { label: "switching jobs" },
    );
    expect(inverse.ops.map((o) => o.type)).toEqual(["entry.delete", "timer.reopen", "timer.pause"]);
  });

  test("restarting a stopped timer, and a paused one", () => {
    const id = uuidv7();
    undone(
      [op("timer.start", { entryId: id, jobId: jobA, at: NINE }), op("timer.stop", { entryId: id, at: NINE + 30 * MIN })],
      [op("timer.reopen", { entryId: id })],
      { label: "restarting the timer" },
    );
    undone([op("timer.reopen", { entryId: id }), op("timer.pause", { entryId: id, at: NINE + 40 * MIN })], [op("timer.reopen", { entryId: id })]);
  });

  test("adding time, deleting it, and restoring it", () => {
    undone([], [op("entry.create", { entryId: uuidv7(), jobId: jobA, workDate: DAY, durationSeconds: 1800, note: "typed" })], {
      label: "adding time",
    });
    const id = uuidv7();
    undone(
      [op("entry.create", { entryId: id, jobId: jobA, workDate: DAY, durationSeconds: 1800 })],
      [op("entry.delete", { entryId: id, at: NINE + HOUR })],
      { label: "deleting Acme › Alpha" },
    );
    undone([op("entry.delete", { entryId: id, at: NINE + HOUR })], [op("entry.restore", { entryId: id, at: NINE + HOUR })], {
      label: "restoring an entry",
    });
  });

  test("edits: job, note, times, and the date and duration of typed-in time", () => {
    const timed = uuidv7();
    const typed = uuidv7();
    undone(
      [
        op("entry.create", { entryId: timed, jobId: jobA, startedAt: NINE, endedAt: NINE + HOUR, note: "one" }),
        op("entry.create", { entryId: typed, jobId: jobB, workDate: DAY, durationSeconds: 1800 }),
      ],
      [op("entry.update", { entryId: timed, jobId: jobC, note: "two", startedAt: NINE + 10 * MIN, endedAt: NINE + 2 * HOUR })],
      { label: "the change to Acme › Alpha" },
    );
    undone([], [op("entry.update", { entryId: typed, workDate: "2026-09-15", durationSeconds: 60, note: "moved" })], {
      days: [DAY, "2026-09-15"],
    });
  });

  test("an entry changing shape, either way", () => {
    const id = uuidv7();
    undone(
      [op("entry.create", { entryId: id, jobId: jobA, startedAt: NINE, endedAt: NINE + HOUR })],
      [op("entry.update", { entryId: id, convertTo: "duration", workDate: DAY, durationSeconds: 5400 })],
    );
    undone(
      [op("entry.update", { entryId: id, convertTo: "duration", workDate: DAY, durationSeconds: 5400 })],
      [op("entry.update", { entryId: id, convertTo: "times", startedAt: NINE + HOUR, endedAt: NINE + 3 * HOUR })],
    );
  });

  test("notes: adding, changing, deleting, and a start", () => {
    const [n, start] = [uuidv7(), uuidv7()];
    undone([], [op("note.create", { noteId: uuidv7(), at: NINE, text: "one", jobId: jobA })], { label: "adding a note" });
    undone([op("note.create", { noteId: n, at: NINE, text: "one", jobId: jobA })], [op("note.update", { noteId: n, text: "two", jobId: jobB })], {
      label: "the change to a note",
    });
    undone([], [op("note.delete", { noteId: n, at: NINE + HOUR })], { label: "deleting a note" });
    undone([], [op("note.create", { noteId: uuidv7(), at: NINE + HOUR, kind: "start", jobId: jobB })], { label: "starting the job" });
    undone([op("note.create", { noteId: start, at: NINE + HOUR, kind: "start", jobId: jobB })], [op("note.delete", { noteId: start, at: NINE + 2 * HOUR })], {
      label: "removing the start",
    });
  });

  test("turning notes into hours frees the notes again", () => {
    const [n1, n2, e] = [uuidv7(), uuidv7(), uuidv7()];
    undone(
      [
        op("note.create", { noteId: n1, at: NINE, text: "one", jobId: jobA }),
        op("note.create", { noteId: n2, at: NINE + HOUR, text: "two", jobId: jobA }),
      ],
      [
        op("rollup.commit", {
          workDate: DAY,
          lines: [{ entryId: e, jobId: jobA, startedAt: NINE, endedAt: NINE + 2 * HOUR, note: "one; two", noteIds: [n1, n2] }],
        }),
      ],
      { label: "turning notes into hours" },
    );
  });

  test("leaving notes out, and bringing them back", () => {
    const [n1, n2] = [uuidv7(), uuidv7()];
    undone(
      [
        op("note.create", { noteId: n1, at: NINE, kind: "start", jobId: jobA }),
        op("note.create", { noteId: n2, at: NINE + HOUR, text: "Billed by hand", jobId: jobA }),
      ],
      [op("notes.leave_out", { noteIds: [n1, n2], at: NINE + HOUR })],
      { label: "leaving notes out" },
    );
    undone(
      [op("notes.leave_out", { noteIds: [n1, n2], at: NINE + HOUR })],
      [op("notes.bring_back", { noteIds: [n1, n2], at: NINE + HOUR })],
      { label: "bringing notes back" },
    );
  });

  test("submitting a day, and taking it back", () => {
    const id = uuidv7();
    undone(
      [op("entry.create", { entryId: id, jobId: jobA, workDate: DAY, durationSeconds: 1800 })],
      [op("day.submit", { workDate: DAY })],
      { label: "submitting the day" },
    );
    undone([op("day.submit", { workDate: DAY })], [op("day.unsubmit", { workDate: DAY })], { label: "taking the day back" });
  });

  test("several days submitted at once come back together", () => {
    const [a, b] = [uuidv7(), uuidv7()];
    undone(
      [
        op("entry.create", { entryId: a, jobId: jobA, workDate: "2026-09-14", durationSeconds: 1800 }),
        op("entry.create", { entryId: b, jobId: jobA, workDate: "2026-09-15", durationSeconds: 1800 }),
      ],
      [op("day.submit", { workDate: "2026-09-14" }), op("day.submit", { workDate: "2026-09-15" })],
      { label: "submitting those days", days: ["2026-09-14", "2026-09-15"] },
    );
  });

  test("answers about the books, and new jobs, are not undone", () => {
    const m = loadDay(userId, DAY);
    expect(inverseOf(m, op("job.create", { jobId: uuidv7(), name: "Charlie" }), NINE)).toBeNull();
    expect(inverseOf(m, op("duplicate.resolve", { entryId: uuidv7(), action: "separate" }), NINE)).toBeNull();
    // And a change that includes one can't be undone as a whole.
    expect(inverseOfAll(m, [op("job.create", { jobId: uuidv7(), name: "Delta" }), op("timer.start", { entryId: uuidv7(), jobId: jobA, at: NINE })], NINE)).toBeNull();
  });
});

describe("undo of time that joined a job's hours", () => {
  test("a timer that continued a line: the line is as it was", () => {
    const [a, again] = [uuidv7(), uuidv7()];
    const inverse = undone(
      [op("timer.start", { entryId: a, jobId: jobA, at: NINE }), op("timer.stop", { entryId: a, at: NINE + HOUR })],
      [op("timer.start", { entryId: again, jobId: jobA, at: NINE + 90 * MIN, note: "Trim" })],
      { label: "starting the timer" },
    );
    expect(inverse.ops.map((o) => o.type)).toEqual(["timer.stop", "entry.update"]);
  });

  test("switching back to a job worked earlier: the line as it was, the other timer running again", () => {
    const [a, b, again] = [uuidv7(), uuidv7(), uuidv7()];
    undone(
      [
        op("timer.start", { entryId: a, jobId: jobA, at: NINE }),
        op("timer.start", { entryId: b, jobId: jobB, at: NINE + HOUR }),
      ],
      [op("timer.start", { entryId: again, jobId: jobA, at: NINE + 90 * MIN })],
      { label: "switching jobs" },
    );
  });

  test("typed-in time that joined a line", () => {
    const a = uuidv7();
    undone(
      [op("entry.create", { entryId: a, jobId: jobA, startedAt: NINE, endedAt: NINE + HOUR, note: "Framing" })],
      [op("entry.create", { entryId: uuidv7(), jobId: jobA, workDate: DAY, durationSeconds: 1800, note: "Paperwork" })],
      { label: "adding time" },
    );
    undone([], [op("entry.create", { entryId: uuidv7(), jobId: jobA, startedAt: NINE + 2 * HOUR, endedAt: NINE + 3 * HOUR })]);
  });

  test("notes that joined a line: the time and description back, the notes free again", () => {
    const n1 = uuidv7();
    undone(
      [
        op("entry.create", { entryId: uuidv7(), jobId: jobA, startedAt: NINE, endedAt: NINE + HOUR, note: "Framing" }),
        op("note.create", { noteId: n1, at: NINE + 90 * MIN, text: "Paint", jobId: jobA }),
      ],
      [op("rollup.commit", { workDate: DAY, lines: [{ entryId: uuidv7(), jobId: jobA, durationSeconds: 1800, note: "Paint", noteIds: [n1] }] })],
      { label: "turning notes into hours" },
    );
  });

  test("combining has no undo; it's a deliberate button", () => {
    expect(inverseOf(loadDay(userId, DAY), op("entry.combine", { intoEntryId: uuidv7(), entryIds: [uuidv7()] }), NINE)).toBeNull();
  });
});
