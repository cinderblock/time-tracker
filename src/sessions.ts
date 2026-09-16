import { audit } from "./audit.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import { db } from "./db.server.ts";
import { type User, getUser } from "./users.ts";

/**
 * Browser sessions.
 *
 * The cookie carries a random token; the database stores only its SHA-256, as
 * the row id. Expiry slides: every use pushes it out again, but the write
 * happens at most once per REFRESH_INTERVAL so an active phone isn't writing
 * to the database on every request.
 */

const DAY = 24 * 60 * 60 * 1000;

/**
 * A field employee who opens the app weekly should never be logged out; a
 * lost phone's session should die after six months nobody touched it.
 */
export const SESSION_TTL_MS = 180 * DAY;
export const REFRESH_INTERVAL_MS = DAY;

export interface Session {
  id: string;
  userId: number;
  credentialId: number | null;
  userAgent: string | null;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

interface SessionRow {
  id: string;
  user_id: number;
  credential_id: number | null;
  user_agent: string | null;
  created_at: number;
  last_used_at: number;
  expires_at: number;
}

const COLUMNS = "id, user_id, credential_id, user_agent, created_at, last_used_at, expires_at";

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    userId: r.user_id,
    credentialId: r.credential_id,
    userAgent: r.user_agent,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
  };
}

/** Start a session. Returns the token for the cookie; it is not stored. */
export function createSession(args: {
  userId: number;
  credentialId: number | null;
  userAgent: string | null;
  now?: number;
}): { token: string; session: Session } {
  const now = args.now ?? Date.now();
  const token = randomToken(32);
  const row = db()
    .query<SessionRow, [string, number, number | null, string | null, number, number, number]>(
      `INSERT INTO sessions (id, user_id, credential_id, user_agent, created_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING ${COLUMNS}`,
    )
    .get(
      sha256Hex(token),
      args.userId,
      args.credentialId,
      args.userAgent?.slice(0, 300) ?? null,
      now,
      now,
      now + SESSION_TTL_MS,
    )!;
  const session = toSession(row);
  audit({
    actorUserId: args.userId,
    entity: "session",
    entityId: shortId(session.id),
    action: "create",
    after: { credentialId: args.credentialId },
    at: now,
  });
  return { token, session };
}

export interface ResolvedSession {
  session: Session;
  user: User;
  /** True when expiry was just pushed out, so the cookie should be re-sent. */
  refreshed: boolean;
}

/**
 * The live session and active user a cookie token names, or null. Slides the
 * expiry forward if it hasn't been refreshed within REFRESH_INTERVAL_MS.
 */
export function resolveSession(token: string | null | undefined, now: number = Date.now()): ResolvedSession | null {
  if (!token) return null;
  const row = db()
    .query<SessionRow, [string, number]>(
      `SELECT ${COLUMNS} FROM sessions
        WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .get(sha256Hex(token), now);
  if (!row) return null;

  const user = getUser(row.user_id);
  if (!user?.active) return null;

  let session = toSession(row);
  let refreshed = false;
  if (now - session.lastUsedAt >= REFRESH_INTERVAL_MS) {
    const expiresAt = now + SESSION_TTL_MS;
    db()
      .query("UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?")
      .run(now, expiresAt, session.id);
    session = { ...session, lastUsedAt: now, expiresAt };
    refreshed = true;
  }
  return { session, user, refreshed };
}

export interface SessionListing extends Session {
  credentialNickname: string | null;
}

/** A person's live sessions, most recently used first. */
export function listSessions(userId: number, now: number = Date.now()): SessionListing[] {
  return db()
    .query<SessionRow & { credential_nickname: string | null }, [number, number]>(
      `SELECT ${COLUMNS.split(", ").map((c) => `s.${c}`).join(", ")},
              c.nickname AS credential_nickname
         FROM sessions s
         LEFT JOIN credentials c ON c.id = s.credential_id
        WHERE s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
        ORDER BY s.last_used_at DESC`,
    )
    .all(userId, now)
    .map((r) => ({ ...toSession(r), credentialNickname: r.credential_nickname }));
}

export function revokeSession(args: { id: string; userId: number; actorUserId: number; now?: number }): void {
  const now = args.now ?? Date.now();
  const result = db()
    .query("UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .run(now, args.id, args.userId);
  if (result.changes === 1) {
    audit({
      actorUserId: args.actorUserId,
      entity: "session",
      entityId: shortId(args.id),
      action: "revoke",
      at: now,
    });
  }
}

/** Revoke all of a person's sessions, optionally sparing one (the caller's own). */
export function revokeAllSessions(args: {
  userId: number;
  exceptId?: string;
  actorUserId: number;
  now?: number;
}): number {
  const now = args.now ?? Date.now();
  const result = db()
    .query(
      `UPDATE sessions SET revoked_at = ?
        WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?`,
    )
    .run(now, args.userId, args.exceptId ?? null);
  if (result.changes > 0) {
    audit({
      actorUserId: args.actorUserId,
      entity: "user",
      entityId: args.userId,
      action: "revoke_sessions",
      after: { count: result.changes, keptCurrent: Boolean(args.exceptId) },
      at: now,
    });
  }
  return result.changes;
}

/**
 * A short, non-reversible handle for a session, for the audit log and URLs.
 * The row id is already a hash, so a prefix of it reveals nothing usable.
 */
export function shortId(sessionId: string): string {
  return sessionId.slice(0, 12);
}
