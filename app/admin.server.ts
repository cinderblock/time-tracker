import { listCategories } from "../src/categories.ts";
import { config } from "../src/config.server.ts";
import { jobLabel } from "../src/job-names.ts";
import { listJobs } from "../src/jobs.ts";
import { GROUP_BYS, type GroupBy, type ReportFilter } from "../src/reports.ts";
import { weekStartsOn } from "../src/settings.ts";
import { addDays, isWorkDate, today, weekStartOf } from "../src/time.ts";
import { listUsers } from "../src/users.ts";
import { RANGE_PRESETS, type RangePreset } from "./report-ranges.ts";

/**
 * Shared pieces of the admin pages' loaders.
 */

export interface WeekContext {
  /** First day of the week shown. */
  weekStart: string;
  /** First day of the current week. */
  thisWeek: string;
  today: string;
}

/** The week a page shows: the one containing `?week=<any date>`, else this week. */
export function weekFromUrl(request: Request): WeekContext {
  const firstDay = weekStartsOn();
  const todayDate = today(config.timezone);
  const asked = new URL(request.url).searchParams.get("week");
  const thisWeek = weekStartOf(todayDate, firstDay);
  return {
    weekStart: isWorkDate(asked) ? weekStartOf(asked, firstDay) : thisWeek,
    thisWeek,
    today: todayDate,
  };
}

// ---- report queries ---------------------------------------------------------------

/** The longest range a report covers, so one request can't ask for decades. */
const MAX_REPORT_DAYS = 400;

function monthStart(date: string): string {
  return `${date.slice(0, 8)}01`;
}

function nextMonthStart(date: string): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

export interface ReportQuery {
  range: RangePreset;
  from: string;
  to: string;
  by: GroupBy;
  personId: number | null;
  categoryId: number | null;
  jobId: string | null;
  filter: ReportFilter;
}

/** A report's settings from its URL, with defaults: this week, by person, everyone. */
export function reportQuery(url: URL): ReportQuery {
  const params = url.searchParams;
  const todayDate = today(config.timezone);
  const thisWeek = weekStartOf(todayDate, weekStartsOn());
  const asked = params.get("range");
  let range: RangePreset = RANGE_PRESETS.some((p) => p.value === asked) ? (asked as RangePreset) : "this-week";

  let from = thisWeek;
  let to = addDays(thisWeek, 6);
  if (range === "last-week") {
    from = addDays(thisWeek, -7);
    to = addDays(thisWeek, -1);
  } else if (range === "this-month") {
    from = monthStart(todayDate);
    to = addDays(nextMonthStart(todayDate), -1);
  } else if (range === "last-month") {
    to = addDays(monthStart(todayDate), -1);
    from = monthStart(to);
  } else if (range === "custom") {
    const a = params.get("from");
    const b = params.get("to");
    if (isWorkDate(a) && isWorkDate(b)) {
      [from, to] = a <= b ? [a, b] : [b, a];
      if (addDays(from, MAX_REPORT_DAYS - 1) < to) from = addDays(to, -(MAX_REPORT_DAYS - 1));
    } else {
      range = "this-week";
    }
  }

  const byParam = params.get("by");
  const by: GroupBy = GROUP_BYS.includes(byParam as GroupBy) ? (byParam as GroupBy) : "person";
  const personId = idParam(url, "person");
  const categoryId = idParam(url, "category");
  const jobParam = params.get("job");
  const jobId = jobParam && listJobs({ includeInactive: true }).some((j) => j.id === jobParam) ? jobParam : null;

  return {
    range,
    from,
    to,
    by,
    personId,
    categoryId,
    jobId,
    filter: { from, to, userIds: personId ? [personId] : undefined, categoryId, jobId },
  };
}

/** A positive integer search parameter, or null. */
export function idParam(url: URL, name: string): number | null {
  const value = Number(url.searchParams.get(name));
  return Number.isInteger(value) && value > 0 ? value : null;
}

export interface Option {
  value: string;
  label: string;
}

/** Everyone, for pickers: active people first. Deactivated people are marked. */
export function peopleOptions(): Option[] {
  return listUsers().map((u) => ({ value: String(u.id), label: u.active ? u.name : `${u.name} (deactivated)` }));
}

export function categoryOptions(): Option[] {
  return listCategories().map((c) => ({ value: String(c.id), label: c.name }));
}

/** Jobs for pickers; closed ones are marked, since reports still cover them. */
export function jobOptions(): Option[] {
  return listJobs({ includeInactive: true }).map((j) => ({
    value: j.id,
    label: j.active ? jobLabel(j.fullName) : `${jobLabel(j.fullName)} (closed)`,
  }));
}
