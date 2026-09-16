/**
 * Opportunistic location for time entries and notes.
 *
 * Off unless the person turns it on (Account page). When on, the tracking
 * screen fetches a fix in the background and keeps the latest; actions attach
 * whatever recent fix there is instead of waiting for GPS — starting a timer
 * must never stall on a satellite lock. Each fix carries its own timestamp, so
 * a slightly stale one is recorded honestly as such.
 *
 * A web app can't track in the background, so this is samples at the moments
 * that matter, not a trail.
 */

const PREF_KEY = "tt-location";
const MAX_AGE_MS = 5 * 60_000;

export interface Fix {
  lat: number;
  lon: number;
  accuracy: number | null;
  at: number;
}

let latest: Fix | null = null;

export function locationEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "on";
  } catch {
    return false;
  }
}

function capture(pos: GeolocationPosition): Fix {
  latest = {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
    at: Math.round(pos.timestamp),
  };
  return latest;
}

function request(timeout: number): Promise<Fix | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(capture(pos)),
      () => resolve(null),
      { enableHighAccuracy: false, maximumAge: 60_000, timeout },
    );
  });
}

/** Turn location on (asks for permission) or off. Resolves whether it's now on. */
export async function setLocationEnabled(on: boolean): Promise<boolean> {
  if (!on) {
    localStorage.setItem(PREF_KEY, "off");
    latest = null;
    return false;
  }
  const fix = await request(15_000);
  if (!fix) return false; // denied or unavailable: stay off
  localStorage.setItem(PREF_KEY, "on");
  return true;
}

/** Refresh the cached fix in the background, if location is on. */
export function refreshLocation(): void {
  if (locationEnabled()) void request(10_000);
}

/** The latest fix if it's recent, for attaching to an op. Never waits. */
export function recentFix(): Fix | null {
  if (!locationEnabled() || !latest) return null;
  if (Date.now() - latest.at > MAX_AGE_MS) return null;
  refreshLocation();
  return latest;
}
