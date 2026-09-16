import { db } from "./db.server.ts";
import {
  createManualEntry,
  deleteEntry,
  pauseTimer,
  restoreEntry,
  resumeTimer,
  startTimer,
  stopTimer,
  updateEntry,
} from "./entries.ts";
import { createJob } from "./jobs.ts";
import { commitRollup, createNote, deleteNote, restoreNote, updateNote } from "./notes.ts";
import { OpError } from "./op-error.ts";
import {
  type OpEnvelope,
  type OpPayload,
  type OpResult,
  type OpType,
  OPS_PER_REQUEST,
  opEnvelope,
  opPayloads,
} from "./ops-schema.ts";

/**
 * Applies ops through the idempotency ledger (`applied_ops`).
 *
 *  - An op id seen before returns its recorded result; nothing is re-applied.
 *  - Each op runs in its own transaction together with its ledger row, so an
 *    op and the record of it commit or roll back as one.
 *  - Rejections (OpError, bad payloads) are recorded too: a replay gets the
 *    same answer. Unexpected exceptions are *not* recorded — they propagate as
 *    a 500 and the device retries, which is safe because earlier ops in the
 *    batch are already in the ledger.
 */

export interface OpContext {
  /** Whose time is being changed. */
  userId: number;
  /** Who is changing it: the same person, or an admin acting for them. */
  actorUserId: number;
  deviceId: string;
  clientTime: number;
  now: number;
}

type Handler<T extends OpType> = (ctx: OpContext, p: OpPayload<T>) => unknown;

const handlers: { [T in OpType]: Handler<T> } = {
  "timer.start": (c, p) => {
    startTimer({ ...c, ...p });
    return { entryId: p.entryId };
  },
  "timer.pause": (c, p) => void pauseTimer({ userId: c.userId, now: c.now, ...p }),
  "timer.resume": (c, p) => void resumeTimer({ userId: c.userId, now: c.now, ...p }),
  "timer.stop": (c, p) => void stopTimer({ userId: c.userId, now: c.now, ...p }),

  "entry.create": (c, p) => {
    createManualEntry({ ...c, ...p });
    return { entryId: p.entryId };
  },
  "entry.update": (c, p) => void updateEntry({ userId: c.userId, actorUserId: c.actorUserId, now: c.now, ...p }),
  "entry.delete": (c, p) => void deleteEntry({ userId: c.userId, actorUserId: c.actorUserId, now: c.now, ...p }),
  "entry.restore": (c, p) =>
    void restoreEntry({ userId: c.userId, actorUserId: c.actorUserId, now: c.now, entryId: p.entryId }),

  "note.create": (c, p) => {
    createNote({ userId: c.userId, deviceId: c.deviceId, now: c.now, ...p });
    return { noteId: p.noteId };
  },
  "note.update": (c, p) => void updateNote({ userId: c.userId, now: c.now, ...p }),
  "note.delete": (c, p) => void deleteNote({ userId: c.userId, now: c.now, ...p }),
  "note.restore": (c, p) => void restoreNote({ userId: c.userId, now: c.now, noteId: p.noteId }),

  "rollup.commit": (c, p) => ({ entryIds: commitRollup({ ...c, ...p }) }),

  "job.create": (c, p) => {
    const job = createJob({ id: p.jobId, name: p.name, parentId: p.parentId, actorUserId: c.actorUserId, now: c.now });
    return { jobId: job.id };
  },
};

function describeZodError(error: { issues: { message: string; path: PropertyKey[] }[] }): string {
  const first = error.issues[0];
  if (!first) return "That request was malformed.";
  const where = first.path.length ? `${first.path.map(String).join(".")}: ` : "";
  return `${where}${first.message}`;
}

function record(who: Who, env: OpEnvelope, now: number, result: OpResult): void {
  db()
    .query(
      `INSERT INTO applied_ops
         (op_id, user_id, actor_user_id, type, device_id, client_time, applied_at, payload_json, ok, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      env.opId,
      who.userId,
      who.actorUserId,
      env.type,
      env.deviceId,
      env.clientTime,
      now,
      JSON.stringify(env.payload ?? null),
      result.ok ? 1 : 0,
      JSON.stringify(result),
    );
}

/**
 * Whose time an op changes, and who is changing it. Admins acting for someone
 * pass both; everyone else just their own id.
 */
export type Who = { userId: number; actorUserId: number };

function whoOf(who: number | Who): Who {
  return typeof who === "number" ? { userId: who, actorUserId: who } : who;
}

export function applyOp(as: number | Who, raw: unknown, now: number = Date.now()): OpResult {
  const who = whoOf(as);
  const { userId } = who;
  const envelope = opEnvelope.safeParse(raw);
  const rawId = (raw as { opId?: unknown } | null)?.opId;
  if (!envelope.success) {
    // Can't be recorded: without a valid envelope there's no trustworthy id.
    return { opId: typeof rawId === "string" ? rawId : "", ok: false, code: "invalid", error: describeZodError(envelope.error) };
  }
  const env = envelope.data;

  const seen = db()
    .query<{ user_id: number; result_json: string }, [string]>(
      "SELECT user_id, result_json FROM applied_ops WHERE op_id = ?",
    )
    .get(env.opId);
  if (seen) {
    if (seen.user_id !== userId) {
      return { opId: env.opId, ok: false, code: "forbidden", error: "That operation id belongs to someone else." };
    }
    return JSON.parse(seen.result_json) as OpResult;
  }

  const payload = opPayloads[env.type].safeParse(env.payload);
  if (!payload.success) {
    const result: OpResult = { opId: env.opId, ok: false, code: "invalid", error: describeZodError(payload.error) };
    record(who, env, now, result);
    return result;
  }

  const ctx: OpContext = { ...who, deviceId: env.deviceId, clientTime: env.clientTime, now };
  const handler = handlers[env.type] as Handler<OpType>;
  try {
    return db().transaction((): OpResult => {
      const data = handler(ctx, payload.data as never);
      const result: OpResult = data === undefined ? { opId: env.opId, ok: true } : { opId: env.opId, ok: true, data };
      record(who, env, now, result);
      return result;
    })();
  } catch (err) {
    if (!(err instanceof OpError)) throw err;
    const result: OpResult = { opId: env.opId, ok: false, code: err.code, error: err.message };
    record(who, env, now, result);
    return result;
  }
}

/** Apply a batch in order. Each op stands alone; one rejection doesn't stop the rest. */
export function applyOps(as: number | Who, raw: unknown, now: number = Date.now()): OpResult[] {
  if (!Array.isArray(raw)) throw new OpError("invalid", "Expected a list of operations.");
  if (raw.length > OPS_PER_REQUEST) throw new OpError("invalid", `Send at most ${OPS_PER_REQUEST} operations at once.`);
  return raw.map((op) => applyOp(as, op, now));
}
