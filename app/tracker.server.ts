import { config } from "../src/config.server.ts";
import { type Entry, getOpenEntry, listEntriesForDate, noteRequiredFor, totalsByDate } from "../src/entries.ts";
import { listJobs, recentJobIds } from "../src/jobs.ts";
import { listNotesForDate } from "../src/notes.ts";
import { requireNoteOnStop, weekStartsOn } from "../src/settings.ts";
import { addDays, today, weekStartOf } from "../src/time.ts";
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

function entryView(e: Entry, jobs: Map<string, JobView>): EntryView {
  const first = e.segments[0];
  const last = e.segments.at(-1);
  return {
    id: e.id,
    jobId: e.jobId,
    jobName: e.jobId ? (jobs.get(e.jobId)?.fullName ?? "Unknown job") : "No job",
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
  };
}

export function loadDay(userId: number, workDate: string): DayModel {
  const allJobs = listJobs({ includeInactive: true });
  const jobMap = new Map<string, JobView>(
    allJobs.map((j) => [
      j.id,
      { id: j.id, fullName: j.fullName, requiresNote: j.requiresNote, active: j.active, provisional: j.provisional },
    ]),
  );

  const open = getOpenEntry(userId);
  const todayDate = today(config.timezone);

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
    requireNoteOnStop: requireNoteOnStop(),
    open: open ? entryView(open, jobMap) : null,
    entries: listEntriesForDate(userId, workDate)
      .map((e) => entryView(e, jobMap))
      .sort(compareEntries),
    notes: listNotesForDate(userId, workDate).map((n) => ({
      id: n.id,
      at: n.at,
      text: n.text,
      jobId: n.jobId,
      jobName: n.jobId ? (jobMap.get(n.jobId)?.fullName ?? null) : null,
      rolledIntoEntryId: n.rolledIntoEntryId,
    }))
      .sort(compareNotes),
    jobs: [...jobMap.values()].filter((j) => j.active),
    recentJobIds: recentJobIds(userId),
    week: Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i);
      return { date, seconds: totals.get(date) ?? 0 };
    }),
  };
}
