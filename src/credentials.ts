import { audit } from "./audit.ts";
import { db } from "./db.server.ts";
import { NICKNAME_MAX_LENGTH } from "./limits.ts";
import { UserInputError } from "./users.ts";

/** A stored passkey. The public key never leaves the server module layer. */
export interface Credential {
  id: number;
  userId: number;
  credentialId: string;
  counter: number;
  transports: string[];
  deviceType: string | null;
  backedUp: boolean;
  nickname: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface CredentialRow {
  id: number;
  user_id: number;
  credential_id: string;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  nickname: string;
  created_at: number;
  last_used_at: number | null;
}

const COLUMNS =
  "id, user_id, credential_id, counter, transports, device_type, backed_up, nickname, created_at, last_used_at";

function parseTransports(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function toCredential(r: CredentialRow): Credential {
  return {
    id: r.id,
    userId: r.user_id,
    credentialId: r.credential_id,
    counter: r.counter,
    transports: parseTransports(r.transports),
    deviceType: r.device_type,
    backedUp: r.backed_up === 1,
    nickname: r.nickname,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

export { NICKNAME_MAX_LENGTH };

function normalizeNickname(raw: unknown): string {
  const nickname = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!nickname) throw new UserInputError("Give the passkey a name.");
  return nickname.slice(0, NICKNAME_MAX_LENGTH);
}

export function addCredential(args: {
  userId: number;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: readonly string[] | undefined;
  deviceType: string;
  backedUp: boolean;
  nickname: string;
  /** Set when registering also signed the person in. */
  lastUsedAt?: number | null;
  now?: number;
}): Credential {
  const now = args.now ?? Date.now();
  const nickname = normalizeNickname(args.nickname);
  const row = db()
    .query<
      CredentialRow,
      [number, string, Uint8Array, number, string, string, number, string, number, number | null]
    >(
      `INSERT INTO credentials
         (user_id, credential_id, public_key, counter, transports, device_type,
          backed_up, nickname, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${COLUMNS}`,
    )
    .get(
      args.userId,
      args.credentialId,
      args.publicKey,
      args.counter,
      JSON.stringify(args.transports ?? []),
      args.deviceType,
      args.backedUp ? 1 : 0,
      nickname,
      now,
      args.lastUsedAt ?? null,
    )!;
  const credential = toCredential(row);
  audit({
    actorUserId: args.userId,
    entity: "credential",
    entityId: credential.id,
    action: "add",
    after: { userId: args.userId, nickname, backedUp: args.backedUp },
    at: now,
  });
  return credential;
}

export function listCredentials(userId: number): Credential[] {
  return db()
    .query<CredentialRow, [number]>(
      `SELECT ${COLUMNS} FROM credentials WHERE user_id = ? ORDER BY created_at`,
    )
    .all(userId)
    .map(toCredential);
}

/** Look up a passkey by its WebAuthn id, with the public key for verification. */
export function findCredentialForVerification(
  credentialId: string,
): (Credential & { publicKey: Uint8Array<ArrayBuffer> }) | null {
  const row = db()
    .query<CredentialRow & { public_key: Uint8Array }, [string]>(
      `SELECT ${COLUMNS}, public_key FROM credentials WHERE credential_id = ?`,
    )
    .get(credentialId);
  if (!row) return null;
  // Copy into a fresh ArrayBuffer-backed array: SimpleWebAuthn's types insist
  // on Uint8Array<ArrayBuffer>, and SQLite hands back a view it owns.
  const publicKey = new Uint8Array(row.public_key.byteLength);
  publicKey.set(row.public_key);
  return { ...toCredential(row), publicKey };
}

export function recordCredentialUse(args: { id: number; counter: number; now?: number }): void {
  db()
    .query("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?")
    .run(args.counter, args.now ?? Date.now(), args.id);
}

export function renameCredential(args: {
  id: number;
  userId: number;
  nickname: string;
  actorUserId: number;
}): void {
  const nickname = normalizeNickname(args.nickname);
  const existing = mustOwn(args.id, args.userId);
  if (existing.nickname === nickname) return;
  db().query("UPDATE credentials SET nickname = ? WHERE id = ?").run(nickname, args.id);
  audit({
    actorUserId: args.actorUserId,
    entity: "credential",
    entityId: args.id,
    action: "rename",
    before: { nickname: existing.nickname },
    after: { nickname },
  });
}

/**
 * Remove a passkey.
 *
 * A person removing their own last passkey is refused: that is a lockout, and
 * the recovery path (an admin minting an add_device link) exists for exactly
 * the case where they genuinely have no device left. Admins acting on someone
 * else may remove the last one — that is how a lost phone is cut off.
 */
export function removeCredential(args: {
  id: number;
  userId: number;
  actorUserId: number;
}): Credential {
  const database = db();
  return database.transaction(() => {
    const existing = mustOwn(args.id, args.userId);
    const isSelf = args.actorUserId === args.userId;
    if (isSelf && listCredentials(args.userId).length <= 1) {
      throw new UserInputError(
        "This is your only passkey — removing it would lock you out. Add another first.",
      );
    }
    database.query("DELETE FROM credentials WHERE id = ?").run(args.id);
    audit({
      actorUserId: args.actorUserId,
      entity: "credential",
      entityId: args.id,
      action: "remove",
      before: { userId: args.userId, nickname: existing.nickname },
    });
    return existing;
  })();
}

function mustOwn(id: number, userId: number): Credential {
  const row = db()
    .query<CredentialRow, [number, number]>(
      `SELECT ${COLUMNS} FROM credentials WHERE id = ? AND user_id = ?`,
    )
    .get(id, userId);
  if (!row) throw new UserInputError("That passkey no longer exists.");
  return toCredential(row);
}
