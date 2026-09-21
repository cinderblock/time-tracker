import { isRouteErrorResponse } from "react-router";

import { addDays, weekStartOf, weekdayOf, workDateOf } from "../../src/time.ts";
import type { DayModel } from "../tracker/model.ts";
import {
  type StoredDay,
  getDaySnapshot,
  getLatestSnapshot,
  putDaySnapshot,
  rootCopy,
  shellCopy,
} from "./storage.ts";

/**
 * Client loaders for offline use: ask the server, keep a copy, and when the
 * server can't be reached answer from the copy instead.
 */

/**
 * Whether an error means "couldn't reach the app" rather than "the app said
 * no". A proxy answering 502/503/504 counts: the box is up, the app isn't.
 */
export function isOfflineError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch itself failed
  if (err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError")) return true;
  const status = isRouteErrorResponse(err) ? err.status : err instanceof Response ? err.status : null;
  if (status != null) return status === 502 || status === 503 || status === 504;
  return err instanceof Error && /failed to fetch|network|load failed/i.test(err.message);
}

let keptMarkerSeen = false;

/** Whether this page came from the service worker's kept copies. Answers once. */
function takeKeptCopyMarker(): boolean {
  if (keptMarkerSeen || typeof document === "undefined") return false;
  keptMarkerSeen = true;
  return document.querySelector('meta[name="tt-kept-copy"]') != null;
}

/** Root loader data as the root route returns it. */
export interface RootCopy {
  branding: { name: string; shortName: string; themeColor: string; palette: string[]; primaryShade?: number };
  timezone: string;
}

/**
 * Load a day: from the server when possible (and remember it), else from the
 * device. `date` is null for "today", which offline is worked out from the
 * organisation's timezone.
 */
export async function loadDayWithFallback(
  serverLoader: () => Promise<DayModel>,
  date: string | null,
): Promise<DayModel> {
  const fetchedAt = Date.now();
  // True only for the first load of a page the service worker served from its
  // kept copies: the data inside it didn't come from the server just now.
  const kept = takeKeptCopyMarker();
  try {
    const server = await serverLoader();
    // During hydration `serverLoader` returns the data inside the page itself,
    // and that page may be an old copy the service worker served. Prefer the
    // device's copy if the server produced it later.
    const stored = await getDaySnapshot(server.userId, server.workDate).catch(() => null);
    if (stored && stored.generatedAt > server.generatedAt) {
      const { storedAt: _storedAt, ...model } = stored;
      return { ...model, fetchedAt: 0, offline: kept };
    }
    if (kept) return { ...server, fetchedAt: 0, offline: true };
    void putDaySnapshot(server).catch(() => {});
    return { ...server, fetchedAt };
  } catch (err) {
    if (!isOfflineError(err)) throw err;
    const offline = await offlineDay(date);
    if (!offline) throw err;
    return offline;
  }
}

async function offlineDay(requested: string | null): Promise<DayModel | null> {
  const shell = shellCopy.read();
  const root = rootCopy.read<RootCopy>();
  if (!shell || !root) return null;
  const tz = root.timezone;
  const today = workDateOf(Date.now(), tz);
  const date = requested ?? today;

  const stored = await getDaySnapshot(shell.userId, date).catch(() => null);
  if (stored) return offlineCopy(stored, { today });

  // Never loaded this day on this device: start from the latest copy of any
  // day (it has the jobs, the settings and any running timer) with nothing
  // recorded, and say so on screen.
  const latest = await getLatestSnapshot(shell.userId).catch(() => null);
  if (!latest) return null;
  // Which weekday weeks start on is an organisation setting, and no copy
  // stores it as such — but every copy's week strip begins on it, so the
  // latest copy says. Assuming Sunday here put the strip a day out for an
  // organisation whose weeks start on Monday.
  const firstDay = latest.week[0] ? weekdayOf(latest.week[0].date) : 0;
  const weekStart = weekStartOf(date, firstDay);
  return offlineCopy(
    {
      ...latest,
      workDate: date,
      entries: latest.open && latest.open.workDate === date ? [latest.open] : [],
      notes: [],
      week: Array.from({ length: 7 }, (_, i) => ({ date: addDays(weekStart, i), seconds: 0 })),
    },
    { today, partial: true },
  );
}

function offlineCopy(day: StoredDay, extra: { today: string; partial?: boolean }): DayModel {
  const { storedAt: _storedAt, ...model } = day;
  return {
    ...model,
    today: extra.today,
    // Nothing confirmed this session is in an old copy: keep applying it.
    fetchedAt: 0,
    offline: true,
    partial: extra.partial ?? false,
  };
}
