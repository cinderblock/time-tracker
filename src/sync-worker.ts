import { type AccountingBackend, BackendUnreachableError, accountingBackendOrError } from "./accounting/index.ts";
import { config } from "./config.server.ts";
import { beginWork, finishWork, listWork, recordContact, workUnreachable } from "./sync.ts";

/**
 * The loop that sends work to a push backend (the QB Bridge): every
 * ACCOUNTING_SYNC_EVERY_SECONDS (a minute by default), and whenever an admin
 * asks, it works through `listWork` until there's nothing left or the
 * accounting system stops answering.
 *
 * A poll backend (the Web Connector) needs no loop — it asks for work itself.
 */

/** Requests per run, so one run can't go on forever. */
const MAX_PER_RUN = 200;

export interface RunSummary {
  /** Whether the accounting system answered (or there was nothing to send). */
  reached: boolean;
  done: number;
  detail: string;
}

let running: Promise<RunSummary> | null = null;

/** Send what can be sent now. Concurrent calls share one run. */
export function runSync(backend?: AccountingBackend, clock: () => number = Date.now): Promise<RunSummary> {
  if (!running) {
    running = run(backend, clock).finally(() => {
      running = null;
    });
  }
  return running;
}

async function run(given: AccountingBackend | undefined, clock: () => number): Promise<RunSummary> {
  const resolved = given ? { backend: given, error: null } : accountingBackendOrError();
  if (!resolved.backend) return { reached: false, done: 0, detail: resolved.error };
  const backend = resolved.backend;
  if (backend.delivery !== "push") {
    return {
      reached: false,
      done: 0,
      detail: backend.delivery === "poll" ? "The Web Connector collects work when it connects." : "Nothing is sent.",
    };
  }

  let done = 0;
  for (; done < MAX_PER_RUN; done++) {
    const work = listWork(clock())[0];
    if (!work) break;
    beginWork(work, clock());
    try {
      const performed = await backend.perform(work.request);
      finishWork(backend.kind, work, performed, clock());
    } catch (err) {
      if (!(err instanceof BackendUnreachableError)) throw err;
      workUnreachable(backend.kind, work, err.message, clock());
      recordContact(false, err.message, clock());
      return { reached: false, done, detail: err.message };
    }
  }
  const detail = done ? `Sent ${done} request${done === 1 ? "" : "s"}.` : "Nothing to send.";
  if (done) recordContact(true, detail, clock());
  return { reached: true, done, detail };
}

const TIMER_KEY = "__timeTrackerSyncTimer__";
type GlobalWithTimer = typeof globalThis & { [TIMER_KEY]?: ReturnType<typeof setInterval> };

/** Start the loop, once per process, for push backends only. */
export function startSyncWorker(): void {
  const g = globalThis as GlobalWithTimer;
  if (g[TIMER_KEY]) return;
  const { backend } = accountingBackendOrError();
  if (backend?.delivery !== "push") return;
  const every = config.accounting.syncEverySeconds * 1000;
  if (every === 0) {
    console.log(`[sync] ${backend.kind}: automatic sending is off; admins send from the Accounting page`);
    return;
  }
  const tick = () => {
    runSync().catch((err) => console.error("[sync] run failed:", err));
  };
  g[TIMER_KEY] = setInterval(tick, every);
  g[TIMER_KEY].unref?.();
  setTimeout(tick, 5_000).unref?.();
  console.log(`[sync] sending to ${backend.kind} every ${every / 1000}s`);
}
