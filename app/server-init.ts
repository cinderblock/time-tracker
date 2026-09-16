import { initDb } from "../src/db.ts";

/**
 * One-shot startup: open the database (and run migrations) before the first
 * request is served.
 *
 * The flag lives on globalThis rather than in module scope because Vite's SSR
 * re-evaluates modules and HMR reloads them, so a plain module-level boolean
 * can exist several times over in one process.
 */
const KEY = "__timeTrackerInitialized__";
type GlobalWithFlag = typeof globalThis & { [KEY]?: boolean };

export function ensureServerInit(): void {
  const g = globalThis as GlobalWithFlag;
  if (g[KEY]) return;
  g[KEY] = true;
  initDb();
}
