import type { NoteKind } from "../../src/ops-schema.ts";
import type { TrackingMode } from "../../src/tracking-mode.ts";

/**
 * The shapes the tracking screen works with. Shared by the server loader and
 * the browser, so this module must stay free of server imports.
 */

/** A customer (no parent) or a job (under one), as the tracking screen sees it. */
export interface JobView {
  id: string;
  name: string;
  /** "Customer:Job" path. */
  fullName: string;
  parentId: string | null;
  /** Stopping a timer here needs a note — its own rule or its customer's. */
  requiresNote: boolean;
  /** Time can be booked here: an open job that takes hours itself. A customer is listed for grouping only. */
  bookable: boolean;
  /** An admin's answer to "does this job take hours itself"; null follows the default. */
  takesTime: boolean | null;
  provisional: boolean;
}

export interface EntryView {
  id: string;
  jobId: string | null;
  jobName: string;
  workDate: string;
  note: string | null;
  source: "timer" | "manual" | "note_rollup";
  status: "open" | "draft" | "submitted" | "approved" | "synced" | "sync_failed";
  /** Closed time only; add the running segment's elapsed time for a live total. */
  durationSeconds: number;
  /** First start / last end. Null for typed-in durations (and `endedAt` for open timers). */
  startedAt: number | null;
  endedAt: number | null;
  /** Start of the running segment, when the timer is running (not paused). */
  runningSince: number | null;
  /** End of the last closed segment — where a paused timer's time stopped. */
  lastEndedAt: number | null;
  segmentCount: number;
  /** For an open timer: whether stopping it needs a note. */
  noteRequired: boolean;
  /**
   * An admin has approved this. Their sign-off isn't the person's to undo, so
   * taking the day back leaves it alone. Always false where the organisation
   * doesn't require approval.
   */
  adminApproved: boolean;
}

export interface NoteView {
  id: string;
  at: number;
  /** A 'start' marks being on the job from `at`, with no words of its own. */
  kind: NoteKind;
  /** Empty for a start. */
  text: string;
  jobId: string | null;
  jobName: string | null;
  rolledIntoEntryId: string | null;
}

export interface DayModel {
  userId: number;
  /** Server clock when this was built. Decides which of two copies is newer. */
  generatedAt: number;
  /**
   * Browser clock when the request for this copy started. Changes confirmed
   * before then are already reflected in it. Set by the client loader.
   */
  fetchedAt?: number;
  /** True when this copy came from the device because the server was unreachable. */
  offline?: boolean;
  /** Offline, and this day was never loaded on this device: its saved time isn't known here. */
  partial?: boolean;
  workDate: string;
  today: string;
  timezone: string;
  /** How this person records time: timers, or notes turned into time later. */
  mode: TrackingMode;
  /**
   * In notes mode: the latest earlier day whose notes haven't been turned into
   * time. Until that's done, this day can't take notes.
   */
  notesToRollUp: { date: string; count: number } | null;
  requireNoteOnStop: boolean;
  /**
   * Whether submitted time waits for an admin before it reaches the accounting
   * system. Only changes what the screen says about submitting, not who may do
   * it.
   */
  requireApproval: boolean;
  /**
   * Earlier days with time this person hasn't submitted, most recent first.
   * Nothing submits itself, so this is what stops a day being forgotten.
   */
  unsubmittedDays: string[];
  /** The person's open timer, whichever day it belongs to. */
  open: EntryView | null;
  entries: EntryView[];
  notes: NoteView[];
  /** Every open customer and job — customers for grouping and for making new jobs under. */
  jobs: JobView[];
  /** Bookable jobs the person booked most recently, newest first. */
  recentJobIds: string[];
  week: { date: string; seconds: number }[];
}

/**
 * The one order entries are listed in, on the server and in the browser:
 * timed entries by start, then typed-in durations by id — UUID v7 ids sort by
 * when the device created them. Ties break on id, compared as plain strings
 * (the same order SQLite uses), so both sides always agree.
 */
export function compareEntries(a: Pick<EntryView, "startedAt" | "id">, b: Pick<EntryView, "startedAt" | "id">): number {
  if (a.startedAt != null && b.startedAt != null && a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
  if (a.startedAt != null && b.startedAt == null) return -1;
  if (a.startedAt == null && b.startedAt != null) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function compareNotes(a: Pick<NoteView, "at" | "id">, b: Pick<NoteView, "at" | "id">): number {
  if (a.at !== b.at) return a.at - b.at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Seconds an entry covers as of `now`, including a running segment. */
export function liveSeconds(e: Pick<EntryView, "durationSeconds" | "runningSince">, now: number): number {
  return e.durationSeconds + (e.runningSince != null ? Math.max(0, Math.round((now - e.runningSince) / 1000)) : 0);
}
