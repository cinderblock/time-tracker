import { z } from "zod";

import { JOB_NAME_MAX_LENGTH, NOTE_MAX_LENGTH } from "./limits.ts";
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

export const MAX_ENTRY_SECONDS = 24 * 3600;

/**
 * A 'note' says what was done. A 'start' marks being on a job from that
 * moment — made when a job is added to the day — and has no words of its own.
 */
export const NOTE_KINDS = ["note", "start"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

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
  "entry.update": z.object({
    entryId: id,
    jobId: id.optional(),
    note,
    startedAt: instant.optional(),
    endedAt: instant.optional(),
    workDate: workDate.optional(),
    durationSeconds: z.number().int().positive().max(MAX_ENTRY_SECONDS).optional(),
  }),
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
            // Either a span, or a duration on the day.
            startedAt: instant.optional(),
            endedAt: instant.optional(),
            durationSeconds: z.number().int().positive().max(MAX_ENTRY_SECONDS).optional(),
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

  // A day's worth of time at once: submitting says the day is done, taking it
  // back reopens it for corrections. Several days are several ops.
  "day.submit": z.object({ workDate }),
  "day.unsubmit": z.object({ workDate }),

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
