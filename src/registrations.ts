import { audit } from "./audit.ts";
import { config } from "./config.server.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import { db } from "./db.server.ts";
import { type Role, UserInputError, countActiveAdmins, getUser } from "./users.ts";

/**
 * One-time registration links.
 *
 *   bootstrap   first admin, minted automatically while no admin exists
 *   invite      a new person, with the role an admin chose
 *   add_device  an existing person enrolling a passkey on a new device
 *
 * The token appears exactly once — in the URL handed to the person — and only
 * its SHA-256 is stored. A link is consumed when a passkey is actually
 * registered with it, never merely by being opened.
 */

export type RegistrationPurpose = "bootstrap" | "invite" | "add_device";

export interface Registration {
  id: number;
  purpose: RegistrationPurpose;
  role: Role;
  nameHint: string | null;
  /** add_device: the person the link is for. Otherwise: who used it. */
  userId: number | null;
  createdBy: number | null;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
}

interface RegistrationRow {
  id: number;
  purpose: RegistrationPurpose;
  role: Role;
  name_hint: string | null;
  user_id: number | null;
  created_by: number | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
}

const COLUMNS =
  "id, purpose, role, name_hint, user_id, created_by, created_at, expires_at, used_at, revoked_at";

function toRegistration(r: RegistrationRow): Registration {
  return {
    id: r.id,
    purpose: r.purpose,
    role: r.role,
    nameHint: r.name_hint,
    userId: r.user_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
    revokedAt: r.revoked_at,
  };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Lifetimes an admin can choose from, in the order the UI offers them. */
export const LINK_LIFETIMES = [
  { label: "1 hour", ms: HOUR },
  { label: "1 day", ms: DAY },
  { label: "7 days", ms: 7 * DAY },
  { label: "30 days", ms: 30 * DAY },
] as const;

export const DEFAULT_TTL: Record<RegistrationPurpose, number> = {
  // Reprinted on every start while unused, so it can afford to be generous.
  bootstrap: 7 * DAY,
  invite: 7 * DAY,
  // Grants access to an existing account: keep it short by default.
  add_device: DAY,
};

export function registrationUrl(token: string): string {
  return `${config.publicBaseUrl}/join/${token}`;
}

export function mintRegistration(args: {
  purpose: RegistrationPurpose;
  role?: Role;
  nameHint?: string | null;
  userId?: number | null;
  createdBy: number | null;
  ttlMs?: number;
  now?: number;
}): { token: string; url: string; registration: Registration } {
  const now = args.now ?? Date.now();
  const ttl = args.ttlMs ?? DEFAULT_TTL[args.purpose];
  if (!(ttl > 0) || ttl > 90 * DAY) throw new UserInputError("Pick a link lifetime.");

  let role: Role;
  let userId: number | null = null;
  if (args.purpose === "add_device") {
    const target = args.userId == null ? null : getUser(args.userId);
    if (!target) throw new UserInputError("That person no longer exists.");
    if (!target.active) {
      throw new UserInputError("Reactivate this person before giving them a device link.");
    }
    role = target.role;
    userId = target.id;
  } else {
    if (args.userId != null) throw new Error(`${args.purpose} links cannot target a user`);
    role = args.purpose === "bootstrap" ? "admin" : (args.role ?? "employee");
  }

  const nameHint = args.nameHint?.trim() ? args.nameHint.trim().slice(0, 80) : null;
  const token = randomToken(32);
  const row = db()
    .query<
      RegistrationRow,
      [string, RegistrationPurpose, Role, string | null, number | null, number | null, number, number]
    >(
      `INSERT INTO registrations
         (token_hash, purpose, role, name_hint, user_id, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${COLUMNS}`,
    )
    .get(sha256Hex(token), args.purpose, role, nameHint, userId, args.createdBy, now, now + ttl)!;

  const registration = toRegistration(row);
  audit({
    actorUserId: args.createdBy,
    entity: "registration",
    entityId: registration.id,
    action: "mint",
    after: { purpose: registration.purpose, role, nameHint, userId, expiresAt: registration.expiresAt },
    at: now,
  });
  return { token, url: registrationUrl(token), registration };
}

/**
 * The registration a token names, if it can still be used right now.
 * Returns null for unknown, used, revoked or expired links, for add_device
 * links whose person has since been deactivated, and for bootstrap links once
 * any admin exists — a setup link surviving setup would let anyone who can
 * read the server log make themselves an admin.
 */
export function findUsableRegistration(token: string, now: number = Date.now()): Registration | null {
  if (!token) return null;
  const row = db()
    .query<RegistrationRow, [string, number]>(
      `SELECT ${COLUMNS} FROM registrations
        WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    )
    .get(sha256Hex(token), now);
  if (!row) return null;
  const registration = toRegistration(row);
  if (registration.purpose === "bootstrap" && countActiveAdmins() > 0) return null;
  if (registration.purpose === "add_device") {
    const target = registration.userId == null ? null : getUser(registration.userId);
    if (!target?.active) return null;
  }
  return registration;
}

export function getRegistration(id: number): Registration | null {
  const row = db()
    .query<RegistrationRow, [number]>(`SELECT ${COLUMNS} FROM registrations WHERE id = ?`)
    .get(id);
  return row ? toRegistration(row) : null;
}

/**
 * Mark a registration used, atomically. Returns false if it was used, revoked
 * or expired in the meantime — e.g. the same link completed in two tabs — in
 * which case the caller must abandon the registration.
 */
export function consumeRegistration(args: { id: number; userId: number; now?: number }): boolean {
  const now = args.now ?? Date.now();
  const result = db()
    .query(
      `UPDATE registrations
          SET used_at = ?, user_id = COALESCE(user_id, ?)
        WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    )
    .run(now, args.userId, args.id, now);
  if (result.changes !== 1) return false;
  audit({
    actorUserId: args.userId,
    entity: "registration",
    entityId: args.id,
    action: "consume",
    after: { userId: args.userId },
    at: now,
  });
  return true;
}

export function revokeRegistration(args: { id: number; actorUserId: number | null; now?: number }): void {
  const now = args.now ?? Date.now();
  const result = db()
    .query("UPDATE registrations SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL")
    .run(now, args.id);
  if (result.changes === 1) {
    audit({ actorUserId: args.actorUserId, entity: "registration", entityId: args.id, action: "revoke", at: now });
  }
}

/** Revoke every unused bootstrap link. Returns how many were revoked. */
export function revokeUnusedBootstrapLinks(now: number = Date.now()): number {
  const ids = db()
    .query<{ id: number }, [number]>(
      `SELECT id FROM registrations
        WHERE purpose = 'bootstrap' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    )
    .all(now)
    .map((r) => r.id);
  for (const id of ids) revokeRegistration({ id, actorUserId: null, now });
  return ids.length;
}

export interface OpenRegistration extends Registration {
  createdByName: string | null;
  targetName: string | null;
}

/** Links that could still be used, newest first. */
export function listOpenRegistrations(now: number = Date.now()): OpenRegistration[] {
  return db()
    .query<RegistrationRow & { created_by_name: string | null; target_name: string | null }, [number]>(
      `SELECT ${COLUMNS.split(", ").map((c) => `r.${c}`).join(", ")},
              cb.name AS created_by_name, t.name AS target_name
         FROM registrations r
         LEFT JOIN users cb ON cb.id = r.created_by
         LEFT JOIN users t  ON t.id = r.user_id
        WHERE r.used_at IS NULL AND r.revoked_at IS NULL AND r.expires_at > ?
        ORDER BY r.created_at DESC`,
    )
    .all(now)
    .map((r) => ({
      ...toRegistration(r),
      createdByName: r.created_by_name,
      targetName: r.target_name,
    }));
}
