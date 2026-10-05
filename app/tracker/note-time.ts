import { zonedTimeInput, zonedTimeToInstant } from "../../src/time.ts";

/**
 * When a note on `date` happened, from a time typed for it ("HH:MM"). A note
 * written on today is stamped as it's written; one written up afterwards — on
 * an earlier day, or re-timed — says when, and the hours are worked out from
 * that, so it has to be there and can't be later than now.
 */
export function noteTimeOn(
  date: string,
  time: string,
  timeZone: string,
  now: number,
): { ok: true; at: number } | { ok: false; problem: string } {
  if (!/^\d{1,2}:\d{2}$/.test(time.trim())) return { ok: false, problem: "Say when." };
  const at = zonedTimeToInstant(date, time.trim(), timeZone);
  if (at > now) return { ok: false, problem: "That's later than now." };
  return { ok: true, at };
}

/**
 * The time a new note on a written-up day starts from: the latest one already
 * written there — the person's own last word on when they were — or nothing,
 * on a day with no notes yet. Never a time made up for them.
 */
export function latestTimeOn(notes: readonly { at: number }[], timeZone: string): string {
  if (notes.length === 0) return "";
  return zonedTimeInput(Math.max(...notes.map((n) => n.at)), timeZone);
}
