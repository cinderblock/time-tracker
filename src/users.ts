import { audit } from "./audit.ts";
import { randomToken } from "./crypto.ts";
import { db } from "./db.server.ts";
import { NAME_MAX_LENGTH } from "./limits.ts";
import { type TrackingMode, isTrackingMode } from "./tracking-mode.ts";

export type Role = "admin" | "employee";

export interface User {
  id: number;
  name: string;
  email: string | null;
  role: Role;
  categoryId: number | null;
  webauthnUserId: string;
  /** How they record time (src/tracking-mode.ts). Their own choice. */
  trackingMode: TrackingMode;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

interface UserRow {
  id: number;
  name: string;
  email: string | null;
  role: Role;
  category_id: number | null;
  webauthn_user_id: string;
  tracking_mode: TrackingMode;
  active: number;
  created_at: number;
  updated_at: number;
}

const COLUMNS =
  "id, name, email, role, category_id, webauthn_user_id, tracking_mode, active, created_at, updated_at";

function toUser(r: UserRow): User {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    categoryId: r.category_id,
    webauthnUserId: r.webauthn_user_id,
    trackingMode: r.tracking_mode,
    active: r.active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export { NAME_MAX_LENGTH };

/** Trim and validate a display name. Throws with a user-presentable message. */
export function normalizeName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new UserInputError("Enter a name.");
  if (name.length > NAME_MAX_LENGTH) {
    throw new UserInputError(`Names are limited to ${NAME_MAX_LENGTH} characters.`);
  }
  return name;
}

/** An error whose message is safe and useful to show the person who caused it. */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserInputError";
  }
}

/** A fresh WebAuthn user handle: 32 random bytes, base64url. */
export function newWebauthnUserId(): string {
  return randomToken(32);
}

export function createUser(args: {
  name: string;
  role: Role;
  webauthnUserId?: string;
  actorUserId: number | null;
  now?: number;
}): User {
  const now = args.now ?? Date.now();
  const name = normalizeName(args.name);
  const row = db()
    .query<UserRow, [string, Role, string, number, number]>(
      `INSERT INTO users (name, role, webauthn_user_id, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)
       RETURNING ${COLUMNS}`,
    )
    .get(name, args.role, args.webauthnUserId ?? newWebauthnUserId(), now, now)!;
  const user = toUser(row);
  audit({
    actorUserId: args.actorUserId,
    entity: "user",
    entityId: user.id,
    action: "create",
    after: { name: user.name, role: user.role },
    at: now,
  });
  return user;
}

export function getUser(id: number): User | null {
  const row = db()
    .query<UserRow, [number]>(`SELECT ${COLUMNS} FROM users WHERE id = ?`)
    .get(id);
  return row ? toUser(row) : null;
}

export function countActiveAdmins(): number {
  return db()
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1",
    )
    .get()!.n;
}

export interface UserSummary extends User {
  passkeyCount: number;
  lastSeenAt: number | null;
}

/** Everyone, for the admin people list: active first, then by name. */
export function listUsers(): UserSummary[] {
  const rows = db()
    .query<UserRow & { passkey_count: number; last_seen_at: number | null }, []>(
      `SELECT ${COLUMNS.split(", ").map((c) => `u.${c}`).join(", ")},
              (SELECT COUNT(*) FROM credentials c WHERE c.user_id = u.id) AS passkey_count,
              (SELECT MAX(s.last_used_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
         FROM users u
        ORDER BY u.active DESC, u.name COLLATE NOCASE`,
    )
    .all();
  return rows.map((r) => ({
    ...toUser(r),
    passkeyCount: r.passkey_count,
    lastSeenAt: r.last_seen_at,
  }));
}

export function renameUser(args: { userId: number; name: string; actorUserId: number }): User {
  const user = mustGet(args.userId);
  const name = normalizeName(args.name);
  if (name === user.name) return user;
  db().query("UPDATE users SET name = ?, updated_at = ? WHERE id = ?").run(name, Date.now(), user.id);
  audit({
    actorUserId: args.actorUserId,
    entity: "user",
    entityId: user.id,
    action: "rename",
    before: { name: user.name },
    after: { name },
  });
  return mustGet(user.id);
}

/** How this person records time. Their own choice, so no admin is needed. */
export function setTrackingMode(args: { userId: number; mode: unknown; actorUserId: number }): User {
  const user = mustGet(args.userId);
  if (!isTrackingMode(args.mode)) throw new UserInputError("Pick timers or notes.");
  if (args.mode === user.trackingMode) return user;
  db().query("UPDATE users SET tracking_mode = ?, updated_at = ? WHERE id = ?").run(args.mode, Date.now(), user.id);
  audit({
    actorUserId: args.actorUserId,
    entity: "user",
    entityId: user.id,
    action: "tracking_mode",
    before: { trackingMode: user.trackingMode },
    after: { trackingMode: args.mode },
  });
  return mustGet(user.id);
}

/**
 * Change role and/or active state.
 *
 * Refuses anything that would leave the organisation with no active admin:
 * that state can only be escaped from a shell on the server, so the UI must
 * never be able to reach it.
 */
export function updateUserAccess(args: {
  userId: number;
  role?: Role;
  active?: boolean;
  actorUserId: number;
}): User {
  const database = db();
  return database.transaction(() => {
    const user = mustGet(args.userId);
    const role = args.role ?? user.role;
    const active = args.active ?? user.active;
    if (role === user.role && active === user.active) return user;

    const losesAdmin = user.role === "admin" && user.active && (role !== "admin" || !active);
    if (losesAdmin && countActiveAdmins() <= 1) {
      throw new UserInputError(
        "This is the only active admin. Make someone else an admin first.",
      );
    }

    database
      .query("UPDATE users SET role = ?, active = ?, updated_at = ? WHERE id = ?")
      .run(role, active ? 1 : 0, Date.now(), user.id);

    if (!active && user.active) {
      // A deactivated person must not stay signed in anywhere.
      database
        .query("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .run(Date.now(), user.id);
    }

    audit({
      actorUserId: args.actorUserId,
      entity: "user",
      entityId: user.id,
      action: "access",
      before: { role: user.role, active: user.active },
      after: { role, active },
    });
    return mustGet(user.id);
  })();
}

function mustGet(id: number): User {
  const user = getUser(id);
  if (!user) throw new UserInputError("That person no longer exists.");
  return user;
}
