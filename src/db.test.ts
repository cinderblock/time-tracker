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
    expect(first.map((r) => r.name)).toEqual([
      "001_initial",
      "002_tracking_mode",
      "003_note_kind",
      "004_submission",
      "005_takes_time",
      "006_job_billable",
      "007_duplicate_check",
      "008_clean_notes",
      "009_notifications",
      "010_notes_hold",
      "011_one_line_per_job",
      "012_settled_notes",
      "013_bug_reports",
    ]);
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

describe("012_settled_notes", () => {
  test("settles the notes of entries deleted for the accounting system's record, and only those", () => {
    const path = freshFile();
    initDb(path, () => {});
    closeDb();

    // The database as it was before 012, with three days' worth of answers in it.
    const raw = new Database(path);
    raw.exec("ALTER TABLE day_notes DROP COLUMN settled_as");
    raw.exec("ALTER TABLE day_notes DROP COLUMN settled_at");
    raw.exec("DELETE FROM migrations WHERE name = '012_settled_notes'");
    raw.exec(`INSERT INTO users (id, name, role, webauthn_user_id, created_at, updated_at) VALUES (1, 'A', 'employee', 'w', 0, 0)`);
    const entry = raw.query(
      `INSERT INTO time_entries (id, user_id, work_date, source, status, created_at, updated_at, deleted_at)
       VALUES (?, 1, '2026-09-21', 'note_rollup', 'draft', 0, 0, ?)`,
    );
    const note = raw.query(
      `INSERT INTO day_notes (id, user_id, at, work_date, text, rolled_into_entry_id, created_at, updated_at)
       VALUES (?, 1, 0, '2026-09-21', 'x', ?, 0, 0)`,
    );
    const audited = raw.query(`INSERT INTO audit_log (actor_user_id, at, entity, entity_id, action) VALUES (1, ?, 'entry', ?, ?)`);
    // Kept theirs: deleted by the discard itself.
    entry.run("kept", 1000);
    audited.run(1000, "kept", "duplicate_discard");
    note.run("n-kept", "kept");
    // Kept theirs, restored, then deleted as an ordinary undo of the rollup.
    entry.run("undone", 3000);
    audited.run(1000, "undone", "duplicate_discard");
    audited.run(2000, "undone", "restore");
    audited.run(3000, "undone", "delete");
    note.run("n-undone", "undone");
    // Deleted the ordinary way, and a live entry.
    entry.run("deleted", 1000);
    note.run("n-deleted", "deleted");
    entry.run("live", null);
    note.run("n-live", "live");
    raw.close();

    reopen(path);
    closeDb();
    const after = new Database(path, { readonly: true });
    try {
      const rows = after
        .query<{ id: string; settled_as: string | null; settled_at: number | null }, []>(
          "SELECT id, settled_as, settled_at FROM day_notes ORDER BY id",
        )
        .all();
      expect(rows).toEqual([
        { id: "n-deleted", settled_as: null, settled_at: null },
        { id: "n-kept", settled_as: "kept_in_accounting", settled_at: 1000 },
        { id: "n-live", settled_as: null, settled_at: null },
        { id: "n-undone", settled_as: null, settled_at: null },
      ]);
    } finally {
      after.close();
    }
  });
});
