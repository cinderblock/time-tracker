import { config } from "../src/config.server.ts";
import { type Entry, getOpenEntry, listEntriesForDate, noteRequiredFor, totalsByDate } from "../src/entries.ts";
import { listJobs, recentJobIds } from "../src/jobs.ts";
import { listNotesForDate } from "../src/notes.ts";
import { requireNoteOnStop } from "../src/settings.ts";
import { addDays, today, weekdayOf } from "../src/time.ts";
import type { DayModel, EntryView, JobView } from "./tracker/model.ts";

/**
 * Builds the model the tracking screen renders: one person, one work date.
 * Everything is plain data (instants, not formatted strings) because the
 * browser formats in the organisation's timezone and ticks the live timer.
 */

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

  // A week strip ending on Saturday of the shown date's week.
  const weekStart = addDays(workDate, -weekdayOf(workDate));
  const weekEnd = addDays(weekStart, 6);
  const totals = totalsByDate(userId, weekStart, weekEnd);

  return {
    workDate,
    today: todayDate,
    timezone: config.timezone,
    requireNoteOnStop: requireNoteOnStop(),
    open: open ? entryView(open, jobMap) : null,
    entries: listEntriesForDate(userId, workDate).map((e) => entryView(e, jobMap)),
    notes: listNotesForDate(userId, workDate).map((n) => ({
      id: n.id,
      at: n.at,
      text: n.text,
      jobId: n.jobId,
      jobName: n.jobId ? (jobMap.get(n.jobId)?.fullName ?? null) : null,
      rolledIntoEntryId: n.rolledIntoEntryId,
    })),
    jobs: [...jobMap.values()].filter((j) => j.active),
    recentJobIds: recentJobIds(userId),
    week: Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i);
      return { date, seconds: totals.get(date) ?? 0 };
    }),
  };
}
