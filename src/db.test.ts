import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, initDb } from "./db.server.ts";

/**
 * The migration runner's own guarantees. These use a real file, not
 * `:memory:`, because the point is what survives closing and reopening.
 */

let dir: string | null = null;

// initDb hands back the connection already on globalThis, so a database another
// test file left open would be used instead of this test's file.
beforeEach(closeDb);

function freshFile(): string {
  dir = mkdtempSync(join(tmpdir(), "tt-db-"));
  return join(dir, "test.db");
}

afterEach(() => {
  closeDb();
  // Windows won't delete a file another handle still holds; every connection
  // below is closed, so this only guards against a failed test leaving one.
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a leaked handle in a failing test — the temp dir can wait for the OS
    }
  }
  dir = null;
});

/** Read the migrations table through its own short-lived connection. */
function migrationRows(path: string): { name: string; fingerprint: string | null }[] {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.query<{ name: string; fingerprint: string | null }, []>("SELECT name, fingerprint FROM migrations").all();
  } finally {
    raw.close();
  }
}

/** Reopen through initDb, which is where migrations run. */
function reopen(path: string): void {
  closeDb();
  initDb(path, () => {});
}

describe("migrations", () => {
  test("records what it applied, and reopening is a no-op", () => {
    const path = freshFile();
    initDb(path, () => {});
    const first = migrationRows(path);
    expect(first.map((r) => r.name)).toEqual(["001_initial", "002_tracking_mode", "003_note_kind", "004_submission", "005_takes_time"]);
    expect(first[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);

    reopen(path);
    expect(migrationRows(path)).toEqual(first);
  });

  test("an already-applied migration that has since been edited stops the app", () => {
    const path = freshFile();
    initDb(path, () => {});
    closeDb();

    // Stand in for "someone edited 001_initial after this database ran it".
    const raw = new Database(path);
    raw.query("UPDATE migrations SET fingerprint = ? WHERE name = ?").run("0123456789abcdef", "001_initial");
    raw.close();

    expect(() => initDb(path, () => {})).toThrow(/001_initial has been edited since this database applied it/);
  });

  test("a database from before fingerprints existed is adopted, not rejected", () => {
    const path = freshFile();
    initDb(path, () => {});
    closeDb();

    const raw = new Database(path);
    raw.exec("UPDATE migrations SET fingerprint = NULL");
    raw.close();

    expect(() => initDb(path, () => {})).not.toThrow();
    closeDb();
    expect(migrationRows(path)[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});
