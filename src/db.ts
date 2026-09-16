import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "./config.ts";

/**
 * SQLite access. One connection, opened at startup, stashed on globalThis so
 * Vite's SSR module re-evaluation doesn't leak handles during development.
 *
 * Time representation, applied consistently throughout the schema:
 *   - An *instant* is INTEGER epoch milliseconds (UTC). Durations are computed
 *     by subtraction, which is the whole point.
 *   - A *wall-clock date* is TEXT 'YYYY-MM-DD' in config.timezone. `work_date`
 *     is one of these because "which day does this work belong to" is a human
 *     question, and QuickBooks stores a bare date with no zone.
 * Mixing the two is the classic source of off-by-a-day payroll bugs, so the
 * column type tells you which kind you are holding.
 */

type GlobalWithDb = typeof globalThis & { __timeTrackerDb__?: Database };

export function db(): Database {
  const conn = (globalThis as GlobalWithDb).__timeTrackerDb__;
  if (!conn) throw new Error("DB not initialized — call initDb() during startup");
  return conn;
}

export function initDb(): Database {
  const g = globalThis as GlobalWithDb;
  if (g.__timeTrackerDb__) return g.__timeTrackerDb__;

  const path = resolve(config.databasePath);
  mkdirSync(dirname(path), { recursive: true });

  const conn = new Database(path);
  conn.exec("PRAGMA journal_mode = WAL;");
  conn.exec("PRAGMA foreign_keys = ON;");
  conn.exec("PRAGMA busy_timeout = 5000;");

  runMigrations(conn);

  g.__timeTrackerDb__ = conn;
  console.log(`[db] opened ${path}`);
  return conn;
}

/** Close and forget, so a later initDb() opens afresh (integration tests). */
export function closeDb(): void {
  const g = globalThis as GlobalWithDb;
  g.__timeTrackerDb__?.close();
  g.__timeTrackerDb__ = undefined;
}

interface Migration {
  name: string;
  up: (db: Database) => void;
}

