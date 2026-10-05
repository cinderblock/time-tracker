import { describe, expect, test } from "bun:test";

import { ProblemQueue, type QueuedProblem, type SendOutcome, memoryProblemStore } from "./queue.ts";

/** A queue whose server answers from a script, one answer per send. */
function setup(answers: SendOutcome[] = [], user: number | null = 1) {
  const store = memoryProblemStore();
  const sent: QueuedProblem[] = [];
  let signedIn = user;
  const queue = new ProblemQueue({
    store,
    send: async (item) => {
      const outcome = answers.shift() ?? "sent";
      if (outcome === "sent") sent.push(item);
      return { outcome, error: outcome === "refused" ? "Bad report" : undefined, answer: { ok: item.key } };
    },
    currentUser: () => signedIn,
    now: () => 1000,
  });
  return { queue, store, sent, signIn: (id: number | null) => (signedIn = id) };
}

const report = (key: string, userId = 1) => ({ key, kind: "report" as const, userId, body: { key } });

describe("the problem queue", () => {
  test("sent at once when the server answers, with its answer", async () => {
    const { queue, sent } = setup();
    expect(await queue.add(report("a"))).toEqual({ status: "sent", answer: { ok: "a" } });
    expect(sent.map((s) => s.key)).toEqual(["a"]);
    expect(await queue.pending()).toEqual([]);
  });

  test("offline: kept, and sent on the next flush in the order made", async () => {
    const { queue, sent } = setup(["retry"]);
    expect(await queue.add(report("a"))).toEqual({ status: "queued" });
    expect((await queue.pending())[0]).toMatchObject({ key: "a", attempts: 1, lastError: "retry" });
    await queue.add(report("b"));
    expect(sent.map((s) => s.key)).toEqual(["a", "b"]);
  });

  test("refused: dropped, and the reason handed back", async () => {
    const { queue } = setup(["refused"]);
    expect(await queue.add(report("a"))).toEqual({ status: "refused", error: "Bad report" });
    expect(await queue.pending()).toEqual([]);
  });

  test("a report waits for the person who made it", async () => {
    const { queue, sent, signIn } = setup([], 2);
    expect(await queue.add(report("a", 1))).toEqual({ status: "queued" });
    expect(sent).toEqual([]);
    signIn(1);
    await queue.flush();
    expect(sent.map((s) => s.key)).toEqual(["a"]);
  });

  test("errors are given up on after ten failed sends; reports never are", async () => {
    const { queue } = setup(Array.from({ length: 30 }, () => "retry" as const));
    await queue.add({ key: "e", kind: "errors", userId: null, body: {} });
    await queue.add(report("r"));
    for (let i = 0; i < 12; i++) await queue.flush();
    expect((await queue.pending()).map((p) => p.key)).toEqual(["r"]);
  });
});
