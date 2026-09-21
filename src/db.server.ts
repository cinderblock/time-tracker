import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "./config.server.ts";

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

/**
 * Open (and migrate) the database. `path` defaults to the configured file;
 * tests pass ":memory:" for an isolated, throwaway database. `log` receives
 * the open/migration lines — the CLI sends them to stderr so its stdout stays
 * machine-readable.
 */
export function initDb(
  path: string = config.databasePath,
  log: (line: string) => void = console.log,
): Database {
  const g = globalThis as GlobalWithDb;
  if (g.__timeTrackerDb__) return g.__timeTrackerDb__;

  const inMemory = path === ":memory:";
  // resolve() would turn ":memory:" into a real (and, on Windows, invalid)
  // file path, so leave the in-memory sentinel exactly as SQLite expects it.
  if (!inMemory) {
    path = resolve(path);
    mkdirSync(dirname(path), { recursive: true });
  }

  const conn = new Database(path);
  conn.exec("PRAGMA journal_mode = WAL;");
  conn.exec("PRAGMA foreign_keys = ON;");
  conn.exec("PRAGMA busy_timeout = 5000;");

  // Throwaway test databases are opened once per test; logging each would
  // bury the output that matters.
  const say = inMemory ? () => {} : log;
  runMigrations(conn, say);

  g.__timeTrackerDb__ = conn;
  say(`[db] opened ${path}`);
  return conn;
}

/** Close and forget, so a later initDb() opens afresh (integration tests). */
export function closeDb(): void {
  const g = globalThis as GlobalWithDb;
  g.__timeTrackerDb__?.close();
  g.__timeTrackerDb__ = undefined;
}

/**
 * A migration is SQL text, not code: the runner records a hash of it, and a
 * hash has to mean the same thing in the bundled server and in a CLI running
 * from source. A string literal survives bundling byte for byte; a function's
 * source does not (that mistake cost an afternoon — see plans).
 */
interface Migration {
  name: string;
  sql: string;
}