const migrations: Migration[] = [
  {
    name: "001_initial",
    up: (db) => {
      db.exec(`
        ---------------------------------------------------------------- people
        CREATE TABLE employee_categories (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          name                  TEXT NOT NULL UNIQUE,
          default_hourly_rate   REAL,
          default_payroll_item  TEXT,
          created_at            INTEGER NOT NULL
        );

        CREATE TABLE users (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          name              TEXT NOT NULL,
          email             TEXT,
          role              TEXT NOT NULL CHECK (role IN ('admin','employee')),
          category_id       INTEGER REFERENCES employee_categories(id),
          -- ListID of the matching Employee/Vendor/OtherName in the accounting
          -- backend. NULL until an admin links them; entries for an unlinked
          -- user cannot be pushed.
          remote_person_id  TEXT,
          active            INTEGER NOT NULL DEFAULT 1,
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL
        );
        CREATE INDEX idx_users_active ON users(active);

        CREATE TABLE credentials (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          credential_id  TEXT NOT NULL UNIQUE,
          public_key     BLOB NOT NULL,
          counter        INTEGER NOT NULL DEFAULT 0,
          transports     TEXT,
          nickname       TEXT,
          created_at     INTEGER NOT NULL,
          last_used_at   INTEGER
        );
        CREATE INDEX idx_credentials_user ON credentials(user_id);

        CREATE TABLE sessions (
          id          TEXT PRIMARY KEY,
          user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at  INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL,
          user_agent  TEXT,
          revoked_at  INTEGER
        );
        CREATE INDEX idx_sessions_user ON sessions(user_id);

        -- One-time registration URLs. Only the SHA-256 hash of the token is
        -- stored, so a database leak cannot be replayed into an account.
        CREATE TABLE registrations (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          token_hash  TEXT NOT NULL UNIQUE,
          role        TEXT NOT NULL CHECK (role IN ('admin','employee')),
          name_hint   TEXT,
          created_by  INTEGER REFERENCES users(id),
          created_at  INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL,
          used_at     INTEGER,
          user_id     INTEGER REFERENCES users(id)
        );

        ------------------------------------------------------------------ work
        -- Jobs mirror the accounting backend's Customer:Job tree, but may also
        -- be invented here first: remote_id IS NULL means "provisional", i.e.
        -- the job exists in this app only because someone had to book hours
        -- against it before it was created in QuickBooks. An admin links it
        -- later and every entry already booked against it follows the link.
        CREATE TABLE jobs (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          name              TEXT NOT NULL,
          parent_id         INTEGER REFERENCES jobs(id),
          remote_id         TEXT UNIQUE,
          remote_full_name  TEXT,
          provisional       INTEGER NOT NULL DEFAULT 0,
          active            INTEGER NOT NULL DEFAULT 1,
          created_by        INTEGER REFERENCES users(id),
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL
        );
        CREATE INDEX idx_jobs_active ON jobs(active);
        CREATE INDEX idx_jobs_parent ON jobs(parent_id);

        CREATE TABLE service_items (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          remote_id  TEXT UNIQUE,
          active     INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        );

        -- Rate resolution, most specific wins:
        --   user+job -> job -> user -> category -> global
        CREATE TABLE rates (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          scope          TEXT NOT NULL
                           CHECK (scope IN ('user_job','job','user','category','global')),
          user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
          job_id         INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
          category_id    INTEGER REFERENCES employee_categories(id) ON DELETE CASCADE,
          hourly_rate    REAL NOT NULL,
          effective_from INTEGER NOT NULL,
          created_at     INTEGER NOT NULL
        );
        CREATE INDEX idx_rates_lookup ON rates(scope, user_id, job_id, category_id);

        ----------------------------------------------------------------- time
        -- id is a CLIENT-generated UUID v7: an entry created offline must keep
        -- its identity when it finally syncs, which a server-assigned rowid
        -- cannot do. v7 also sorts by creation time.
        CREATE TABLE time_entries (
          id                    TEXT PRIMARY KEY,
          user_id               INTEGER NOT NULL REFERENCES users(id),
          job_id                INTEGER REFERENCES jobs(id),
          service_item_id       INTEGER REFERENCES service_items(id),
          work_date             TEXT NOT NULL,          -- 'YYYY-MM-DD', local
          duration_seconds      INTEGER NOT NULL DEFAULT 0,
          note                  TEXT,
          billable              INTEGER NOT NULL DEFAULT 1,
          -- Rate frozen at approval so later rate edits don't rewrite history.
          rate_snapshot         REAL,
          source                TEXT NOT NULL
                                  CHECK (source IN ('timer','manual','note_rollup')),
          status                TEXT NOT NULL
                                  CHECK (status IN ('open','draft','submitted',
                                                    'approved','synced','sync_failed')),
          remote_txn_id         TEXT,
          remote_edit_sequence  TEXT,
          device_id             TEXT,
          -- Device clock vs server clock at creation. A large gap means the
          -- phone's clock is wrong; we flag rather than silently "correct",
          -- because the device is the only witness to when work started.
          client_created_at     INTEGER,
          created_at            INTEGER NOT NULL,
          updated_at            INTEGER NOT NULL,
          deleted_at            INTEGER              -- soft delete; never purge
        );
        CREATE INDEX idx_entries_user_date ON time_entries(user_id, work_date);
        CREATE INDEX idx_entries_status    ON time_entries(status);
        CREATE INDEX idx_entries_job       ON time_entries(job_id);
        -- At most one running timer per user. A partial unique index makes the
        -- invariant the database's job rather than the application's.
        CREATE UNIQUE INDEX idx_entries_one_open_per_user
          ON time_entries(user_id) WHERE status = 'open' AND deleted_at IS NULL;

        -- Pause/resume is modelled as real gaps rather than a subtracted
        -- number, so the audit trail shows what actually happened.
        -- duration_seconds on the parent is the sum of these.
        CREATE TABLE time_segments (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          entry_id    TEXT NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
          started_at  INTEGER NOT NULL,
          ended_at    INTEGER
        );
        CREATE INDEX idx_segments_entry ON time_segments(entry_id);

        -- Sporadic notes captured through the day, later rolled up into
        -- time_entries by the end-of-day review.
        CREATE TABLE day_notes (
          id                  TEXT PRIMARY KEY,
          user_id             INTEGER NOT NULL REFERENCES users(id),
          at                  INTEGER NOT NULL,
          work_date           TEXT NOT NULL,
          text                TEXT NOT NULL,
          job_id              INTEGER REFERENCES jobs(id),
          rolled_into_entry_id TEXT REFERENCES time_entries(id),
          device_id           TEXT,
          created_at          INTEGER NOT NULL,
          updated_at          INTEGER NOT NULL,
          deleted_at          INTEGER
        );
        CREATE INDEX idx_notes_user_date ON day_notes(user_id, work_date);

        -- Opportunistic location fixes. A PWA cannot track in the background,
        -- so these are discrete samples at meaningful moments, never a trail.
        CREATE TABLE locations (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          entry_id    TEXT REFERENCES time_entries(id) ON DELETE CASCADE,
          segment_id  INTEGER REFERENCES time_segments(id) ON DELETE CASCADE,
          note_id     TEXT REFERENCES day_notes(id) ON DELETE CASCADE,
          at          INTEGER NOT NULL,
          lat         REAL NOT NULL,
          lon         REAL NOT NULL,
          accuracy_m  REAL,
          kind        TEXT NOT NULL CHECK (kind IN ('start','stop','periodic','note'))
        );
        CREATE INDEX idx_locations_entry ON locations(entry_id);

        ------------------------------------------------------- sync & auditing
        -- Idempotency ledger for the offline outbox. Replaying an op whose id
        -- is already here returns the stored result instead of applying twice.
        CREATE TABLE applied_ops (
          op_id       TEXT PRIMARY KEY,
          user_id     INTEGER NOT NULL REFERENCES users(id),
          type        TEXT NOT NULL,
          device_id   TEXT,
          client_time INTEGER,
          applied_at  INTEGER NOT NULL,
          result_json TEXT
        );
        CREATE INDEX idx_applied_ops_user ON applied_ops(user_id, applied_at);

        -- Append-only. Nothing in the app may UPDATE or DELETE this table.
        CREATE TABLE audit_log (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_user_id  INTEGER REFERENCES users(id),
          at             INTEGER NOT NULL,
          entity         TEXT NOT NULL,
          entity_id      TEXT NOT NULL,
          action         TEXT NOT NULL,
          before_json    TEXT,
          after_json     TEXT,
          device_id      TEXT
        );
        CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
        CREATE INDEX idx_audit_at     ON audit_log(at);

        -- Full request/response of every push attempt. QuickBooks is offline
        -- more often than not, so this is the first thing to read when an
        -- entry hasn't landed.
        CREATE TABLE sync_attempts (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          entry_id  TEXT REFERENCES time_entries(id) ON DELETE CASCADE,
          backend   TEXT NOT NULL,
          at        INTEGER NOT NULL,
          ok        INTEGER NOT NULL,
          request   TEXT,
          response  TEXT,
          error     TEXT
        );
        CREATE INDEX idx_sync_attempts_entry ON sync_attempts(entry_id, at);

        CREATE TABLE settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
];

function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name        TEXT PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db.query<{ name: string }, []>("SELECT name FROM migrations").all().map((r) => r.name),
  );

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    console.log(`[db] applying migration ${migration.name}`);
    db.transaction(() => {
      migration.up(db);
      db.query("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(
        migration.name,
        Date.now(),
      );
    })();
  }
}
