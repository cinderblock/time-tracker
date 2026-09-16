/**
 * The shapes the tracking screen works with. Shared by the server loader and
 * the browser, so this module must stay free of server imports.
 */

export interface JobView {
  id: string;
  fullName: string;
  requiresNote: boolean;
  active: boolean;
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
  segmentCount: number;
  /** For an open timer: whether stopping it needs a note. */
  noteRequired: boolean;
}

export interface NoteView {
  id: string;
  at: number;
  text: string;
  jobId: string | null;
  jobName: string | null;
  rolledIntoEntryId: string | null;
}

export interface DayModel {
  workDate: string;
  today: string;
  timezone: string;
  requireNoteOnStop: boolean;
  /** The person's open timer, whichever day it belongs to. */
  open: EntryView | null;
  entries: EntryView[];
  notes: NoteView[];
  jobs: JobView[];
  recentJobIds: string[];
  week: { date: string; seconds: number }[];
}

/** Seconds an entry covers as of `now`, including a running segment. */
export function liveSeconds(e: Pick<EntryView, "durationSeconds" | "runningSince">, now: number): number {
  return e.durationSeconds + (e.runningSince != null ? Math.max(0, Math.round((now - e.runningSince) / 1000)) : 0);
}
