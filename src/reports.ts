import { listCategories } from "./categories.ts";
import { db } from "./db.server.ts";
import { APPROVED_STATUSES, type EntryStatus, SIGNED_OFF_STATUSES } from "./entry-status.ts";
import { jobLabel } from "./job-names.ts";
import { listJobs } from "./jobs.ts";
import { type RateScope, costOf, rateResolver } from "./rates.ts";
import { addDays, datesBetween, decimalHours, formatClock } from "./time.ts";

/**
 * Read-only views over everyone's time, for admins: report lines and their
 * summaries, the weekly timesheet grid, and the week calendar.
 *
 * Running timers count up to `now`. Costs use the rate frozen when time was
 * submitted, and the rate currently in effect for everything else — an
 * estimate until the time is signed off.
 */

export interface ReportFilter {
  /** Inclusive work-date range. */
  from: string;
  to: string;
  /** Only these people. Empty or absent: everyone. */
  userIds?: number[];
  /** Only people currently in this category. */
  categoryId?: number | null;
  /** Only this job and its sub-jobs. */
  jobId?: string | null;
}

export interface ReportLine {
  entryId: string;
  userId: number;
  userName: string;
  categoryId: number | null;
  categoryName: string | null;
  jobId: string | null;
  /** Full "Customer:Job" path. */
  jobName: string;
  /** The top of the job's tree (the customer, for accounting-backed jobs). */
  customerId: string | null;
  customerName: string;
  workDate: string;
  startedAt: number | null;
  endedAt: number | null;
  runningSince: number | null;
  seconds: number;
  note: string | null;
  status: EntryStatus;
  source: "timer" | "manual" | "note_rollup";
  hourlyRate: number | null;
  /** Where the rate came from: frozen when it was submitted, or the scope it resolved from. */
  rateFrom: "submission" | RateScope | null;
  cost: number | null;
}

interface LineRow {
  id: string;
  user_id: number;
  job_id: string | null;
  work_date: string;
  duration_seconds: number;
  note: string | null;
  status: EntryStatus;
  source: ReportLine["source"];
  rate_snapshot: number | null;
  started_at: number | null;
  ended_at: number | null;
  running_since: number | null;
}

interface Lookups {
  people: Map<number, { name: string; categoryId: number | null; active: boolean }>;
  categories: Map<number, string>;
  jobs: Map<string, { fullName: string; parentId: string | null }>;
}

function lookups(): Lookups {
  return {
    people: new Map(
      db()
        .query<{ id: number; name: string; category_id: number | null; active: number }, []>(
          "SELECT id, name, category_id, active FROM users",
        )
        .all()
        .map((r) => [r.id, { name: r.name, categoryId: r.category_id, active: r.active === 1 }]),
    ),
    categories: new Map(listCategories().map((c) => [c.id, c.name])),
    jobs: new Map(listJobs({ includeInactive: true }).map((j) => [j.id, { fullName: j.fullName, parentId: j.parentId }])),
  };
}

function rootOf(jobs: Lookups["jobs"], jobId: string): string {
  let id = jobId;
  const seen = new Set<string>();
  while (!seen.has(id)) {
    seen.add(id);
    const parent = jobs.get(id)?.parentId;
    if (!parent) break;
    id = parent;
  }
  return id;
}

function within(jobs: Lookups["jobs"], jobId: string | null, ancestor: string): boolean {
  const seen = new Set<string>();
  for (let id = jobId; id != null && !seen.has(id); id = jobs.get(id)?.parentId ?? null) {
    if (id === ancestor) return true;
    seen.add(id);
  }
  return false;
}

