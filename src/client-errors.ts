import { createHash } from "node:crypto";

import { audit } from "./audit.ts";
import type { Breadcrumb, ClientError } from "./bug-schema.ts";
import { db } from "./db.server.ts";
import { OpError } from "./op-error.ts";

/**
 * Errors from people's browsers, sent by the page on its own (app/bugs/errors.ts).
 *
 * The same fault happens on every phone that runs the same code, with ids and
 * numbers in its message that differ each time. So errors are grouped by a
 * fingerprint — the message with those taken out, and the top of the stack
 * named by function and source file (not line, not the build's hashed file
 * name) — and each group keeps a count and its latest occurrences. Admins see
 * the groups; a new group is what's worth telling them about.
 */

/** Occurrences kept per group; older ones are dropped. */
export const EVENTS_PER_GROUP = 25;

export type ErrorGroupStatus = "new" | "fixed" | "ignored";

/** The message with what varies between occurrences taken out. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/https?:\/\/[^\s)'"]+/g, "<url>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<n>")
    .replace(/\b\d+(\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * The top frames of a stack, as "function@file": Chrome's "at fn (url:l:c)"
 * and Safari/Firefox's "fn@url:l:c" alike. The file loses its directory, its
 * build hash (NotesPanel-B3kq9Zx1.js → NotesPanel) and its line.
 */