const migrations: Migration[] = [
  {
    name: "001_initial",
    sql: `
        ---------------------------------------------------------------- people
        -- Groups of people ("Field", "Shop") for filtering and default rates.
        -- A category's rate lives in the rates table (scope 'category'), with the
        -- same effective dates as every other rate.
        CREATE TABLE employee_categories (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          name                     TEXT NOT NULL UNIQUE COLLATE NOCASE,
          -- remote_items.id of a wage payroll item, for Employees in it.
          default_payroll_item_id  TEXT,
          created_at               INTEGER NOT NULL
        );

        ------------------------------------------------ accounting-system lists
        -- Copies of the accounting system's own lists, refreshed by each pull.
        -- Ids are the backend's (QuickBooks ListIDs). No foreign keys point
        -- here: a pull may drop a record something still names, and that must
        -- show up as "not linked", not fail the pull.
        CREATE TABLE remote_people (
          id         TEXT PRIMARY KEY,
          kind       TEXT NOT NULL CHECK (kind IN ('employee','vendor','other')),
          name       TEXT NOT NULL,
          active     INTEGER NOT NULL DEFAULT 1,
          synced_at  INTEGER NOT NULL
        );

        CREATE TABLE remote_items (
          id         TEXT PRIMARY KEY,
          kind       TEXT NOT NULL CHECK (kind IN ('service','payroll_wage')),
          name       TEXT NOT NULL,
          full_name  TEXT NOT NULL,
          active     INTEGER NOT NULL DEFAULT 1,
          synced_at  INTEGER NOT NULL
        );

        CREATE TABLE users (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          name              TEXT NOT NULL,
          email             TEXT,
          role              TEXT NOT NULL CHECK (role IN ('admin','employee')),
          category_id       INTEGER REFERENCES employee_categories(id) ON DELETE SET NULL,
          -- ListID of the matching Employee/Vendor/OtherName in the accounting
          -- backend. NULL until an admin links them; entries for an unlinked
          -- user cannot be pushed.
          remote_person_id  TEXT,
          -- remote_items.id; overrides the category's and the organisation's.
          default_payroll_item_id TEXT,
          -- WebAuthn user handle: 32 random bytes, base64url. Deliberately not
          -- the row id, which would leak account ordering to authenticators.
          webauthn_user_id  TEXT NOT NULL UNIQUE,
          active            INTEGER NOT NULL DEFAULT 1,
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL
        );
        CREATE INDEX idx_users_active ON users(active);

        CREATE TABLE credentials (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          credential_id  TEXT NOT NULL UNIQUE,     -- base64url
          public_key     BLOB NOT NULL,
          counter        INTEGER NOT NULL DEFAULT 0,
          transports     TEXT,                     -- JSON array
          device_type    TEXT,                     -- 'singleDevice' | 'multiDevice'
          backed_up      INTEGER NOT NULL DEFAULT 0,
          nickname       TEXT NOT NULL,
          created_at     INTEGER NOT NULL,
          last_used_at   INTEGER
        );
        CREATE INDEX idx_credentials_user ON credentials(user_id);

        -- id is the SHA-256 of the cookie token, never the token itself, so a
        -- database leak cannot be replayed as a login.
        CREATE TABLE sessions (
          id             TEXT PRIMARY KEY,
          user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          -- The passkey that signed this session in, for display. NULL once
          -- that passkey is removed; the session itself is left alone.
          credential_id  INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
          user_agent     TEXT,
          created_at     INTEGER NOT NULL,
          last_used_at   INTEGER NOT NULL,
          expires_at     INTEGER NOT NULL,
          revoked_at     INTEGER
        );
        CREATE INDEX idx_sessions_user ON sessions(user_id);

        -- One-time registration links. Only the SHA-256 hash of the token is
        -- stored, so a database leak cannot be replayed into an account.
        --   bootstrap   first admin; minted automatically while no admin exists
        --   invite      a new person, with the role the admin chose
        --   add_device  an existing person (user_id preset) on a new device
        -- For bootstrap/invite, user_id is filled in when the link is used.
        CREATE TABLE registrations (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          token_hash  TEXT NOT NULL UNIQUE,
          purpose     TEXT NOT NULL
                        CHECK (purpose IN ('bootstrap','invite','add_device')),
          role        TEXT NOT NULL CHECK (role IN ('admin','employee')),
          name_hint   TEXT,
          user_id     INTEGER REFERENCES users(id),
          created_by  INTEGER REFERENCES users(id),
          created_at  INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL,
          used_at     INTEGER,
          revoked_at  INTEGER
        );

        ------------------------------------------------------------------ work
        -- Jobs mirror the accounting backend's Customer:Job tree, but may also
        -- be invented here first: remote_id IS NULL means "provisional", i.e.
        -- the job exists in this app only because someone had to book hours
        -- against it before it was created in QuickBooks. An admin links it
        -- later and every entry already booked against it follows the link.
        --
        -- id is a UUID v7, like entry ids: a job created on a phone while
        -- offline must be usable (a timer started on it) before it syncs.
        CREATE TABLE jobs (
          id                TEXT PRIMARY KEY,
          name              TEXT NOT NULL,
          parent_id         TEXT REFERENCES jobs(id),
          remote_id         TEXT UNIQUE,
          remote_full_name  TEXT,
          -- The accounting system's own active flag. A job inactive there
          -- can't take time, whatever active says.
          remote_active     INTEGER NOT NULL DEFAULT 1,
          provisional       INTEGER NOT NULL DEFAULT 0,
          -- A provisional job linked to a real one is merged into it: its
          -- entries move, and this row forwards there so a device still
          -- holding the old id keeps working.
          merged_into       TEXT REFERENCES jobs(id),
          -- An admin asked for this provisional job to be created in the
          -- accounting system; cleared once it has a remote_id.
          create_requested_at INTEGER,
          sync_error        TEXT,
          sync_next_at      INTEGER,
          -- remote_items.id; sub-jobs inherit it.
          default_service_item_id TEXT,
          -- Stopping a timer on this job needs a note (on top of the global
          -- require_note_on_stop setting).
          requires_note     INTEGER NOT NULL DEFAULT 0,
          active            INTEGER NOT NULL DEFAULT 1,
          created_by        INTEGER REFERENCES users(id),
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL
        );
        CREATE INDEX idx_jobs_active ON jobs(active);
        CREATE INDEX idx_jobs_parent ON jobs(parent_id);

        -- Rate resolution, most specific wins (src/rates.ts):
        --   user+job -> job -> user -> category -> global
        -- Job rates also cover the job's sub-jobs.
        CREATE TABLE rates (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          scope          TEXT NOT NULL
                           CHECK (scope IN ('user_job','job','user','category','global')),
          user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
          job_id         TEXT REFERENCES jobs(id) ON DELETE CASCADE,
          category_id    INTEGER REFERENCES employee_categories(id) ON DELETE CASCADE,
          hourly_rate    REAL NOT NULL,
          -- A work date ('YYYY-MM-DD'): the rate applies to work on or after it.
          effective_from TEXT NOT NULL,
          created_by     INTEGER REFERENCES users(id),
          created_at     INTEGER NOT NULL,
          -- Rates are never edited in place; a correction deletes and re-adds,
          -- and the audit log keeps both.
          deleted_at     INTEGER
        );
        CREATE INDEX idx_rates_lookup ON rates(scope, user_id, job_id, category_id);

        ----------------------------------------------------------------- time
        -- id is a CLIENT-generated UUID v7: an entry created offline must keep
        -- its identity when it finally syncs, which a server-assigned rowid
        -- cannot do. v7 also sorts by creation time.
        CREATE TABLE time_entries (
          id                    TEXT PRIMARY KEY,
          user_id               INTEGER NOT NULL REFERENCES users(id),
          job_id                TEXT REFERENCES jobs(id),
          -- remote_items.id, overriding the job's default. Not set by the
          -- UI yet.
          service_item_id       TEXT,
          work_date             TEXT NOT NULL,          -- 'YYYY-MM-DD', local
          duration_seconds      INTEGER NOT NULL DEFAULT 0,
          note                  TEXT,
          billable              INTEGER NOT NULL DEFAULT 1,
          -- Rate frozen at approval so later rate edits don't rewrite history.
          rate_snapshot         REAL,
          -- Approval freezes the rate and locks the entry until reopened.
          approved_at           INTEGER,
          approved_by           INTEGER REFERENCES users(id),
          source                TEXT NOT NULL
                                  CHECK (source IN ('timer','manual','note_rollup')),
          status                TEXT NOT NULL
                                  CHECK (status IN ('open','draft','submitted',
                                                    'approved','synced','sync_failed')),
          -- The accounting system's record of this entry, once sent. Kept
          -- through a reopen, so re-approval amends it rather than adding a
          -- second record.
          remote_txn_id         TEXT,
          remote_edit_sequence  TEXT,
          synced_at             INTEGER,
          -- Deleted here after being sent, and removed there too.
          remote_deleted_at     INTEGER,
          -- Last failure, and when to try again.
          sync_error            TEXT,
          sync_failures         INTEGER NOT NULL DEFAULT 0,
          sync_next_at          INTEGER,
          -- A send whose outcome is unknown (the answer was lost): where to
          -- look for the record before sending again, as JSON
          -- ({txnDate, personRemoteId} or {txnId}). NULL when certain.
          sync_uncertain        TEXT,
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
          job_id              TEXT REFERENCES jobs(id),
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
        --
        -- It also keeps each op's payload, which makes it a complete, replayable
        -- record of what every device asked for and what the server answered.
        CREATE TABLE applied_ops (
          op_id        TEXT PRIMARY KEY,
          -- Whose time the op changed...
          user_id      INTEGER NOT NULL REFERENCES users(id),
          -- ...and who made the change: the same person, or an admin acting
          -- for them.
          actor_user_id INTEGER NOT NULL REFERENCES users(id),
          type         TEXT NOT NULL,
          device_id    TEXT,
          client_time  INTEGER,
          applied_at   INTEGER NOT NULL,
          payload_json TEXT,
          ok           INTEGER NOT NULL,
          result_json  TEXT NOT NULL
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
          backend   TEXT NOT NULL,
          -- 'pull', 'entry.add', 'entry.mod', 'entry.find', 'entry.delete', 'job.add'
          work      TEXT NOT NULL,
          entry_id  TEXT REFERENCES time_entries(id) ON DELETE CASCADE,
          job_id    TEXT REFERENCES jobs(id) ON DELETE CASCADE,
          at        INTEGER NOT NULL,
          ok        INTEGER NOT NULL,
          request   TEXT,
          response  TEXT,
          error     TEXT
        );
        CREATE INDEX idx_sync_attempts_at ON sync_attempts(at);
        CREATE INDEX idx_sync_attempts_entry ON sync_attempts(entry_id, at);

        CREATE TABLE settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
    `,
  },
  {
    name: "002_tracking_mode",
    sql: `
        -- How this person records time: 'timer' (start/stop timers) or
        -- 'notes' (jot notes through the day, turn them into time after).
        -- Their own choice; see src/tracking-mode.ts.
        ALTER TABLE users ADD COLUMN tracking_mode TEXT NOT NULL DEFAULT 'timer'
          CHECK (tracking_mode IN ('timer','notes'));
    `,
  },
  {
    name: "003_note_kind",
    sql: `
        -- A 'note' says what was done. A 'start' marks being on a job from
        -- that moment (made when a job is added to the day) and has no words
        -- of its own; it bounds the timeline like any other note.
        ALTER TABLE day_notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'
          CHECK (kind IN ('note','start'));
    `,
  },
  {
    name: "004_submission",
    sql: `
        -- Submitting is the person saying their time is done: it freezes the
        -- rate and locks the entry, and unless approval is required, it is
        -- what makes the entry eligible to send.
        ALTER TABLE time_entries ADD COLUMN submitted_at INTEGER;
        -- Normally the person themselves; an admin when they submit on
        -- someone's behalf.
        ALTER TABLE time_entries ADD COLUMN submitted_by INTEGER REFERENCES users(id);

        -- Time that predates this column was approved by an admin under the
        -- old rules, where approval was the only gate. Record that it was also
        -- submitted, so it reads the same way as time submitted from now on.
        UPDATE time_entries
           SET submitted_at = approved_at, submitted_by = approved_by
         WHERE approved_at IS NOT NULL;
    `,
  },
];

