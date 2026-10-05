import { z } from "zod";

import { JOB_NAME_MAX_LENGTH, MAX_ENTRY_SECONDS, NOTE_MAX_LENGTH } from "./limits.ts";
import { UUID_PATTERN } from "./uuid.ts";

/**
 * The operations a device sends to change tracking data.
 *
 * Every write is one of these, sent to POST /api/ops and applied through the
 * idempotency ledger, so an op replayed after a lost response (or queued
 * offline and sent later) has exactly one effect.
 *
 * Dependency-free apart from zod: the browser imports this module too.
 */

const id = z.string().regex(UUID_PATTERN, "Expected a UUID");

// Instants are epoch milliseconds. Bounds catch garbage (a zero, seconds
// instead of ms), not clock skew — skew is recorded and reviewed, not refused.
const EARLIEST = Date.UTC(2020, 0, 1);
const instant = z
  .number()
  .int()
  .refine((t) => t >= EARLIEST && t <= Date.now() + 24 * 3600_000, "Time is out of range");

const workDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const note = z.string().max(NOTE_MAX_LENGTH).nullable().optional();

const location = z
  .object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    accuracy: z.number().nonnegative().max(1_000_000).nullable().optional(),
    at: instant,
  })
  .nullable()
  .optional();

/**
 * A 'note' says what was done. A 'start' marks being on a job from that
 * moment — made when a job is added to the day — and has no words of its own.
 */