export function topFrames(stack: string | undefined, count = 3): string[] {
  if (!stack) return [];
  const frames: string[] = [];
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    const chrome = /^at (?:(.+?) \()?(.+?):\d+:\d+\)?$/.exec(line);
    const gecko = /^(.*?)@(.+?):\d+:\d+$/.exec(line);
    const m = chrome ?? gecko;
    if (!m) continue;
    const fn = (m[1] ?? "").replace(/^async /, "") || "<anonymous>";
    const file = (m[2] ?? "")
      .split(/[?#]/)[0]!
      .split("/")
      .pop()!
      .replace(/-[A-Za-z0-9_]{6,}(?=\.\w+$)/, "")
      .replace(/\.\w+$/, "");
    frames.push(`${fn}@${file}`);
    if (frames.length === count) break;
  }
  return frames;
}

export function fingerprintOf(e: Pick<ClientError, "message" | "name" | "stack">): string {
  const key = [e.name ?? "", normalizeMessage(e.message), ...topFrames(e.stack)].join("\n");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// ---- rate limiting -------------------------------------------------------------------

const WINDOW_MS = 10 * 60_000;
/** Occurrences one sender may record per window; the rest are counted, not stored. */
export const EVENTS_PER_WINDOW = 200;
const windows = new Map<string, { start: number; n: number }>();

/** Whether `who` (a person, or an address when signed out) may record `n` more. */
function allow(who: string, n: number, now: number): boolean {
  const w = windows.get(who);
  if (!w || now - w.start > WINDOW_MS) {
    windows.set(who, { start: now, n });
    if (windows.size > 10_000) windows.clear(); // a flood of addresses: start over
    return n <= EVENTS_PER_WINDOW;
  }
  w.n += n;
  return w.n <= EVENTS_PER_WINDOW;
}

/** For tests. */
export function resetRateLimits(): void {
  windows.clear();
}

// ---- recording -----------------------------------------------------------------------

export interface Recorded {
  /** Groups that didn't exist before this batch, or were fixed and are back. */
  fresh: number[];
  stored: number;
  /** Over the rate limit: counted on their group, not stored. */
  dropped: number;
}

export function recordClientErrors(args: {
  errors: ClientError[];
  userId: number | null;
  /** Who's sending, for the rate limit: the person, or their address signed out. */
  sender: string;
  userAgent: string | null;
  now: number;
}): Recorded {
  const result: Recorded = { fresh: [], stored: 0, dropped: 0 };
  db().transaction(() => {
    for (const e of args.errors) {
      const fingerprint = fingerprintOf(e);
      const existing = db()
        .query<{ id: number; status: ErrorGroupStatus }, [string]>("SELECT id, status FROM client_error_groups WHERE fingerprint = ?")
        .get(fingerprint);
      let groupId: number;
      if (!existing) {
        groupId = Number(
          db()
            .query(
              `INSERT INTO client_error_groups (fingerprint, message, first_seen_at, last_seen_at, count)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(fingerprint, `${e.name && !e.message.startsWith(e.name) ? `${e.name}: ` : ""}${e.message}`.slice(0, 1000), args.now, args.now, e.repeats)
            .lastInsertRowid,
        );
        result.fresh.push(groupId);
      } else {
        groupId = existing.id;
        // Fixed, and here again: it isn't.
        const regressed = existing.status === "fixed";
        db()
          .query(
            `UPDATE client_error_groups
                SET last_seen_at = ?, count = count + ?,
                    status = CASE WHEN status = 'fixed' THEN 'new' ELSE status END,
                    regressed_at = CASE WHEN status = 'fixed' THEN ? ELSE regressed_at END
              WHERE id = ?`,
          )
          .run(args.now, e.repeats, args.now, groupId);
        if (regressed) result.fresh.push(groupId);
      }

      if (!allow(args.sender, 1, args.now)) {
        result.dropped++;
        continue;
      }
      db()
        .query(
          `INSERT INTO client_error_events
             (group_id, user_id, client_time, received_at, repeats, url, client_revision, user_agent, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          groupId,
          args.userId,
          e.at,
          args.now,
          e.repeats,
          e.url,
          e.revision,
          args.userAgent,
          JSON.stringify({ name: e.name ?? null, message: e.message, stack: e.stack ?? null, source: e.source, breadcrumbs: e.breadcrumbs ?? [] }),
        );
      result.stored++;
      // Only the latest few are kept.
      db()
        .query(
          `DELETE FROM client_error_events
            WHERE group_id = ?1 AND id NOT IN (
              SELECT id FROM client_error_events WHERE group_id = ?1 ORDER BY received_at DESC, id DESC LIMIT ?2)`,
        )
        .run(groupId, EVENTS_PER_GROUP);
    }
  })();
  return result;
}

// ---- reading -------------------------------------------------------------------------

export interface ErrorGroup {
  id: number;
  message: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  status: ErrorGroupStatus;
  regressedAt: number | null;
  /** Names of the people it happened to (among the occurrences kept), and whether anyone signed out hit it. */
  people: string[];
  signedOut: boolean;
}

export interface ErrorEvent {
  id: number;
  userId: number | null;
  userName: string | null;
  clientTime: number;
  receivedAt: number;
  repeats: number;
  url: string | null;
  clientRevision: string | null;
  userAgent: string | null;
  detail: { name: string | null; message: string; stack: string | null; source: string; breadcrumbs: Breadcrumb[] };
}

interface GroupRow {
  id: number;
  message: string;
  first_seen_at: number;
  last_seen_at: number;
  count: number;
  status: ErrorGroupStatus;
  regressed_at: number | null;
  people: string | null;
  signed_out: number;
}

const GROUP_SQL = `
  SELECT g.id, g.message, g.first_seen_at, g.last_seen_at, g.count, g.status, g.regressed_at,
         (SELECT group_concat(DISTINCT u.name) FROM client_error_events ev JOIN users u ON u.id = ev.user_id
           WHERE ev.group_id = g.id) AS people,
         EXISTS (SELECT 1 FROM client_error_events ev WHERE ev.group_id = g.id AND ev.user_id IS NULL) AS signed_out
    FROM client_error_groups g`;

const toGroup = (r: GroupRow): ErrorGroup => ({
  id: r.id,
  message: r.message,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  count: r.count,
  status: r.status,
  regressedAt: r.regressed_at,
  people: r.people ? r.people.split(",").sort() : [],
  signedOut: r.signed_out === 1,
});

/** Groups, the ones still open first, most recently seen first. */
export function listErrorGroups(limit = 200): ErrorGroup[] {
  return db()
    .query<GroupRow, [number]>(`${GROUP_SQL} ORDER BY g.status = 'new' DESC, g.last_seen_at DESC LIMIT ?`)
    .all(limit)
    .map(toGroup);
}

export function getErrorGroup(id: number): (ErrorGroup & { events: ErrorEvent[] }) | null {
  const row = db().query<GroupRow, [number]>(`${GROUP_SQL} WHERE g.id = ?`).get(id);
  if (!row) return null;
  const events = db()
    .query<
      {
        id: number;
        user_id: number | null;
        user_name: string | null;
        client_time: number;
        received_at: number;
        repeats: number;
        url: string | null;
        client_revision: string | null;
        user_agent: string | null;
        detail: string;
      },
      [number]
    >(
      `SELECT ev.id, ev.user_id, u.name AS user_name, ev.client_time, ev.received_at, ev.repeats, ev.url,
              ev.client_revision, ev.user_agent, ev.detail
         FROM client_error_events ev LEFT JOIN users u ON u.id = ev.user_id
        WHERE ev.group_id = ? ORDER BY ev.received_at DESC, ev.id DESC`,
    )
    .all(id)
    .map((e) => ({
      id: e.id,
      userId: e.user_id,
      userName: e.user_name,
      clientTime: e.client_time,
      receivedAt: e.received_at,
      repeats: e.repeats,
      url: e.url,
      clientRevision: e.client_revision,
      userAgent: e.user_agent,
      detail: JSON.parse(e.detail) as ErrorEvent["detail"],
    }));
  return { ...toGroup(row), events };
}

/** Ids of groups waiting on someone: new, or back after being fixed. */
export function openErrorGroupIds(): number[] {
  return db()
    .query<{ id: number }, []>("SELECT id FROM client_error_groups WHERE status = 'new' ORDER BY id")
    .all()
    .map((r) => r.id);
}

export function setErrorGroupStatus(args: { id: number; status: ErrorGroupStatus; actorUserId: number; now: number }): void {
  const row = db().query<{ status: ErrorGroupStatus }, [number]>("SELECT status FROM client_error_groups WHERE id = ?").get(args.id);
  if (!row) throw new OpError("not_found", "That error is no longer listed.");
  db()
    .query("UPDATE client_error_groups SET status = ?, status_at = ?, status_by = ? WHERE id = ?")
    .run(args.status, args.now, args.actorUserId, args.id);
  audit({
    actorUserId: args.actorUserId,
    entity: "client_error_group",
    entityId: args.id,
    action: "status",
    before: { status: row.status },
    after: { status: args.status },
    at: args.now,
  });
}