export function reportLines(filter: ReportFilter, now: number = Date.now()): ReportLine[] {
  const where = ["e.deleted_at IS NULL", "e.work_date BETWEEN ? AND ?"];
  const params: (string | number)[] = [filter.from, filter.to];
  if (filter.userIds?.length) {
    where.push(`e.user_id IN (${filter.userIds.map(() => "?").join(",")})`);
    params.push(...filter.userIds);
  }
  const rows = db()
    .query<LineRow, (string | number)[]>(
      `SELECT e.id, e.user_id, e.job_id, e.work_date, e.duration_seconds, e.note, e.status, e.source,
              e.rate_snapshot,
              MIN(s.started_at) AS started_at,
              MAX(s.ended_at) AS ended_at,
              MAX(CASE WHEN s.id IS NOT NULL AND s.ended_at IS NULL THEN s.started_at END) AS running_since
         FROM time_entries e
         LEFT JOIN time_segments s ON s.entry_id = e.id
        WHERE ${where.join(" AND ")}
        GROUP BY e.id
        ORDER BY e.work_date, e.user_id, started_at IS NULL, started_at, e.id`,
    )
    .all(...params);

  const { people, categories, jobs } = lookups();
  const rate = rateResolver();
  const lines: ReportLine[] = [];
  for (const r of rows) {
    const person = people.get(r.user_id);
    const categoryId = person?.categoryId ?? null;
    if (filter.categoryId != null && categoryId !== filter.categoryId) continue;
    if (filter.jobId && !within(jobs, r.job_id, filter.jobId)) continue;

    const running = r.status === "open" && r.running_since != null;
    const seconds = r.duration_seconds + (running ? Math.max(0, Math.round((now - r.running_since!) / 1000)) : 0);
    // Signed-off time carries the rate its submission froze; everything else
    // is costed at the rate in effect now, and can still move.
    const frozen = SIGNED_OFF_STATUSES.has(r.status);
    const resolved = frozen ? null : rate(r.user_id, r.job_id, r.work_date);
    const hourlyRate = frozen ? r.rate_snapshot : (resolved?.hourlyRate ?? null);
    const customerId = r.job_id ? rootOf(jobs, r.job_id) : null;

    lines.push({
      entryId: r.id,
      userId: r.user_id,
      userName: person?.name ?? "Unknown person",
      categoryId,
      categoryName: categoryId != null ? (categories.get(categoryId) ?? null) : null,
      jobId: r.job_id,
      jobName: r.job_id ? (jobs.get(r.job_id)?.fullName ?? "Unknown job") : "No job",
      customerId,
      customerName: customerId ? (jobs.get(customerId)?.fullName ?? "Unknown job") : "No job",
      workDate: r.work_date,
      startedAt: r.started_at,
      endedAt: r.status === "open" ? null : r.ended_at,
      runningSince: running ? r.running_since : null,
      seconds,
      note: r.note,
      status: r.status,
      source: r.source,
      hourlyRate,
      rateFrom: frozen ? (hourlyRate != null ? "submission" : null) : (resolved?.scope ?? null),
      cost: hourlyRate != null ? costOf(seconds, hourlyRate) : null,
    });
  }
  return lines;
}

// ---- summaries --------------------------------------------------------------------

export type GroupBy = "person" | "customer" | "job" | "category" | "day";

export const GROUP_BYS: readonly GroupBy[] = ["person", "customer", "job", "category", "day"];

export interface ReportGroup {
  key: string;
  label: string;
  seconds: number;
  /** Time that is final: submitted, and approved where that is required. */
  signedOffSeconds: number;
  /** Sum of the costs that could be worked out. */
  cost: number;
  /** Time with no rate to cost it at. */
  unratedSeconds: number;
  entries: number;
  running: boolean;
}

function emptyGroup(key: string, label: string): ReportGroup {
  return { key, label, seconds: 0, signedOffSeconds: 0, cost: 0, unratedSeconds: 0, entries: 0, running: false };
}

function add(g: ReportGroup, l: ReportLine): void {
  g.seconds += l.seconds;
  if (SIGNED_OFF_STATUSES.has(l.status)) g.signedOffSeconds += l.seconds;
  if (l.cost != null) g.cost = Math.round((g.cost + l.cost) * 100) / 100;
  else g.unratedSeconds += l.seconds;
  g.entries++;
  if (l.status === "open") g.running = true;
}

