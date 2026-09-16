import { type IDBPDatabase, openDB } from "idb";

import type { Op } from "../../src/ops-schema.ts";
import type { DayModel } from "../tracker/model.ts";

/**
 * What the app keeps on the device (IndexedDB):
 *
 *   outbox     ops not yet confirmed by the server, in the order they were made,
 *              each tagged with the person who made them
 *   snapshots  the last copy of each day the person looked at, so the tracking
 *              screen still renders with no connection
 *
 * Ops are tagged by person because the server applies an op to whoever is
 * signed in: a queue left behind by one person must never be sent while
 * someone else is signed in on the same device.
 */

export interface QueuedOp {
  seq: number;
  userId: number;
  op: Op;
  queuedAt: number;
  attempts: number;
  lastError: string | null;
}

export interface OutboxStore {
  list(userId: number): Promise<QueuedOp[]>;
  add(item: Omit<QueuedOp, "seq">): Promise<QueuedOp>;
  update(item: QueuedOp): Promise<void>;
  remove(seqs: number[]): Promise<void>;
}

const DB_NAME = "time-tracker";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

function database(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const outbox = db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
      outbox.createIndex("byUser", "userId");
      db.createObjectStore("snapshots");
    },
  });
  return dbPromise;
}

export const idbOutbox: OutboxStore = {
  async list(userId) {
    const db = await database();
    const items = (await db.getAllFromIndex("outbox", "byUser", userId)) as QueuedOp[];
    return items.sort((a, b) => a.seq - b.seq);
  },
  async add(item) {
    const db = await database();
    const seq = (await db.add("outbox", item)) as number;
    return { ...item, seq };
  },
  async update(item) {
    const db = await database();
    await db.put("outbox", item);
  },
  async remove(seqs) {
    if (seqs.length === 0) return;
    const db = await database();
    const tx = db.transaction("outbox", "readwrite");
    await Promise.all([...seqs.map((seq) => tx.store.delete(seq)), tx.done]);
  },
};

/** How many ops anyone has queued on this device (for the sign-out warning). */
export async function countQueued(userId: number): Promise<number> {
  const db = await database();
  return db.countFromIndex("outbox", "byUser", userId);
}

// ---- snapshots ------------------------------------------------------------------------

export type StoredDay = DayModel & { storedAt: number };

const dayKey = (userId: number, date: string) => `day:${userId}:${date}`;
const latestKey = (userId: number) => `day:${userId}:latest`;

export async function getDaySnapshot(userId: number, date: string): Promise<StoredDay | null> {
  const db = await database();
  return ((await db.get("snapshots", dayKey(userId, date))) as StoredDay | undefined) ?? null;
}

/** The most recently stored day of any date — the base for a day never seen offline. */
export async function getLatestSnapshot(userId: number): Promise<StoredDay | null> {
  const db = await database();
  return ((await db.get("snapshots", latestKey(userId))) as StoredDay | undefined) ?? null;
}

export async function putDaySnapshot(model: DayModel): Promise<void> {
  const db = await database();
  const stored: StoredDay = { ...model, offline: false, fetchedAt: undefined, storedAt: Date.now() };
  const tx = db.transaction("snapshots", "readwrite");
  await Promise.all([
    tx.store.put(stored, dayKey(model.userId, model.workDate)),
    tx.store.put(stored, latestKey(model.userId)),
    tx.done,
  ]);
}

/** Forget one person's cached days (on sign-out). Their queued ops are kept. */
export async function clearSnapshots(userId: number): Promise<void> {
  const db = await database();
  const tx = db.transaction("snapshots", "readwrite");
  const prefix = `day:${userId}:`;
  for (const key of await tx.store.getAllKeys()) {
    if (typeof key === "string" && key.startsWith(prefix)) await tx.store.delete(key);
  }
  await tx.done;
}

// ---- small synchronous values (localStorage) -----------------------------------------------

/**
 * The shell the signed-in layout needs before any day loads: branding,
 * timezone, and who is signed in. Kept in localStorage so it's available
 * synchronously, and small enough not to matter.
 */
export interface ShellCopy {
  userId: number;
  name: string;
  role: "admin" | "employee";
}

const SHELL_KEY = "tt-shell";
const ROOT_KEY = "tt-root";

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: offline launch just won't have this copy.
  }
}

export const shellCopy = {
  read: () => readJson<ShellCopy>(SHELL_KEY),
  write: (value: ShellCopy) => writeJson(SHELL_KEY, value),
  clear: () => {
    try {
      localStorage.removeItem(SHELL_KEY);
    } catch {
      // ignore
    }
  },
};

export const rootCopy = {
  read: <T>() => readJson<T>(ROOT_KEY),
  write: (value: unknown) => writeJson(ROOT_KEY, value),
};

/** Ask the browser not to evict this site's storage under pressure (Safari evicts after ~7 days otherwise). */
export function requestPersistentStorage(): void {
  void navigator.storage?.persist?.().catch(() => {});
}
