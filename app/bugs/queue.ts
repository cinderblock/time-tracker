import { type IDBPDatabase, openDB } from "idb";

import { addCrumb } from "./breadcrumbs.ts";

/**
 * Problems waiting to reach the server: bug reports and batches of errors.
 *
 * A report made with no connection — in a basement, on a site — is exactly
 * the one that mustn't be lost, so everything goes through here: kept on the
 * device, sent now if possible, and again when the connection comes back.
 *
 * Its own database, not a new store in the outbox's: adding a store means a
 * version upgrade, and a tab still running older code would hold that
 * upgrade — and with it the outbox — until it closed.
 */

export type ProblemKind = "report" | "errors";

export interface QueuedProblem {
  key: string;
  kind: ProblemKind;
  /** Whose report it is; a report is only sent while they're signed in. Null for errors. */
  userId: number | null;
  body: unknown;
  queuedAt: number;
  attempts: number;
  lastError: string | null;
}

export interface ProblemStore {
  list(): Promise<QueuedProblem[]>;
  put(item: QueuedProblem): Promise<void>;
  remove(key: string): Promise<void>;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

const idbStore: ProblemStore = {
  async list() {
    const items = (await (await db()).getAll("pending")) as QueuedProblem[];
    return items.sort((a, b) => a.queuedAt - b.queuedAt);
  },
  async put(item) {
    await (await db()).put("pending", item);
  },
  async remove(key) {
    await (await db()).delete("pending", key);
  },
};

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB("time-tracker-problems", 1, {
    upgrade(d) {
      d.createObjectStore("pending", { keyPath: "key" });
    },
  });
  return dbPromise;
}

/** A store that lives in memory: where IndexedDB is missing, and in tests. */
export function memoryProblemStore(): ProblemStore {
  const items = new Map<string, QueuedProblem>();
  return {
    list: async () => [...items.values()].sort((a, b) => a.queuedAt - b.queuedAt),
    put: async (item) => void items.set(item.key, structuredClone(item)),
    remove: async (key) => void items.delete(key),
  };
}

export type SendOutcome = "sent" | "retry" | "refused" | "signed_out";

export interface QueueDeps {
  store: ProblemStore;
  /** Send one; say how it went. */
  send(item: QueuedProblem): Promise<{ outcome: SendOutcome; error?: string; answer?: unknown }>;
  /** Who is signed in now, if anyone. */
  currentUser(): number | null;
  now(): number;
}

export type AddResult =
  | { status: "sent"; answer: unknown }
  | { status: "queued" }
  | { status: "refused"; error: string }
  /** Couldn't be kept on the device, and couldn't be sent either. */
  | { status: "lost" };

/** Give up on an item after this many failed sends (errors only; reports wait). */
const MAX_ERROR_ATTEMPTS = 10;

export class ProblemQueue {
  private flushing: Promise<void> | null = null;
  private listeners = new Set<(key: string, answer: unknown) => void>();
  /** Refused by the server since they were added, and why: how `add` tells "refused" from "sent". */
  private refusedKeys = new Map<string, string>();
  constructor(private readonly deps: QueueDeps) {}

  /**
   * Keep it, then try to send everything waiting. Resolves once this item is
   * sent (with the server's answer), kept for later, or refused (with why).
   */
  async add(item: Omit<QueuedProblem, "attempts" | "lastError" | "queuedAt">): Promise<AddResult> {
    const queued: QueuedProblem = { ...item, queuedAt: this.deps.now(), attempts: 0, lastError: null };
    try {
      await this.deps.store.put(queued);
    } catch {
      // No storage (private mode, full): send it directly and hope.
      const r = await this.deps.send(queued).catch(() => ({ outcome: "retry" as const, error: undefined, answer: undefined }));
      if (r.outcome === "sent") return { status: "sent", answer: r.answer };
      if (r.outcome === "refused") return { status: "refused", error: r.error ?? "Refused" };
      return { status: "lost" };
    }
    let answer: unknown;
    const stop = this.onSent((key, a) => {
      if (key === item.key) answer = a;
    });
    try {
      await this.flush();
    } finally {
      stop();
    }
    const refused = this.refusedKeys.get(item.key);
    if (refused !== undefined) {
      this.refusedKeys.delete(item.key);
      return { status: "refused", error: refused };
    }
    const still = (await this.deps.store.list()).some((p) => p.key === item.key);
    return still ? { status: "queued" } : { status: "sent", answer };
  }