function keyOf(l: ReportLine, by: GroupBy): [string, string] {
  switch (by) {
    case "person":
      return [`p${l.userId}`, l.userName];
    case "customer":
      return [`c${l.customerId ?? ""}`, l.customerName];
    case "job":
      // The CSV keeps the stored "Customer:Job" path; a heading on screen doesn't.
      return [`j${l.jobId ?? ""}`, jobLabel(l.jobName)];
    case "category":
      return [`k${l.categoryId ?? ""}`, l.categoryName ?? "No category"];
    case "day":
      return [l.workDate, l.workDate];
  }
}

/** Lines grouped one way. Days in date order; everything else biggest first. */
export function summarize(lines: readonly ReportLine[], by: GroupBy): ReportGroup[] {
  const groups = new Map<string, ReportGroup>();
  for (const l of lines) {
    const [key, label] = keyOf(l, by);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = emptyGroup(key, label)));
    add(g, l);
  }
  const list = [...groups.values()];
  return by === "day"
    ? list.sort((a, b) => a.key.localeCompare(b.key))
    : list.sort((a, b) => b.seconds - a.seconds || a.label.localeCompare(b.label));
}

export function total(lines: readonly ReportLine[]): ReportGroup {
  const g = emptyGroup("total", "Total");
  for (const l of lines) add(g, l);
  return g;
}

// ---- CSV ----------------------------------------------------------------------------

/**
 * One CSV cell. Text a spreadsheet would run as a formula (a note starting
 * with "=", say) is prefixed with an apostrophe, so opening an export can't
 * execute what someone typed into the app.
 */
