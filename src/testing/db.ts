import { closeDb, initDb } from "../db.server.ts";

/**
 * Give each test its own empty, fully migrated in-memory database. Use as
 * `beforeEach(freshDb)`; the previous one is closed first.
 */
export function freshDb(): void {
  closeDb();
  initDb(":memory:");
}
