import { useSyncExternalStore } from "react";

import type { Op } from "../../src/ops-schema.ts";
import { sendOps } from "../tracker/ops-client.ts";
import { idbOutbox } from "./storage.ts";
import { type SyncEngine as Engine, SyncEngine, type SyncMessage, type SyncStatus, memoryOutbox } from "./sync.ts";

/**
 * The page's one sync engine, wired to the real browser: IndexedDB, fetch,
 * timers, Web Locks (one tab sends at a time) and a BroadcastChannel (the
 * other tabs hear about it). Created on first use in the browser; null on the
 * server.
 */

let engine: Engine | null = null;

export function getEngine(): Engine | null {
  if (typeof window === "undefined") return null;
  if (engine) return engine;

  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("tt-outbox") : null;
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;

  const created = new SyncEngine({
    store: typeof indexedDB !== "undefined" ? idbOutbox : memoryOutbox(),
    send: sendOps,
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    withLock: locks
      ? (fn) =>
          locks.request("tt-outbox", { ifAvailable: true }, async (lock) => {
            if (!lock) return false;
            await fn();
            return true;
          })
      : undefined,
    broadcast: channel ? (message) => channel.postMessage(message) : undefined,
  });
  engine = created;

  channel?.addEventListener("message", (event: MessageEvent<SyncMessage>) => void created.receive(event.data));
  // The retry backoff covers most outages; these catch the obvious moments to
  // try again straight away.
  window.addEventListener("online", () => void created.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void created.flush();
  });
  return created;
}

const idleStatus: SyncStatus = { pending: 0, syncing: false, offline: false, signedOut: false, lastSyncedAt: null };
const noOps: Op[] = [];
const noop = () => () => {};

export function useSyncStatus(): SyncStatus {
  const e = getEngine();
  return useSyncExternalStore(
    e ? (l) => e.subscribe(l) : noop,
    () => e?.getStatus() ?? idleStatus,
    () => idleStatus,
  );
}

/** Ops the screen should show on top of the server's copy. */
export function useQueuedOps(): Op[] {
  const e = getEngine();
  return useSyncExternalStore(
    e ? (l) => e.subscribe(l) : noop,
    () => e?.getOps() ?? noOps,
    () => noOps,
  );
}