function cell(value: string | number | null): string {
  if (value == null) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const STATUS_LABEL: Record<EntryStatus, string> = {
  open: "Running",
  draft: "Not submitted",
  submitted: "Submitted",
  approved: "Approved",
  synced: "In accounting",
  sync_failed: "Signed off (accounting refused)",
};

export function linesToCsv(lines: readonly ReportLine[], timeZone: string): string {
  const header = [
    "Date",
    "Person",
    "Category",
    "Customer",
    "Job",
    "Start",
    "End",
    "Hours",
    "Status",
    "Rate",
    "Cost",
    "Note",
    "Entry ID",
  ];
  const rows = lines.map((l) => [
    l.workDate,
    l.userName,
    l.categoryName,
    l.customerName,
    l.jobName,
    l.startedAt != null ? formatClock(l.startedAt, timeZone) : null,
    l.endedAt != null ? formatClock(l.endedAt, timeZone) : null,
    decimalHours(l.seconds),
    STATUS_LABEL[l.status],
    l.hourlyRate,
    l.cost,
    l.note,
    l.entryId,
  ]);
  // CRLF, per RFC 4180; spreadsheets expect it.
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

// ---- timesheet grid ---------------------------------------------------------------

/**
 * Counts of a person's entries, in the three states a timesheet cares about.
 * Disjoint: a stopped entry is in exactly one of them, and a running timer is
 * in none (it shows as `running`).
 */
export interface SheetCounts {
  /** Stopped, and its owner hasn't said it's done yet. */
  unsubmitted: number;
  /** Submitted. Waiting for an admin, where the organisation requires one. */
  submitted: number;
  /** An admin has approved it, whether or not it has been sent. */
  approved: number;
}

export interface SheetCell extends SheetCounts {
  date: string;
  seconds: number;
  entries: number;
  running: boolean;
}

export interface SheetRow extends SheetCounts {
  userId: number;
  name: string;
  categoryName: string | null;
  active: boolean;
  days: SheetCell[];
  seconds: number;
  running: boolean;
}

/**
 * People × days for one week: everyone active (with or without time), plus
 * anyone deactivated who has time that week.
 */
export function timesheet(
  weekStart: string,
  opts: { categoryId?: number | null } = {},
  now: number = Date.now(),
): { days: string[]; rows: SheetRow[] } {
  const days = datesBetween(weekStart, addDays(weekStart, 6));
  const lines = reportLines({ from: days[0]!, to: days[6]!, categoryId: opts.categoryId }, now);
  const { people, categories } = lookups();

  const rows = new Map<number, SheetRow>();
  const rowFor = (userId: number): SheetRow => {
    let row = rows.get(userId);
    if (!row) {
      const p = people.get(userId);
      const categoryId = p?.categoryId ?? null;
      row = {
        userId,
        name: p?.name ?? "Unknown person",
        categoryName: categoryId != null ? (categories.get(categoryId) ?? null) : null,
        active: p?.active ?? false,
        days: days.map((date) => ({
          date,
          seconds: 0,
          entries: 0,
          unsubmitted: 0,
          submitted: 0,
          approved: 0,
          running: false,
        })),
        seconds: 0,
        unsubmitted: 0,
        submitted: 0,
        approved: 0,
        running: false,
      };
      rows.set(userId, row);
    }
    return row;
  };

  for (const [id, p] of people) {
    if (p.active && (opts.categoryId == null || p.categoryId === opts.categoryId)) rowFor(id);
  }
  for (const l of lines) {
    const row = rowFor(l.userId);
    const day = row.days.find((d) => d.date === l.workDate)!;
    day.seconds += l.seconds;
    day.entries++;
    row.seconds += l.seconds;
    const bucket =
      l.status === "draft" ? "unsubmitted" : l.status === "submitted" ? "submitted" : APPROVED_STATUSES.has(l.status) ? "approved" : null;
    if (bucket) {
      day[bucket]++;
      row[bucket]++;
    }
    if (l.status === "open") day.running = row.running = true;
  }
  return {
    days,
    rows: [...rows.values()].sort(
      (a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    ),
  };
}

// ---- week calendar ----------------------------------------------------------------

export interface CalendarBlock {
  entryId: string;
  userId: number;
  jobName: string;
  note: string | null;
  status: EntryStatus;
  workDate: string;
  start: number;
  /** For a running segment: null (it runs until now). */
  end: number | null;
}

export interface CalendarWeek {
  days: string[];
  people: { userId: number; name: string }[];
  /** Timed work, one block per segment — pauses show as gaps. */
  blocks: CalendarBlock[];
  /** Typed-in durations, which have no place on a clock. */
  untimed: { entryId: string; userId: number; jobName: string; workDate: string; seconds: number; status: EntryStatus }[];
}

export function calendarWeek(weekStart: string, filter: Omit<ReportFilter, "from" | "to"> = {}, now = Date.now()): CalendarWeek {
  const days = datesBetween(weekStart, addDays(weekStart, 6));
  const lines = reportLines({ ...filter, from: days[0]!, to: days[6]! }, now);
  const byId = new Map(lines.map((l) => [l.entryId, l]));

  const timed = lines.filter((l) => l.startedAt != null).map((l) => l.entryId);
  const segments = timed.length
    ? db()
        .query<{ entry_id: string; started_at: number; ended_at: number | null }, string[]>(
          `SELECT entry_id, started_at, ended_at FROM time_segments
            WHERE entry_id IN (${timed.map(() => "?").join(",")})
            ORDER BY started_at, id`,
        )
        .all(...timed)
    : [];

  const blocks: CalendarBlock[] = segments.map((s) => {
    const l = byId.get(s.entry_id)!;
    return {
      entryId: l.entryId,
      userId: l.userId,
      jobName: l.jobName,
      note: l.note,
      status: l.status,
      workDate: l.workDate,
      start: s.started_at,
      end: s.ended_at,
    };
  });

  const people = new Map<number, string>();
  for (const l of lines) people.set(l.userId, l.userName);

  return {
    days,
    people: [...people].map(([userId, name]) => ({ userId, name })).sort((a, b) => a.name.localeCompare(b.name)),
    blocks,
    untimed: lines
      .filter((l) => l.startedAt == null)
      .map((l) => ({
        entryId: l.entryId,
        userId: l.userId,
        jobName: l.jobName,
        workDate: l.workDate,
        seconds: l.seconds,
        status: l.status,
      })),
  };
}
