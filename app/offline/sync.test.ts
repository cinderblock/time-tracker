import { describe, expect, test } from "bun:test";

import type { Op, OpResult } from "../../src/ops-schema.ts";
import { uuidv7 } from "../../src/uuid.ts";
import {
  RETRY_DELAYS_MS,
  type Rejection,
  SignedOutError,
  SyncEngine,
  type SyncMessage,
  TransportError,
  memoryOutbox,
} from "./sync.ts";

/** A controllable world for the engine: fake clock, timers, network and tabs. */
function world() {
  const store = memoryOutbox();
  let now = 1_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 0;
  const sent: Op[][] = [];
  let network: "up" | "down" | "signed-out" = "up";
  let reject = new Set<string>();
  const messages: SyncMessage[] = [];
  let lockHeld = false;

  const engine = new SyncEngine({
    store,
    now: () => now,
    setTimer(fn, ms) {
      const id = ++nextTimer;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id as number);
    },
    async send(ops) {
      if (network === "down") throw new TransportError("unreachable");
      if (network === "signed-out") throw new SignedOutError();
      sent.push(ops);
      return ops.map((op): OpResult =>
        reject.has(op.opId) ? { opId: op.opId, ok: false, code: "conflict", error: "nope" } : { opId: op.opId, ok: true },
      );
    },
    async withLock(fn) {
      if (lockHeld) return false;
      await fn();
      return true;
    },
    broadcast: (m) => messages.push(m),
  });

  const rejections: Rejection[] = [];
  engine.onRejected((r) => rejections.push(r));
  let synced = 0;
  engine.onSynced(() => synced++);

  return {
    engine,
    store,
    sent,
    messages,
    rejections,
    get synced() {
      return synced;
    },
    setNetwork: (n: typeof network) => {
      network = n;
    },
    rejectOps: (ids: string[]) => {
      reject = new Set(ids);
    },
    holdLock: (held: boolean) => {
      lockHeld = held;
    },
    /** Advance the clock, firing due timers. */
    async tick(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
      await settle();
    },
    pendingTimers: () => timers.size,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

const op = (type: Op["type"] = "note.delete"): Op =>
  ({ opId: uuidv7(), type, deviceId: "d", clientTime: 0, payload: { noteId: uuidv7(), at: 1 } }) as Op;

describe("SyncEngine", () => {
  test("sends queued ops in order and reports the server's answer", async () => {
    const w = world();
    await w.engine.start(7);
    const [a, b] = [op(), op()];
    const ra = await w.engine.enqueue(a, 1000);
    const rb = await w.engine.enqueue(b, 1000);
    expect(ra).toEqual({ opId: a.opId, ok: true });
    expect(rb).toEqual({ opId: b.opId, ok: true });
    expect(w.sent.flat().map((o) => o.opId)).toEqual([a.opId, b.opId]);
    expect(w.store.items).toHaveLength(0);
    // The answer arrives mid-flush (and the second enqueue queued another
    // flush); wait for all of it before checking status.
    await w.engine.idle();
    expect(w.engine.getStatus()).toMatchObject({ pending: 0, offline: false, syncing: false });
    expect(w.synced).toBeGreaterThan(0);
  });

  test("offline: ops stay queued, are shown, and go out when the server returns", async () => {
    const w = world();
    await w.engine.start(7);
    w.setNetwork("down");
    const a = op();
    expect(await w.engine.enqueue(a, 5000)).toBeNull(); // answered at once, not after the timeout
    await settle();
    expect(w.engine.getStatus()).toMatchObject({ pending: 1, offline: true });
    expect(w.engine.getOps().map((o) => o.opId)).toEqual([a.opId]);
    expect(w.store.items[0]).toMatchObject({ attempts: 1, lastError: "unreachable" });

    // Still down at the first retry: backs off further.
    await w.tick(RETRY_DELAYS_MS[0]!);
    expect(w.store.items[0]!.attempts).toBe(2);

    w.setNetwork("up");
    await w.tick(RETRY_DELAYS_MS[1]!);
    expect(w.sent.flat().map((o) => o.opId)).toEqual([a.opId]);
    expect(w.engine.getStatus()).toMatchObject({ pending: 0, offline: false });
    // Still applied locally until a fresh server copy reflects it.
    expect(w.engine.getOps().map((o) => o.opId)).toEqual([a.opId]);
  });

  test("the queue survives a reload", async () => {
    const w = world();
    await w.engine.start(7);
    w.setNetwork("down");
    const a = op();
    await w.engine.enqueue(a);
    await settle();

    // A new page: same storage, new engine.
    const store = w.store;
    const sent: Op[][] = [];
    const again = new SyncEngine({
      store,
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      async send(ops) {
        sent.push(ops);
        return ops.map((o) => ({ opId: o.opId, ok: true as const }));
      },
    });
    await again.start(7);
    await again.flush();
    expect(sent.flat().map((o) => o.opId)).toEqual([a.opId]);
    expect(store.items).toHaveLength(0);
  });

  test("a rejected op is dropped and reported, and doesn't block the rest", async () => {
    const w = world();
    await w.engine.start(7);
    const [bad, good] = [op(), op()];
    w.rejectOps([bad.opId]);
    w.setNetwork("down");
    await w.engine.enqueue(bad);
    await w.engine.enqueue(good);
    await settle();
    w.setNetwork("up");
    await w.engine.flush();

    expect(w.store.items).toHaveLength(0);
    expect(w.rejections).toHaveLength(1);
    expect(w.rejections[0]).toMatchObject({ op: { opId: bad.opId }, handled: false, result: { error: "nope" } });
    expect(w.engine.getOps().map((o) => o.opId)).toEqual([good.opId]);
  });

  test("a rejection someone was waiting for is marked handled", async () => {
    const w = world();
    await w.engine.start(7);
    const bad = op();
    w.rejectOps([bad.opId]);
    const result = await w.engine.enqueue(bad, 1000);
    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(w.rejections[0]!.handled).toBe(true);
  });

  test("confirmed ops stop being applied once a fresh copy reflects them", async () => {
    const w = world();
    await w.engine.start(7);
    const a = op();
    await w.engine.enqueue(a, 1000);
    expect(w.engine.getOps()).toHaveLength(1);
    w.engine.reflect(500); // a copy fetched before the op was confirmed
    expect(w.engine.getOps()).toHaveLength(1);
    await w.tick(10);
    w.engine.reflect(1_010); // fetched after
    expect(w.engine.getOps()).toHaveLength(0);
  });

  test("signed out: sending pauses and the queue is kept", async () => {
    const w = world();
    await w.engine.start(7);
    w.setNetwork("signed-out");
    const a = op();
    expect(await w.engine.enqueue(a, 1000)).toBeNull();
    expect(w.engine.getStatus()).toMatchObject({ signedOut: true, pending: 1 });
    expect(w.pendingTimers()).toBe(0); // no retry loop against a signed-out server

    w.setNetwork("up");
    await w.engine.start(7); // signed back in
    await settle();
    expect(w.engine.getStatus()).toMatchObject({ signedOut: false, pending: 0 });
  });

  test("never sends one person's queue while another is signed in", async () => {
    const w = world();
    await w.engine.start(7);
    w.setNetwork("down");
    await w.engine.enqueue(op());
    await settle();
    w.engine.stop();

    w.setNetwork("up");
    await w.engine.start(8);
    await w.engine.flush();
    expect(w.sent).toHaveLength(0);
    expect(w.engine.getStatus().pending).toBe(0);
    expect(w.store.items).toHaveLength(1); // still waiting for person 7

    await w.engine.start(7);
    await w.engine.flush();
    expect(w.sent.flat()).toHaveLength(1);
  });

  test("when another tab holds the send lock, waiting callers hear 'queued' at once", async () => {
    const w = world();
    await w.engine.start(7);
    w.holdLock(true);
    const a = op();
    expect(await w.engine.enqueue(a, 60_000)).toBeNull();
    expect(w.sent).toHaveLength(0);
    expect(w.engine.getStatus().pending).toBe(1);
  });

  test("results broadcast by another tab settle this tab's queue", async () => {
    const w = world();
    await w.engine.start(7);
    w.holdLock(true);
    const a = op();
    await w.engine.enqueue(a);
    await settle();
    // The other tab sent it and removed it from shared storage.
    await w.store.remove(w.store.items.map((i) => i.seq));
    await w.engine.receive({ type: "results", userId: 7, results: [{ opId: a.opId, ok: true }] });
    expect(w.engine.getStatus().pending).toBe(0);
    expect(w.engine.getOps().map((o) => o.opId)).toEqual([a.opId]); // confirmed, awaiting reflection
    expect(w.rejections).toHaveLength(0);
  });

  test("large queues go out in batches, in order", async () => {
    const w = world();
    await w.engine.start(7);
    w.setNetwork("down");
    const ops = Array.from({ length: 250 }, () => op());
    for (const o of ops) await w.engine.enqueue(o);
    await settle();
    w.setNetwork("up");
    await w.engine.flush();
    expect(w.sent.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(w.sent.flat().map((o) => o.opId)).toEqual(ops.map((o) => o.opId));
  });

  test("a send requested while another is finishing waits for its own send", async () => {
    // Person 8's send is under way (held inside storage) when person 7 signs
    // in and asks for a send. That request must not resolve with person 8's
    // send — which will return without sending anything of person 7's.
    const inner = memoryOutbox();
    let gate: Promise<void> | null = null;
    const store = { ...inner, list: async (userId: number) => (gate && (await gate), inner.list(userId)) };
    const sent: Op[][] = [];
    const engine = new SyncEngine({
      store,
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      async send(ops) {
        sent.push(ops);
        return ops.map((o) => ({ opId: o.opId, ok: true as const }));
      },
    });
    await engine.start(8);
    await engine.idle();

    const waiting = op();
    await inner.add({ userId: 7, op: waiting, queuedAt: 0, attempts: 0, lastError: null });
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    void engine.flush(); // person 8's send, now held
    void engine.start(7);
    const requested = engine.flush();
    open();
    await requested;
    expect(sent.flat().map((o) => o.opId)).toEqual([waiting.opId]);
  });

  test("a send under way when someone else signs in never sends the first person's ops", async () => {
    // Person 8's send has started and is reading the queue (held). Person 7
    // signs in on the same page, so the session is now 7's. When 8's read
    // finally returns, 8's op must not go out: the server would book it to 7.
    const inner = memoryOutbox();
    let hold8: Promise<void> | null = null;
    const store = {
      ...inner,
      list: async (userId: number) => {
        if (userId === 8 && hold8) await hold8;
        return inner.list(userId);
      },
    };
    let session = 8;
    const owner = new Map<string, number>();
    const violations: string[] = [];
    const engine = new SyncEngine({
      store,
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      async send(ops) {
        for (const o of ops) if (owner.get(o.opId) !== session) violations.push(o.opId);
        return ops.map((o) => ({ opId: o.opId, ok: true as const }));
      },
    });
    await engine.start(8);
    await engine.idle();

    const eights = op();
    const sevens = op();
    owner.set(eights.opId, 8).set(sevens.opId, 7);
    await inner.add({ userId: 8, op: eights, queuedAt: 0, attempts: 0, lastError: null });
    await inner.add({ userId: 7, op: sevens, queuedAt: 0, attempts: 0, lastError: null });

    let release!: () => void;
    hold8 = new Promise((r) => (release = r));
    void engine.flush(); // person 8's send: now waiting on its read
    session = 7; // person 7 signs in
    await engine.start(7);
    release(); // person 8's read returns, late
    await engine.idle();

    expect(violations).toEqual([]);
    // Person 7's op went out; person 8's is still waiting for person 8.
    expect(inner.items.map((i) => i.userId)).toEqual([8]);
  });

  test("broadcasts what it queued and what the server said", async () => {
    const w = world();
    await w.engine.start(7);
    const a = op();
    await w.engine.enqueue(a, 1000);
    expect(w.messages.map((m) => m.type)).toEqual(["queued", "results"]);
  });
});
