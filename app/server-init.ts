import type { MiddlewareFunction } from "react-router";

import { ensureBootstrapLink } from "../src/bootstrap.ts";
import { initDb } from "../src/db.server.ts";
import { startSyncWorker } from "../src/sync-worker.ts";

/**
 * One-shot startup: open (and migrate) the database, print the first-run
 * setup link if no admin exists yet, and start sending time to the
 * accounting system if one is connected.
 *
 * There is no "server started" hook in a React Router app, so this runs from
 * the first middleware on the first request. The flag lives on globalThis
 * because Vite's SSR re-evaluates modules in development, so a module-level
 * boolean can exist several times over in one process.
 */
const KEY = "__timeTrackerInitialized__";
type GlobalWithFlag = typeof globalThis & { [KEY]?: boolean };

export function ensureServerInit(): void {
  const g = globalThis as GlobalWithFlag;
  if (g[KEY]) return;
  initDb();
  ensureBootstrapLink();
  startSyncWorker();
  g[KEY] = true;
}

export const initMiddleware: MiddlewareFunction<Response> = (_args, next) => {
  ensureServerInit();
  return next();
};
