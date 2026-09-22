import { describe, expect, test } from "bun:test";

import { CHECK_THROTTLE_MS, RELOAD_LOOP_WINDOW_MS, type Updater, createUpdater } from "./auto-update.ts";

/** A controllable world for the updater: fake clock, fake tab storage. */
function world(startAt = 1_000) {
  let now = startAt;
  let mark: number | null = null;
  const reloads: number[] = [];
  const warnings: string[] = [];

  const updater = createUpdater({
    now: () => now,
    reload: () => reloads.push(now),
    readMark: () => mark,
    writeMark: (at) => {
      mark = at;
    },
    warn: (message) => warnings.push(message),
  });

  return {
    updater,
    reloads,
    warnings,
    advance: (ms: number) => {
      now += ms;
    },
    /** A reload really does end the document, so the next one starts fresh —
     *  carrying only what sessionStorage kept. */
    afterReload: (): Updater =>
      createUpdater({
        now: () => now,
        reload: () => reloads.push(now),
        readMark: () => mark,
        writeMark: (at) => {
          mark = at;
        },
        warn: (message) => warnings.push(message),
      }),
  };
}

describe("when a handover means a newer build", () => {
  test("a controlled page reloads when another worker takes over", () => {
    const { updater, reloads } = world();
    updater.pageIsControlled();

    updater.controllerChanged();

    expect(reloads).toHaveLength(1);
  });

  test("the first-ever install does not reload: this page is already that build", () => {
    const { updater, reloads } = world();

    updater.controllerChanged();

    expect(reloads).toEqual([]);
  });

  test("but the install after that one does", () => {
    const { updater, reloads, advance } = world();
    updater.controllerChanged(); // first install, no reload
    advance(60 * 60_000);

    updater.controllerChanged(); // a deploy landed

    expect(reloads).toHaveLength(1);
  });

  test("a force-reloaded page is uncontrolled, but a worker was installed, so it reloads", () => {
    const { updater, reloads } = world();
    // navigator.serviceWorker.controller is null after a force reload; the
    // registration still resolves with an active worker.
    updater.pageIsControlled();

    updater.controllerChanged();

    expect(reloads).toHaveLength(1);
  });

  test("only one reload, however many times control changes hands", () => {
    const { updater, reloads } = world();
    updater.pageIsControlled();

    updater.controllerChanged();
    updater.controllerChanged();
    updater.controllerChanged();

    expect(reloads).toHaveLength(1);
  });
});

describe("a handover that was never heard", () => {
  test("finding a stranger active reloads, controlled or not", () => {
    const { updater, reloads } = world();

    // No pageIsControlled() and no controllerchange: the takeover happened in
    // the gap before this code ran, so all the page has is the mismatch.
    updater.strandedBehindActiveWorker();

    expect(reloads).toHaveLength(1);
  });

  test("it shares the one-reload decision with the handover path", () => {
    const { updater, reloads } = world();
    updater.pageIsControlled();

    updater.controllerChanged();
    updater.strandedBehindActiveWorker();

    expect(reloads).toHaveLength(1);
  });
});

describe("the reload-loop guard", () => {
  test("a second update reload within the window is refused and reported", () => {
    const w = world();
    w.updater.pageIsControlled();
    w.updater.controllerChanged();
    expect(w.reloads).toHaveLength(1);

    w.advance(RELOAD_LOOP_WINDOW_MS - 1);
    const next = w.afterReload();
    next.pageIsControlled();
    next.controllerChanged();

    expect(w.reloads).toHaveLength(1);
    expect(w.warnings).toHaveLength(1);
  });

  test("a genuine second deploy, later, still reloads", () => {
    const w = world();
    w.updater.pageIsControlled();
    w.updater.controllerChanged();

    w.advance(RELOAD_LOOP_WINDOW_MS + 1);
    const next = w.afterReload();
    next.pageIsControlled();
    next.controllerChanged();

    expect(w.reloads).toHaveLength(2);
    expect(w.warnings).toEqual([]);
  });
});

describe("throttling the update checks", () => {
  test("the first check goes ahead", () => {
    const { updater } = world();

    expect(updater.dueForCheck()).toBe(true);
  });

  test("triggers arriving together make one request", () => {
    const { updater } = world();
    updater.dueForCheck();

    // online, pageshow and visibilitychange all fire as a phone wakes up.
    expect(updater.dueForCheck()).toBe(false);
    expect(updater.dueForCheck()).toBe(false);
  });

  test("the next one after the window goes ahead", () => {
    const { updater, advance } = world();
    updater.dueForCheck();

    advance(CHECK_THROTTLE_MS);

    expect(updater.dueForCheck()).toBe(true);
  });
});
