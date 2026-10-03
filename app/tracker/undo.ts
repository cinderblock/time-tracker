import { jobLabel } from "../../src/job-names.ts";
import type { Op, OpPayload, OpType } from "../../src/ops-schema.ts";
import { applyPending } from "../offline/reducer.ts";
import type { DayModel, EntryView } from "./model.ts";

/**
 * Undo, as the op that puts things back.
 *
 * Every change to tracking data is an op, and the server's rules already
 * make each one reversible by another: a delete by a restore, a stop by a
 * reopen, an edit by an edit with the old values. So undo keeps no history
 * of its own on the server. The browser works out the inverse of a change
 * from the day as it was just before — the model with every pending op
 * applied — and dispatches it like any other change: through the outbox,
 * offline too, and acting for someone else too.
 *
 * Not everything can be put back. An answer about time the books already
 * have is an answer; a job made by mistake costs nothing. Those return null
 * and the stack never sees them.
 */

export interface Undoable {
  /** What will be undone, in words that follow "Undo": "stopping the timer". */
  label: string;
  ops: { type: OpType; payload: unknown }[];
}

type Step = { type: OpType; payload: unknown };

const step = <T extends OpType>(type: T, payload: OpPayload<T>): Step => ({ type, payload });

function entryIn(m: DayModel, id: string): EntryView | undefined {
  return m.entries.find((e) => e.id === id) ?? (m.open?.id === id ? m.open : undefined);
}

/**
 * A stopped timer running again — and, if it was paused when it stopped,
 * paused again at the same moment, so it comes back exactly as it was.
 */
function reopened(e: EntryView): Step[] {
  const ops: Step[] = [step("timer.reopen", { entryId: e.id })];
  if (e.status === "open" && e.runningSince == null && e.lastEndedAt != null) {
    ops.push(step("timer.pause", { entryId: e.id, at: e.lastEndedAt }));
  }
  return ops;
}

