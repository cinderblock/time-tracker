import { useEffect } from "react";

import { addDays, workDateOf, zonedTimeToInstant } from "../../src/time.ts";

/**
 * Midnight, reaching a page that is already open.
 *
 * Every label on the day screen that says which day it is — the title, "Back
 * to today", the ring on today in the week strip, whether the forward arrows
 * have anywhere to go — comes from `today` on the copy the loader produced.
 * A page left open overnight keeps the copy it was given, so it goes on
 * calling that day today: left open for two days, it still said Monday.
 *
 * The fix is to ask the loader for a fresh copy, not to patch `today` in the
 * browser. The loader is the one place that decides what today is, and it
 * decides correctly offline too (`app/offline/loaders.ts` derives it from the
 * device clock in the organisation's timezone). On `/` the fresh copy *is*
 * the new day; on `/day/<date>` it is the same day with a corrected `today`,
 * which is all its labels need. One source of truth, so the screen can never
 * be caught disagreeing with itself.
 */

/** How long after the boundary to ask, so the server's clock has certainly crossed it too. */
const SETTLE_MS = 2_000;
/** Still the old day after a fresh copy — a device clock that's out. Ask again, but not forever. */
const RETRY_MS = 60_000;
const MAX_ATTEMPTS = 3;

/**
 * Whether the copy on screen was made on an earlier day than the one it is
 * now, and when to look again.
 *
 * Only *forward* counts: a device clock that lags says nothing the loader
 * hasn't already said. `settled` asks a moment after the boundary rather than
 * on it, so a browser whose clock is milliseconds ahead of the server's can't
 * ask for "today" and be handed yesterday again.
 */
export function rolloverCheck(
  now: number,
  today: string,
  timeZone: string,
  attemptsSoFar: number,
): { stale: boolean; nextCheckIn: number } {
  const here = workDateOf(now, timeZone);
  const stale = here > today;
  const boundary = zonedTimeToInstant(addDays(here, 1), "00:00", timeZone) + SETTLE_MS - now;
  return {
    stale,
    nextCheckIn: stale && attemptsSoFar < MAX_ATTEMPTS ? RETRY_MS : Math.max(SETTLE_MS, boundary),
  };
}

/**
 * Ask for a fresh copy whenever the work date moves on. Woken by a timer
 * aimed just past the next boundary, and again whenever the tab comes back:
 * a sleeping laptop fires its timers late and a background tab has them
 * throttled, so neither can be relied on alone.
 */
export function useDayRollover(today: string, timeZone: string, revalidate: () => void): void {
  useEffect(() => {
    let attempts = 0;
    let timer = 0;
    const check = () => {
      window.clearTimeout(timer);
      const { stale, nextCheckIn } = rolloverCheck(Date.now(), today, timeZone, attempts);
      if (stale && attempts < MAX_ATTEMPTS) {
        attempts += 1;
        revalidate();
      }
      timer = window.setTimeout(check, nextCheckIn);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [today, timeZone, revalidate]);
}
