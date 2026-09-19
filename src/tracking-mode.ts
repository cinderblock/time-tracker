/**
 * How a person records their time — one of two ways, chosen by them:
 *
 * - `timer`: start a timer on a job, switch as the work changes, stop at the
 *   end. Time exists as it happens.
 * - `notes`: jot what you're doing as you go, and at the end of the day (or
 *   the next morning) turn the notes into time. A day's notes have to become
 *   time before the next day's can begin.
 *
 * Dependency-free: the browser's tracking screen imports it too.
 */

export type TrackingMode = "timer" | "notes";

export const TRACKING_MODES: readonly TrackingMode[] = ["timer", "notes"];

export const DEFAULT_TRACKING_MODE: TrackingMode = "timer";

export function isTrackingMode(value: unknown): value is TrackingMode {
  return TRACKING_MODES.includes(value as TrackingMode);
}
