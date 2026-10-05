import { z } from "zod";

import { UUID_PATTERN } from "./uuid.ts";

/**
 * What a browser sends about problems: errors on their own, and bug reports
 * a person files. Shared by the server (validation) and the browser (types).
 * Dependency-free apart from zod.
 */

/** Bounds that keep one browser from filling the disk. */
export const LIMITS = {
  /** A batch of errors, as sent. */
  errorBatchBytes: 256 * 1024,
  errorsPerBatch: 20,
  messageLength: 1000,
  stackLength: 8000,
  /** A whole bug report, screenshots included (base64 makes them ~4/3). */
  reportBytes: 16 * 1024 * 1024,
  /** One screenshot, decoded. */
  imageBytes: 5 * 1024 * 1024,
  images: 3,
  descriptionLength: 4000,
  /** The context a report carries, as JSON. */
  contextBytes: 4 * 1024 * 1024,
} as const;

/** One breadcrumb: something that happened in the page, newest last. */
export const breadcrumb = z.object({
  at: z.number(),
  /** nav | click | op | toast | console | error | net | online | visibility | update */
  kind: z.string().max(20),
  text: z.string().max(500),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type Breadcrumb = z.infer<typeof breadcrumb>;

export const ERROR_SOURCES = ["error", "unhandledrejection", "console", "boundary"] as const;

export const clientError = z.object({
  message: z.string().max(LIMITS.messageLength),
  /** The error's own name, when it has one: TypeError, OpError... */
  name: z.string().max(100).optional(),
  stack: z.string().max(LIMITS.stackLength).optional(),
  source: z.enum(ERROR_SOURCES),
  /** The first time it happened in this batch, by the device's clock. */
  at: z.number(),
  /** How many times it happened on this page since it was last sent. */
  repeats: z.number().int().min(1).max(100_000).default(1),
  url: z.string().max(2000),
  revision: z.string().max(100),
  /** What happened just before, newest last. */
  breadcrumbs: z.array(breadcrumb).max(40).optional(),
});
export type ClientError = z.infer<typeof clientError>;

export const clientErrorBatch = z.object({ errors: z.array(clientError).min(1).max(LIMITS.errorsPerBatch) });

export const IMAGE_MIMES = ["image/webp", "image/png", "image/jpeg"] as const;

export const reportImage = z.object({
  /** Drawn by the app from the page, or a real capture of the screen. */
  kind: z.enum(["drawn", "captured"]),
  mime: z.enum(IMAGE_MIMES),
  width: z.number().int().positive().max(20_000).optional(),
  height: z.number().int().positive().max(20_000).optional(),
  /** Base64, without a data: prefix. */
  data: z.string().max(Math.ceil((LIMITS.imageBytes * 4) / 3) + 4),
});

export const bugReport = z.object({
  id: z.string().regex(UUID_PATTERN),
  /** When the button was pressed, by the device's clock. */
  at: z.number(),
  description: z.string().trim().min(1, "Say what you were trying to do.").max(LIMITS.descriptionLength),
  expected: z.string().trim().max(LIMITS.descriptionLength).optional(),
  url: z.string().max(2000),
  revision: z.string().max(100),
  /** Everything gathered: see app/bugs/context.ts. Free-form, size-capped. */
  context: z.record(z.string(), z.unknown()),
  images: z.array(reportImage).max(LIMITS.images).default([]),
});
export type BugReportPayload = z.input<typeof bugReport>;
