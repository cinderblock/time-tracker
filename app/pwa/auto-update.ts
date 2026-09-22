/**
 * Keeping an installed copy of the app current.
 *
 * A service worker only earns its place if it also gets out of the way when
 * there is a newer one. Two things have to happen for that, and the browser
 * does neither on its own here:
 *
 *   noticing   The browser re-fetches /sw.js on a document navigation in
 *              scope, and this app has none: it is a single page, and an
 *              installed copy is resumed from the home screen rather than
 *              reloaded. So the asking is ours — on resume, on reconnect,
 *              and on a slow timer while the app is open.
 *
 *   applying   A new worker calls skipWaiting() and claims the page, but the
 *              page carries on running the modules it already loaded. Data
 *              still comes from the new server (/api/ and .data are never
 *              cached), so the screen looks alive while the code behind it is
 *              a release behind — which is exactly how this was found. The
 *              handover is the signal to reload.
 *
 * The reload is silent and immediate, so unsaved text in an open dialog is
 * lost if a deploy lands mid-edit. That is the deliberate trade for never
 * showing a stale app; tracked time itself reaches the IndexedDB outbox long
 * before any of this.
 */

/** How often to ask the server whether a newer worker exists, while open. */
export const CHECK_INTERVAL_MS = 20 * 60_000;
/** At most one check this often, however many triggers arrive together. */
export const CHECK_THROTTLE_MS = 60_000;
/** Two update reloads this close together mean a broken worker, not a deploy. */
export const RELOAD_LOOP_WINDOW_MS = 10_000;

const RELOAD_MARK = "tt-updated-at";

export type UpdaterDeps = {
  now: () => number;
  reload: () => void;
  /** When this tab last reloaded for an update, across the reload itself. */
  readMark: () => number | null;
  writeMark: (at: number) => void;
  warn: (message: string) => void;
};

export type Updater = ReturnType<typeof createUpdater>;

/**
 * The rules, away from the browser so they can be tested.
 *
 * Whether a change of controller means "a newer build took over" depends on
 * how the page stood when it loaded:
 *
 *   controlled by a worker            a new worker activated and claimed it
 *                                     -> reload
 *   uncontrolled, worker installed    a force reload bypasses the worker; only
 *                                     a newly activated one can claim the page
 *                                     -> reload
 *   uncontrolled, none installed      the first-ever install, built from the
 *                                     same release as the code already running
 *                                     -> don't reload
 *
 * After that first handover the page is controlled, so the next one reloads.
 */
export function createUpdater(deps: UpdaterDeps) {
  let controlled = false;
  let lastCheck: number | null = null;
  let settled = false;

  /**
   * Go and get the new build. Once, and not if a reload moments ago says the
   * worker rather than the release is what's wrong — a page that reloads in a
   * loop is worse than a page that is out of date.
   */
  function applyUpdate(): void {
    if (settled) return;
    const at = deps.now();
    const mark = deps.readMark();
    if (mark !== null && at - mark < RELOAD_LOOP_WINDOW_MS) {
      deps.warn("Service worker took over twice within seconds; not reloading again.");
      settled = true;
      return;
    }
    settled = true;
    deps.writeMark(at);
    deps.reload();
  }

  return {
    /** The page loaded under a worker, or with one already installed. */
    pageIsControlled(): void {
      controlled = true;
    },

    /** True when enough time has passed to ask again; records the attempt. */
    dueForCheck(): boolean {
      const at = deps.now();
      if (lastCheck !== null && at - lastCheck < CHECK_THROTTLE_MS) return false;
      lastCheck = at;
      return true;
    },

    /** A different worker now controls the page. */
    controllerChanged(): void {
      const first = !controlled;
      // However this turned out, the page is controlled from here on.
      controlled = true;
      if (first) return;
      applyUpdate();
    },

    /**
     * A worker is active that isn't the one controlling this page.
     *
     * Normally the two are the same worker, because this one claims the page
     * as it activates. They come apart if the handover happened in the gap
     * between the document loading and this code running — another tab can
     * trigger the update, and then there is no `controllerchange` left to
     * hear. Without this the page would sit on old code until it was closed,
     * which is the bug the whole file exists to fix, so it is worth a second
     * way of noticing.
     */
    strandedBehindActiveWorker(): void {
      applyUpdate();
    },
  };
}

/** sessionStorage is per-tab and survives the reload it guards. It can also
 *  be unavailable (some privacy modes throw on access), in which case the
 *  loop guard simply doesn't apply. */
function sessionMark(): Pick<UpdaterDeps, "readMark" | "writeMark"> {
  return {
    readMark: () => {
      try {
        const raw = window.sessionStorage.getItem(RELOAD_MARK);
        if (!raw) return null;
        const at = Number(raw);
        return Number.isFinite(at) ? at : null;
      } catch {
        return null;
      }
    },
    writeMark: (at) => {
      try {
        window.sessionStorage.setItem(RELOAD_MARK, String(at));
      } catch {
        // Without it a pathological worker could reload in a loop; with the
        // storage unavailable there is nothing better to do than go ahead.
      }
    },
  };
}

/** Register the worker and keep the page on the newest build. */
export function startAutoUpdate(): void {
  if (typeof window === "undefined") return;
  const workers = navigator.serviceWorker;
  if (!workers) return;

  const updater = createUpdater({
    now: () => Date.now(),
    reload: () => window.location.reload(),
    warn: (message) => console.warn(message),
    ...sessionMark(),
  });

  // Both of these before registering rather than after it resolves, so a
  // handover during the registration itself is still heard. One from before
  // this code ran is not, which is what strandedBehind() below is for.
  if (workers.controller) updater.pageIsControlled();
  workers.addEventListener("controllerchange", () => updater.controllerChanged());

  workers
    .register("/sw.js", { updateViaCache: "none" })
    .then((registration) => {
      // A worker was already installed when this page loaded, even if it isn't
      // controlling it — which is how a page comes back from a force reload.
      if (registration.active) updater.pageIsControlled();

      /** Is the active worker someone other than the one controlling us? */
      const strandedBehind = () => {
        const controller = workers.controller;
        if (!controller || !registration.active || registration.active === controller) return false;
        updater.strandedBehindActiveWorker();
        return true;
      };

      const check = () => {
        // No point asking for a newer worker when a newer one is already here.
        if (strandedBehind()) return;
        if (!updater.dueForCheck()) return;
        registration.update().catch(() => {
          // Offline, or the server is down. The next trigger tries again.
        });
      };

      // register() has just asked the server itself, so that is this window's
      // check. What it can't tell us is whether the handover happened before
      // any of this code was running — so look for that now.
      updater.dueForCheck();
      strandedBehind();

      // A phone waking up fires several of these at once; the throttle is what
      // makes that one request.
      window.setInterval(check, CHECK_INTERVAL_MS);
      window.addEventListener("online", check);
      window.addEventListener("pageshow", check);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
    })
    .catch((err: unknown) => {
      console.warn("Service worker registration failed", err);
    });
}
