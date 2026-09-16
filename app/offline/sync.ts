import type { Op, OpResult } from "../../src/ops-schema.ts";
import type { OutboxStore, QueuedOp } from "./storage.ts";

/**
 * The outbox: ops are stored on the device first, shown immediately, and sent
 * to the server in order whenever it can be reached.
 *
 *  - Nothing is lost while offline or while the server is down; the queue
 *    lives in IndexedDB and survives reloads and app restarts.
 *  - Sending is safe to repeat: the server's ledger applies each op once, so a
 *    batch interrupted mid-flight is simply sent again.
 *  - An op the server *rejects* is dropped from the queue and reported, rather
 *    than retried forever and blocking everything behind it.
 *  - Only the signed-in person's ops are ever sent.
 *
 * Every dependency (storage, network, clock, timers, cross-tab plumbing) is
 * injected, so the engine is tested without a browser.
 */

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

export class SignedOutError extends Error {
  constructor() {
    super("Signed out");
    this.name = "SignedOutError";
  }
}

export interface SyncDeps {
  store: OutboxStore;
  /** POST the ops; resolve one result per op, in order. Throw TransportError / SignedOutError. */
  send(ops: Op[]): Promise<OpResult[]>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Run `fn` holding a cross-tab lock; resolve false without running if another tab holds it. */
  withLock?(fn: () => Promise<void>): Promise<boolean>;
  /** Tell other tabs something changed. */
  broadcast?(message: SyncMessage): void;
}

export type SyncMessage = { type: "results"; userId: number; results: OpResult[] } | { type: "queued"; userId: number };

export interface SyncStatus {
  /** Ops waiting to be confirmed by the server. */
  pending: number;
  syncing: boolean;
  /** The last attempt couldn't reach the server. */
  offline: boolean;
  /** The server says nobody is signed in; syncing is paused until someone is. */
  signedOut: boolean;
  lastSyncedAt: number | null;
}

export interface Rejection {
  op: Op;
  result: Extract<OpResult, { ok: false }>;
  /** True when a caller was waiting for this result and has already shown it. */
  handled: boolean;
}

type Listener = () => void;

/** Backoff between retries after the server couldn't be reached. */
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
export const BATCH_SIZE = 100;

export class SyncEngine {
  private userId: number | null = null;
  private queued: QueuedOp[] = [];
  /** Confirmed ops whose effect the current server copy may not show yet. */
  private confirmed: { op: Op; at: number }[] = [];
  private flushing: Promise<void> | null = null;
  /** One follow-up send, shared by every request made while a send is running. */
  private followUp: Promise<void> | null = null;
  private status: SyncStatus = { pending: 0, syncing: false, offline: false, signedOut: false, lastSyncedAt: null };
  private retryIndex = 0;
  private retryHandle: unknown = null;
  private waiters = new Map<string, (r: OpResult | null) => void>();
  private listeners = new Set<Listener>();
  private rejectionListeners = new Set<(r: Rejection) => void>();
  private syncedListeners = new Set<() => void>();
  private opsCache: Op[] = [];

  constructor(private readonly deps: SyncDeps) {}

  // ---- lifecycle ------------------------------------------------------------------

  /** Begin syncing for a person. Safe to call again (e.g. after signing back in). */
  async start(userId: number): Promise<void> {
    if (this.userId !== userId) {
      this.userId = userId;
      this.confirmed = [];
      this.status = { ...this.status, signedOut: false };
    } else if (this.status.signedOut) {
      this.status = { ...this.status, signedOut: false };
    }
    await this.reload();
    void this.flush();
  }

  /** Stop syncing (signed out). The queue stays on the device. */
  stop(): void {
    this.userId = null;
    this.queued = [];
    this.confirmed = [];
    this.cancelRetry();
    this.update({ pending: 0, syncing: false });
  }

  // ---- reading --------------------------------------------------------------------

  getStatus(): SyncStatus {
    return this.status;
  }