export const NOTE_KINDS = ["note", "start"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/**
 * How a note is settled without being part of an entry here: the accounting
 * system's record of the same time was kept in place of its hours, or the
 * person left it out (billed some other way, or not work).
 */
export const NOTE_SETTLED = ["kept_in_accounting", "left_out"] as const;
export type NoteSettled = (typeof NOTE_SETTLED)[number];

export const opPayloads = {
  "timer.start": z.object({
    entryId: id,
    jobId: id,
    at: instant,
    note,
    location,
  }),
  "timer.pause": z.object({ entryId: id, at: instant }),
  "timer.resume": z.object({ entryId: id, at: instant }),
  "timer.stop": z.object({ entryId: id, at: instant, note, location }),
  /** Undo a stop or a pause: running again from the moment it last stopped, no gap. */
  "timer.reopen": z.object({ entryId: id }),

  "entry.create": z
    .object({
      entryId: id,
      jobId: id,
      note,
      // Either a start and end, or a date and a duration.
      startedAt: instant.optional(),
      endedAt: instant.optional(),
      workDate: workDate.optional(),
      durationSeconds: z.number().int().positive().max(MAX_ENTRY_SECONDS).optional(),
    })
    .refine(
      (p) =>
        (p.startedAt != null && p.endedAt != null && p.durationSeconds == null) ||
        (p.startedAt == null && p.endedAt == null && p.durationSeconds != null && p.workDate != null),
      "Give either a start and end time, or a date and a duration",
    ),
  "entry.update": z
    .object({
      entryId: id,
      jobId: id.optional(),
      note,
      startedAt: instant.optional(),
      endedAt: instant.optional(),
      workDate: workDate.optional(),
      durationSeconds: z.number().int().positive().max(MAX_ENTRY_SECONDS).optional(),
      /**
       * On a line with start and end times: the part of it that has none —
       * typed-in time and notes turned into hours that joined it. 0 removes it.
       */
      untimedSeconds: z.number().int().nonnegative().max(MAX_ENTRY_SECONDS).optional(),
      /**
       * Change how the entry is recorded: a stopped timer becomes a plain
       * duration, or a plain duration gets a start and an end. Without this,
       * an entry keeps the shape it was made in and the fields for the other
       * shape are refused — so a stale or confused client can't quietly
       * destroy an entry's times by sending a duration alongside them.
       */
      convertTo: z.enum(["duration", "times"]).optional(),
    })
    .refine(
      (p) => p.convertTo !== "duration" || p.durationSeconds != null,
      "Converting to a duration needs the duration",
    )
    .refine(
      (p) => p.convertTo !== "times" || (p.startedAt != null && p.endedAt != null),
      "Converting to a span needs a start and an end",
    ),
  "entry.delete": z.object({ entryId: id, at: instant }),
  "entry.restore": z.object({ entryId: id, at: instant }),

  "note.create": z
    .object({
      noteId: id,
      at: instant,
      kind: z.enum(NOTE_KINDS).optional(),
      text: z.string().trim().max(NOTE_MAX_LENGTH).optional(),
      jobId: id.nullable().optional(),
      location,
    })
    .refine((p) => p.kind === "start" || (p.text ?? "").length > 0, "Write something")
    .refine((p) => p.kind !== "start" || p.jobId != null, "A start needs a job"),
  "note.update": z.object({
    noteId: id,
    text: z.string().trim().min(1).max(NOTE_MAX_LENGTH).optional(),
    jobId: id.nullable().optional(),
    at: instant.optional(),
  }),
  "note.delete": z.object({ noteId: id, at: instant }),
  "note.restore": z.object({ noteId: id, at: instant }),
  // Notes that won't become hours (billed some other way, or not work), and
  // the way back. The day stops waiting on them; no time changes.
  "notes.leave_out": z.object({ noteIds: z.array(id).min(1).max(500), at: instant }),
  "notes.bring_back": z.object({ noteIds: z.array(id).min(1).max(500), at: instant }),

  "rollup.commit": z.object({
    workDate,
    lines: z
      .array(
        z
          .object({
            entryId: id,
            jobId: id,
            note,
            noteIds: z.array(id).min(1),
            // Either a span, or a duration on the day. When the job already
            // has hours that day these join them, and a duration of 0 is
            // allowed: the notes are attached to hours already counted.
            startedAt: instant.optional(),
            endedAt: instant.optional(),
            durationSeconds: z.number().int().nonnegative().max(MAX_ENTRY_SECONDS).optional(),
          })
          .refine(
            (l) =>
              (l.startedAt != null && l.endedAt != null && l.durationSeconds == null) ||
              (l.startedAt == null && l.endedAt == null && l.durationSeconds != null),
            "Give either a start and end time, or a duration",
          ),
      )
      .min(1)
      .max(100),
  }),

  // Take back exactly what joining a job's hours added — the undo of an add
  // that landed on a line already there: untimed seconds, or the segment it
  // added; the description as it was; and the notes it made hours of.
  "entry.unmerge": z.object({
    entryId: id,
    removeSeconds: z.number().int().positive().max(MAX_ENTRY_SECONDS).optional(),
    removeSegment: z.object({ startedAt: instant, endedAt: instant.nullable().optional() }).optional(),
    note,
    releaseNoteIds: z.array(id).max(500).optional(),
  }),
  // Fold several lines of one job and day (from before one line per job) into
  // the first. Deliberate and not undoable.
  "entry.combine": z.object({ intoEntryId: id, entryIds: z.array(id).min(1).max(50) }),

  // A day's worth of time at once: submitting says the day is done, taking it
  // back reopens it for corrections. Several days are several ops.
  "day.submit": z.object({ workDate }),
  "day.unsubmit": z.object({ workDate }),

  // Time the accounting system already has for the same person, day and job
  // (sync.ts): which is it? Replace that record with this entry, delete this
  // entry, send both, or look again after fixing it there.
  "duplicate.resolve": z
    .object({
      entryId: id,
      action: z.enum(["replace", "discard", "separate", "recheck"]),
      /** For `replace`: which of the records found. */
      txnId: z.string().min(1).max(200).optional(),
    })
    .refine((p) => p.action !== "replace" || p.txnId != null, "Say which record to replace"),

  "job.create": z.object({
    // Chosen by the device, so a timer can be started on the job before the
    // server has ever heard of it.
    jobId: id,
    name: z.string().trim().min(1, "Name the job").max(JOB_NAME_MAX_LENGTH),
    parentId: id.nullable().optional(),
  }),
} as const;

export type OpType = keyof typeof opPayloads;
export type OpPayload<T extends OpType> = z.infer<(typeof opPayloads)[T]>;

export const OP_TYPES = Object.keys(opPayloads) as OpType[];

/** The envelope. `payload` is validated separately, against its type's schema. */
export const opEnvelope = z.object({
  opId: id,
  type: z.enum(OP_TYPES as [OpType, ...OpType[]]),
  deviceId: z.string().min(1).max(100),
  clientTime: z.number().int(),
  payload: z.unknown(),
});

export type OpEnvelope = z.infer<typeof opEnvelope>;

export type Op = {
  [T in OpType]: { opId: string; type: T; deviceId: string; clientTime: number; payload: OpPayload<T> };
}[OpType];

/** Result of applying one op. `code` lets the client react (e.g. ask for a note). */
export type OpResult =
  | { opId: string; ok: true; data?: unknown }
  | { opId: string; ok: false; error: string; code?: OpErrorCode };

export type OpErrorCode =
  | "invalid"
  | "not_found"
  | "conflict"
  | "note_required"
  | "forbidden";

export const OPS_PER_REQUEST = 200;
