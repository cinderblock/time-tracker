import { useEffect, useRef } from "react";

import { CODE_BUILD } from "../../src/build-info.ts";
import { getEngine } from "../offline/client.ts";
import { idbOutbox } from "../offline/storage.ts";
import { recentCrumbs } from "./breadcrumbs.ts";
import { recentErrors } from "./errors.ts";
import { problemQueue } from "./queue.ts";
import { rollCall } from "./tabs.ts";

/**
 * Everything a bug report carries besides the person's words: what the screen
 * was showing, what the app was doing, what it knew, and about the device.
 *
 * Screens add their own data while they're mounted — the day screen its day,
 * an admin page its rows — with `useBugContext`. The rest is gathered here
 * when the button is pressed. Each part is gathered on its own, so one that
 * fails (a browser without some API) says why and the rest still arrive.
 */

const providers = new Map<string, () => unknown>();

/** While this component is mounted, a bug report includes `get()` under `screens[name]`. */
export function useBugContext(name: string, get: () => unknown): void {
  const latest = useRef(get);
  latest.current = get;
  useEffect(() => {
    const read = () => latest.current();
    providers.set(name, read);
    return () => {
      if (providers.get(name) === read) providers.delete(name);
    };
  }, [name]);
}

async function part<T>(fn: () => T | Promise<T>): Promise<T | { unavailable: string }> {
  try {
    return await fn();
  } catch (err) {
    return { unavailable: err instanceof Error ? err.message : String(err) };
  }
}

function device() {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
    standalone?: boolean;
    userAgentData?: { platform?: string; mobile?: boolean; brands?: { brand: string; version: string }[] };
  };
  return {
    userAgent: nav.userAgent,
    userAgentData: nav.userAgentData ? { platform: nav.userAgentData.platform, mobile: nav.userAgentData.mobile, brands: nav.userAgentData.brands } : null,
    languages: nav.languages,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio },
    screen: { width: screen.width, height: screen.height, orientation: screen.orientation?.type ?? null },
    touch: nav.maxTouchPoints > 0,
    installedApp: matchMedia("(display-mode: standalone)").matches || nav.standalone === true,
    colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    cores: nav.hardwareConcurrency ?? null,
    memoryGb: nav.deviceMemory ?? null,
    connection: nav.connection
      ? { effectiveType: nav.connection.effectiveType, downlink: nav.connection.downlink, rtt: nav.connection.rtt, saveData: nav.connection.saveData }
      : null,
    online: nav.onLine,
    cookiesEnabled: nav.cookieEnabled,
  };
}

async function serviceWorker() {
  if (!("serviceWorker" in navigator)) return { supported: false };
  const reg = await navigator.serviceWorker.getRegistration();
  // The worker's cache is named for the build it keeps: which build a reload would show.
  const cacheNames = typeof caches !== "undefined" ? await caches.keys() : [];
  return {
    supported: true,
    controlled: navigator.serviceWorker.controller != null,
    scope: reg?.scope ?? null,
    active: reg?.active?.state ?? null,
    waiting: reg?.waiting != null,
    installing: reg?.installing != null,
    cachedBuilds: cacheNames.filter((n) => n.startsWith("tt-assets-")).map((n) => n.slice("tt-assets-".length)),
  };
}

async function storage() {
  const estimate = await navigator.storage?.estimate?.();
  return {
    usageBytes: estimate?.usage ?? null,
    quotaBytes: estimate?.quota ?? null,
    persisted: (await navigator.storage?.persisted?.()) ?? null,
  };
}

async function permissions() {
  const out: Record<string, string> = {};
  out.notifications = typeof Notification !== "undefined" ? Notification.permission : "unsupported";
  for (const name of ["geolocation"] as const) {
    out[name] = await navigator.permissions
      ?.query({ name })
      .then((s) => s.state)
      .catch(() => "unknown") ?? "unsupported";
  }
  return out;
}

async function sync(userId: number | null) {
  const engine = getEngine();
  const queued = userId != null && typeof indexedDB !== "undefined" ? await idbOutbox.list(userId) : [];
  return {
    status: engine?.getStatus() ?? null,
    // Changes made on this device that the server hasn't confirmed: often the very thing that "didn't save".
    outbox: queued.map((q) => ({ queuedAt: q.queuedAt, attempts: q.attempts, lastError: q.lastError, op: q.op })),
    problemsWaiting: (await problemQueue().pending()).map((p) => ({ kind: p.kind, queuedAt: p.queuedAt, attempts: p.attempts, lastError: p.lastError })),
  };
}

function screens() {
  const out: Record<string, unknown> = {};
  for (const [name, get] of providers) {
    try {
      // Through JSON: what's sent is what's stored, and a cycle fails here, not on the way.
      out[name] = JSON.parse(JSON.stringify(get() ?? null)) as unknown;
    } catch (err) {
      out[name] = { unavailable: err instanceof Error ? err.message : String(err) };
    }
  }
  return out;
}

/** Everything, for a report filed now by `userId`. */
export async function gatherContext(userId: number | null): Promise<Record<string, unknown>> {
  const [tabs, sw, store, perms, syncState] = await Promise.all([
    part(() => rollCall()),
    part(serviceWorker),
    part(storage),
    part(permissions),
    part(() => sync(userId)),
  ]);
  return {
    gatheredAt: Date.now(),
    page: {
      url: location.href,
      title: document.title,
      referrer: document.referrer || null,
      openedAt: Math.round(performance.timeOrigin),
      openForSeconds: Math.round(performance.now() / 1000),
      navigation: (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type ?? null,
      // The control that had the cursor, by name: where the person was.
      focused: document.activeElement && document.activeElement !== document.body ? document.activeElement.getAttribute("aria-label") ?? document.activeElement.tagName : null,
    },
    build: { code: CODE_BUILD, serviceWorker: sw },
    device: await part(device),
    storage: store,
    permissions: perms,
    sync: syncState,
    screens: screens(),
    breadcrumbs: recentCrumbs(),
    errors: recentErrors(),
    tabs,
  };
}