  /** Called with the server's answer when an item is sent. */
  onSent(listener: (key: string, answer: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Send what's waiting, oldest first. One flush at a time. */
  flush(): Promise<void> {
    this.flushing ??= this.run().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async run(): Promise<void> {
    const user = this.deps.currentUser();
    for (const item of await this.deps.store.list()) {
      // Someone else's report waits for them.
      if (item.kind === "report" && item.userId !== user) continue;
      let result: Awaited<ReturnType<QueueDeps["send"]>>;
      try {
        result = await this.deps.send(item);
      } catch (err) {
        result = { outcome: "retry", error: err instanceof Error ? err.message : String(err) };
      }
      if (result.outcome === "sent") {
        await this.deps.store.remove(item.key);
        for (const l of this.listeners) l(item.key, result.answer);
        continue;
      }
      if (result.outcome === "refused") {
        // The server said no, and will say it again: keep a note, drop it.
        addCrumb("error", `A ${item.kind === "report" ? "bug report" : "batch of errors"} was refused: ${result.error ?? "no reason"}`);
        this.refusedKeys.set(item.key, result.error ?? "Refused");
        await this.deps.store.remove(item.key);
        continue;
      }
      const attempts = item.attempts + 1;
      if (item.kind === "errors" && attempts >= MAX_ERROR_ATTEMPTS) {
        await this.deps.store.remove(item.key);
        continue;
      }
      await this.deps.store.put({ ...item, attempts, lastError: result.error ?? result.outcome });
      // Offline or signed out: the rest won't fare better now.
      if (result.outcome === "retry" || result.outcome === "signed_out") return;
    }
  }

  async pending(): Promise<QueuedProblem[]> {
    return this.deps.store.list();
  }
}

// ---- the page's queue ------------------------------------------------------------------

async function sendOverHttp(item: QueuedProblem): Promise<{ outcome: SendOutcome; error?: string; answer?: unknown }> {
  const url = item.kind === "report" ? "/api/bug-reports" : "/api/client-errors";
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item.body),
      credentials: "same-origin",
      keepalive: item.kind === "errors",
    });
  } catch (err) {
    return { outcome: "retry", error: err instanceof Error ? err.message : "Network error" };
  }
  if (response.ok) {
    const answer = response.status === 204 ? null : await response.json().catch(() => null);
    return { outcome: "sent", answer };
  }
  if (response.status === 401) return { outcome: "signed_out", error: "Signed out" };
  const message = await response
    .json()
    .then((b: { error?: string }) => b.error)
    .catch(() => undefined);
  // 4xx: the request itself is the problem. 5xx and the rest: try again later.
  if (response.status >= 400 && response.status < 500) return { outcome: "refused", error: message ?? `HTTP ${response.status}` };
  return { outcome: "retry", error: message ?? `HTTP ${response.status}` };
}

let pageQueue: ProblemQueue | null = null;
let signedIn: number | null = null;

/** Who's signed in, as the app shell knows it (null on the sign-in pages). */
export function setProblemUser(userId: number | null): void {
  const changed = signedIn !== userId;
  signedIn = userId;
  if (changed && userId != null) void pageQueue?.flush();
}

export function problemQueue(): ProblemQueue {
  if (pageQueue) return pageQueue;
  const store = typeof indexedDB === "undefined" ? memoryProblemStore() : idbStore;
  pageQueue = new ProblemQueue({ store, send: sendOverHttp, currentUser: () => signedIn, now: () => Date.now() });
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => void pageQueue?.flush());
    setInterval(() => void pageQueue?.flush(), 5 * 60_000);
    // Whatever an earlier visit left behind.
    setTimeout(() => void pageQueue?.flush(), 3000);
  }
  return pageQueue;
}