/**
 * What a migration did, as a short hash of the code that did it.
 *
 * A migration runs once per database, ever. Editing one that has already run
 * therefore changes nothing on that database: it silently keeps the old schema
 * while the code expects the new one. Recording this lets the next start say so
 * instead of failing later in some unrelated query. Editing a migration before
 * it has run anywhere is fine and normal — that's how `001_initial` is built
 * while there is no database.
 */
function fingerprint(migration: Migration): string {
  return new Bun.CryptoHasher("sha256").update(migration.sql).digest("hex").slice(0, 16);
}

function runMigrations(db: Database, log: (line: string) => void): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name        TEXT PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    );
  `);
  // Added after the first databases existed, so it arrives by ALTER rather than
  // by editing the CREATE TABLE above — which is the very thing it guards.
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(migrations)").all();
  if (!columns.some((c) => c.name === "fingerprint")) {
    db.exec("ALTER TABLE migrations ADD COLUMN fingerprint TEXT");
  }

  const applied = new Map(
    db
      .query<{ name: string; fingerprint: string | null }, []>("SELECT name, fingerprint FROM migrations")
      .all()
      .map((r) => [r.name, r.fingerprint] as const),
  );

  for (const migration of migrations) {
    const mark = fingerprint(migration);
    if (applied.has(migration.name)) {
      const was = applied.get(migration.name);
      if (was == null) {
        // Applied before fingerprints existed: adopt what is there now.
        db.query("UPDATE migrations SET fingerprint = ? WHERE name = ?").run(mark, migration.name);
      } else if (was !== mark) {
        throw new Error(
          `Migration ${migration.name} has been edited since this database applied it ` +
            `(${was} → ${mark}). It will not run again, so this database still has the old ` +
            `schema. Put the change in a new migration instead, and restore ${migration.name}.`,
        );
      }
      continue;
    }
    log(`[db] applying migration ${migration.name}`);
    db.transaction(() => {
      db.exec(migration.sql);
      db.query("INSERT INTO migrations (name, applied_at, fingerprint) VALUES (?, ?, ?)").run(
        migration.name,
        Date.now(),
        mark,
      );
    })();
  }
}