/** The inverse of one op against the day as it is before that op. */
export function inverseOf(m: DayModel, op: Op, now: number): Undoable | null {
  switch (op.type) {
    case "timer.start": {
      const p = op.payload;
      // Starting while another timer ran stopped it at the same instant; the
      // new one goes first, then the old one runs on as if never stopped.
      const ops: Step[] = [step("entry.delete", { entryId: p.entryId, at: now })];
      if (m.open) ops.push(...reopened(m.open));
      return { label: m.open ? "switching jobs" : "starting the timer", ops };
    }

    case "timer.pause":
      return { label: "pausing the timer", ops: [step("timer.reopen", { entryId: op.payload.entryId })] };

    case "timer.resume":
      // Paused again at the moment it resumed: the segment closes with
      // nothing in it, so the time since doesn't count.
      return { label: "resuming the timer", ops: [step("timer.pause", { entryId: op.payload.entryId, at: op.payload.at })] };

    case "timer.stop": {
      const p = op.payload;
      const e = entryIn(m, p.entryId);
      const ops: Step[] = e ? reopened(e) : [step("timer.reopen", { entryId: p.entryId })];
      // A note given with the stop goes back to what it was.
      if (e && p.note !== undefined && (p.note?.trim() || null) !== e.note) {
        ops.push(step("entry.update", { entryId: p.entryId, note: e.note }));
      }
      return { label: "stopping the timer", ops };
    }

    case "timer.reopen": {
      const e = entryIn(m, op.payload.entryId);
      if (!e || e.lastEndedAt == null) return null;
      // Closed again where it was reopened: a segment with nothing in it.
      const at = e.lastEndedAt;
      return {
        label: "restarting the timer",
        ops: [e.status === "open" ? step("timer.pause", { entryId: e.id, at }) : step("timer.stop", { entryId: e.id, at })],
      };
    }

    case "entry.create":
      return { label: "adding time", ops: [step("entry.delete", { entryId: op.payload.entryId, at: now })] };

    case "entry.update": {
      const p = op.payload;
      const e = entryIn(m, p.entryId);
      if (!e) return null;
      const back: OpPayload<"entry.update"> = { entryId: e.id };
      if (p.jobId !== undefined && p.jobId !== e.jobId && e.jobId) back.jobId = e.jobId;
      if (p.note !== undefined) back.note = e.note;
      const hasTimes = e.startedAt != null;
      const convertTo = p.convertTo === (hasTimes ? "times" : "duration") ? undefined : p.convertTo;
      if (convertTo === "duration") {
        if (e.startedAt == null || e.endedAt == null) return null;
        back.convertTo = "times";
        back.startedAt = e.startedAt;
        back.endedAt = e.endedAt;
      } else if (convertTo === "times") {
        back.convertTo = "duration";
        back.workDate = e.workDate;
        back.durationSeconds = e.durationSeconds;
      } else if (hasTimes) {
        if (p.startedAt !== undefined && e.startedAt != null) back.startedAt = e.startedAt;
        if (p.endedAt !== undefined && e.endedAt != null) back.endedAt = e.endedAt;
      } else {
        if (p.workDate !== undefined) back.workDate = e.workDate;
        if (p.durationSeconds !== undefined) back.durationSeconds = e.durationSeconds;
      }
      return { label: `the change to ${jobLabel(e.jobName)}`, ops: [step("entry.update", back)] };
    }

    case "entry.delete": {
      const e = entryIn(m, op.payload.entryId);
      return {
        label: e ? `deleting ${jobLabel(e.jobName)}` : "deleting an entry",
        ops: [step("entry.restore", { entryId: op.payload.entryId, at: now })],
      };
    }

    case "entry.restore":
      return { label: "restoring an entry", ops: [step("entry.delete", { entryId: op.payload.entryId, at: now })] };

    case "note.create":
      return {
        label: op.payload.kind === "start" ? "starting the job" : "adding a note",
        ops: [step("note.delete", { noteId: op.payload.noteId, at: now })],
      };

    case "note.update": {
      const p = op.payload;
      const n = m.notes.find((x) => x.id === p.noteId);
      if (!n) return null;
      const back: OpPayload<"note.update"> = { noteId: n.id };
      if (p.text !== undefined && n.kind !== "start") back.text = n.text;
      if (p.jobId !== undefined) back.jobId = n.jobId;
      if (p.at !== undefined) back.at = n.at;
      return { label: "the change to a note", ops: [step("note.update", back)] };
    }

    case "note.delete": {
      const n = m.notes.find((x) => x.id === op.payload.noteId);
      return {
        label: n?.kind === "start" ? "removing the start" : "deleting a note",
        ops: [step("note.restore", { noteId: op.payload.noteId, at: now })],
      };
    }

    case "note.restore":
      return { label: "restoring a note", ops: [step("note.delete", { noteId: op.payload.noteId, at: now })] };

    case "rollup.commit":
      // Deleting the hours frees their notes again (the server's rule).
      return {
        label: "turning notes into hours",
        ops: op.payload.lines.map((line) => step("entry.delete", { entryId: line.entryId, at: now })),
      };

    case "day.submit":
      return { label: "submitting the day", ops: [step("day.unsubmit", { workDate: op.payload.workDate })] };

    case "day.unsubmit":
      return { label: "taking the day back", ops: [step("day.submit", { workDate: op.payload.workDate })] };

    case "duplicate.resolve":
    case "job.create":
      return null;
  }
}

/**
 * The inverse of several ops made as one change — a switch is a stop and a
 * start; "submit them all" is a submit per day. Each is inverted against the
 * day as the ones before it left it, and they are undone last to first. If
 * any one can't be undone, the change as a whole can't.
 */
export function inverseOfAll(m: DayModel, ops: Op[], now: number): Undoable | null {
  const parts: Undoable[] = [];
  let state = m;
  for (const op of ops) {
    const inverse = inverseOf(state, op, now);
    if (!inverse) return null;
    parts.push(inverse);
    state = applyPending(state, [op]);
  }
  if (parts.length === 0) return null;
  const label =
    ops.length > 1 && ops.some((o) => o.type === "timer.start") && ops.some((o) => o.type === "timer.stop")
      ? "switching jobs"
      : ops.length > 1 && ops.every((o) => o.type === "day.submit")
        ? "submitting those days"
        : parts[0]!.label;
  return { label, ops: parts.reverse().flatMap((p) => p.ops) };
}