  /** Ops to apply on top of the server copy: confirmed-but-maybe-unreflected, then queued. */
  getOps(): Op[] {
    return this.opsCache;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onRejected(listener: (r: Rejection) => void): () => void {
    this.rejectionListeners.add(listener);
    return () => this.rejectionListeners.delete(listener);
  }

  /** Called after ops are confirmed, so the screen can fetch a fresh copy. */
  onSynced(listener: () => void): () => void {
    this.syncedListeners.add(listener);
    return () => this.syncedListeners.delete(listener);
  }

  /**
   * A fresh server copy has arrived; its request started at `fetchedAt`
   * (browser clock). Confirmed ops from before then are in it — stop applying
   * them locally.
   */
  reflect(fetchedAt: number | undefined): void {
    if (!fetchedAt) return;
    const before = this.confirmed.length;
    this.confirmed = this.confirmed.filter((c) => c.at >= fetchedAt);
    if (this.confirmed.length !== before) this.recompute();
  }

  // ---- writing --------------------------------------------------------------------

  /**
   * Store an op and start sending it. With `waitMs`, resolves to the server's
   * answer if it arrives in time, or null meaning "still queued" (offline,
   * slow, or being sent by another tab). The wait is registered before
   * sending begins, so a fast answer can't slip past it.
   */
  async enqueue(op: Op, waitMs = 0): Promise<OpResult | null> {
    if (this.userId == null) throw new Error("Not signed in");
    const item = await this.deps.store.add({
      userId: this.userId,
      op,
      queuedAt: this.deps.now(),
      attempts: 0,
      lastError: null,
    });
    this.queued.push(item);
    this.recompute();
    this.deps.broadcast?.({ type: "queued", userId: this.userId });
    const answer = waitMs > 0 ? this.waitFor(op.opId, waitMs) : Promise.resolve(null);
    void this.flush();
    return answer;
  }

  private waitFor(opId: string, timeoutMs: number): Promise<OpResult | null> {
    return new Promise((resolve) => {
      const handle = this.deps.setTimer(() => {
        this.waiters.delete(opId);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(opId, (r) => {
        this.deps.clearTimer(handle);
        this.waiters.delete(opId);
        resolve(r);
      });
    });
  }

  /**
   * Try to send everything now. Resolves once a send that *started after this
   * call* has finished — a request made mid-send waits for the follow-up
   * rather than for the send already under way, which may predate the ops
   * (or the person) the caller cares about.
   */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.runFlush().finally(() => {
        this.flushing = null;
      });
      return this.flushing;
    }
    this.followUp ??= this.flushing.then(() => {
      this.followUp = null;
      return this.flush();
    });
    return this.followUp;
  }

  /** Resolves once no send is running or scheduled to follow. */
  async idle(): Promise<void> {
    while (this.flushing || this.followUp) await (this.followUp ?? this.flushing);
  }

  /** Another tab reported something; bring this tab in line. */
  async receive(message: SyncMessage): Promise<void> {
    if (message.userId !== this.userId) return;
    if (message.type === "results") this.settle(message.results, false);
    await this.reload();
  }

  // ---- internals --------------------------------------------------------------------

  private async runFlush(): Promise<void> {
    const userId = this.userId;
    if (userId == null || this.status.signedOut) return;
    this.cancelRetry();
    this.update({ syncing: true });
    try {
      const work = () => this.sendAll(userId);
      if (this.deps.withLock) {
        const ran = await this.deps.withLock(work);
        // Another tab is sending; it will broadcast the results.
        if (!ran) this.releaseWaiters();
      } else {
        await work();
      }
    } finally {
      this.update({ syncing: false });
    }
  }

  private async sendAll(userId: number): Promise<void> {
    for (;;) {
      if (this.userId !== userId) return;
      // Re-read storage each round: another tab may have added or sent ops.
      await this.reload();
      if (this.userId !== userId) return;
      // The session belongs to `userId`; never let anyone else's op into the
      // batch, whatever the queue holds.
      const batch = this.queued.filter((q) => q.userId === userId).slice(0, BATCH_SIZE);
      if (batch.length === 0) {
        this.update({ offline: false });
        return;
      }

      let results: OpResult[];
      try {
        results = await this.deps.send(batch.map((q) => q.op));
      } catch (err) {
        await this.failed(batch, err);
        return;
      }

      this.retryIndex = 0;
      this.update({ offline: false, lastSyncedAt: this.deps.now() });
      await this.deps.store.remove(batch.map((q) => q.seq));
      const settled = this.settle(results, true);
      this.deps.broadcast?.({ type: "results", userId, results });
      if (settled) for (const l of this.syncedListeners) l();
    }
  }

  /** Apply results (from this tab or another). Returns whether anything was confirmed. */
  private settle(results: OpResult[], local: boolean): boolean {
    const byId = new Map(results.map((r) => [r.opId, r]));
    const now = this.deps.now();
    let confirmedAny = false;
    const remaining: QueuedOp[] = [];
    for (const q of this.queued) {
      const r = byId.get(q.op.opId);
      if (!r) {
        remaining.push(q);
        continue;
      }
      const waiter = this.waiters.get(q.op.opId);
      waiter?.(r);
      if (r.ok) {
        this.confirmed.push({ op: q.op, at: now });
        confirmedAny = true;
      } else if (local) {
        // Only the tab that sent the op reports it, so one rejection is one message.
        for (const l of this.rejectionListeners) l({ op: q.op, result: r, handled: Boolean(waiter) });
      }
    }
    // Results can also arrive for ops this tab never loaded; waiters still resolve.
    for (const r of results) this.waiters.get(r.opId)?.(r);
    this.queued = remaining;
    this.recompute();
    return confirmedAny;
  }

  private async failed(batch: QueuedOp[], err: unknown): Promise<void> {
    if (err instanceof SignedOutError) {
      this.update({ signedOut: true });
      this.releaseWaiters();
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    for (const q of batch) {
      q.attempts += 1;
      q.lastError = message;
      await this.deps.store.update(q);
    }
    this.update({ offline: true });
    this.releaseWaiters();
    const delay = RETRY_DELAYS_MS[Math.min(this.retryIndex, RETRY_DELAYS_MS.length - 1)]!;
    this.retryIndex += 1;
    this.retryHandle = this.deps.setTimer(() => {
      this.retryHandle = null;
      void this.flush();
    }, delay);
  }

  /** Anyone waiting for a result won't get one soon: tell them it's queued. */
  private releaseWaiters(): void {
    for (const resolve of [...this.waiters.values()]) resolve(null);
  }

  private cancelRetry(): void {
    if (this.retryHandle != null) {
      this.deps.clearTimer(this.retryHandle);
      this.retryHandle = null;
    }
  }

  private async reload(): Promise<void> {
    const userId = this.userId;
    if (userId == null) return;
    const items = await this.deps.store.list(userId);
    // Someone else signed in while this read was waiting: their reload wins.
    // Storing this result would put one person's ops in another's queue.
    if (this.userId !== userId) return;
    this.queued = items;
    this.recompute();
  }

  private recompute(): void {
    const confirmedIds = new Set(this.confirmed.map((c) => c.op.opId));
    this.opsCache = [...this.confirmed.map((c) => c.op), ...this.queued.map((q) => q.op).filter((o) => !confirmedIds.has(o.opId))];
    this.update({ pending: this.queued.length });
  }

  private update(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l();
  }
}

/** An OutboxStore in memory, for tests and for browsers without IndexedDB. */
export function memoryOutbox(): OutboxStore & { items: QueuedOp[] } {
  let seq = 0;
  const items: QueuedOp[] = [];
  return {
    items,
    async list(userId) {
      return items.filter((i) => i.userId === userId).map((i) => ({ ...i }));
    },
    async add(item) {
      const stored = { ...item, seq: ++seq };
      items.push(stored);
      return { ...stored };
    },
    async update(item) {
      const i = items.findIndex((x) => x.seq === item.seq);
      if (i >= 0) items[i] = { ...item };
    },
    async remove(seqs) {
      for (const s of seqs) {
        const i = items.findIndex((x) => x.seq === s);
        if (i >= 0) items.splice(i, 1);
      }
    },
  };
}
