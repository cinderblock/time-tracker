import { config } from "../src/config.server.ts";
import {
  type Entry,
  getOpenEntry,
  listEntriesForDate,
  noteRequiredFor,
  totalsByDate,
  unsubmittedDatesBefore,
} from "../src/entries.ts";
import { listJobs, recentJobIds } from "../src/jobs.ts";
import { listNotesForDate, pendingNotesBefore } from "../src/notes.ts";
import { requireApproval, requireNoteOnStop, weekStartsOn } from "../src/settings.ts";
import { addDays, today, weekStartOf } from "../src/time.ts";
import { DEFAULT_TRACKING_MODE } from "../src/tracking-mode.ts";
import { getUser } from "../src/users.ts";
import { type DayModel, type EntryView, type JobView, compareEntries, compareNotes } from "./tracker/model.ts";

/**
 * Builds the model the tracking screen renders: one person, one work date.
 * Everything is plain data (instants, not formatted strings) because the
 * browser formats in the organisation's timezone and ticks the live timer.
 */

function lastEnd(e: Entry): number | null {
  let max: number | null = null;
  for (const s of e.segments) if (s.endedAt != null && (max == null || s.endedAt > max)) max = s.endedAt;
  return max;
}

function entryView(e: Entry, jobNames: Map<string, string>): EntryView {
  const first = e.segments[0];
  const last = e.segments.at(-1);
  return {
    id: e.id,
    jobId: e.jobId,
    jobName: e.jobId ? (jobNames.get(e.jobId) ?? "Unknown job") : "No job",
    workDate: e.workDate,
    note: e.note,
    source: e.source,
    status: e.status,
    durationSeconds: e.durationSeconds,
    startedAt: first?.startedAt ?? null,
    endedAt: e.status === "open" ? null : (last?.endedAt ?? null),
    runningSince: e.segments.find((s) => s.endedAt == null)?.startedAt ?? null,
    lastEndedAt: lastEnd(e),
    segmentCount: e.segments.length,
    noteRequired: e.status === "open" ? noteRequiredFor(e.jobId) : false,
    adminApproved: e.approvedBy != null,
  };
}

export function loadDay(userId: number, workDate: string): DayModel {
  // Closed jobs still name the entries booked to them; only open ones are offered.
  const allJobs = listJobs({ includeInactive: true });
  const jobNames = new Map(allJobs.map((j) => [j.id, j.fullName]));
  const jobs: JobView[] = allJobs
    .filter((j) => j.open)
    .map((j) => ({
      id: j.id,
      name: j.name,
      fullName: j.fullName,
      parentId: j.parentId,
      requiresNote: j.noteRequired,
      bookable: j.bookable,
      takesTime: j.takesTime,
      provisional: j.provisional,
    }));

  const open = getOpenEntry(userId);
  const todayDate = today(config.timezone);
  const mode = getUser(userId)?.trackingMode ?? DEFAULT_TRACKING_MODE;

  // The week containing the shown date, starting on the organisation's first weekday.
  const weekStart = weekStartOf(workDate, weekStartsOn());
  const weekEnd = addDays(weekStart, 6);
  const totals = totalsByDate(userId, weekStart, weekEnd);

  return {
    userId,
    generatedAt: Date.now(),
    workDate,
    today: todayDate,
    timezone: config.timezone,
    mode,
    notesToRollUp: mode === "notes" ? pendingNotesBefore(userId, workDate) : null,
    requireNoteOnStop: requireNoteOnStop(),
    requireApproval: requireApproval(),
    unsubmittedDays: unsubmittedDatesBefore(userId, workDate),
    open: open ? entryView(open, jobNames) : null,
    entries: listEntriesForDate(userId, workDate)
      .map((e) => entryView(e, jobNames))
      .sort(compareEntries),
    notes: listNotesForDate(userId, workDate).map((n) => ({
      id: n.id,
      at: n.at,
      kind: n.kind,
      text: n.text,
      jobId: n.jobId,
      jobName: n.jobId ? (jobNames.get(n.jobId) ?? null) : null,
      rolledIntoEntryId: n.rolledIntoEntryId,
    }))
      .sort(compareNotes),
    jobs,
    recentJobIds: recentJobIds(userId),
    week: Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i);
      return { date, seconds: totals.get(date) ?? 0 };
    }),
  };
}
