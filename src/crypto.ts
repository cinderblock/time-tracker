import { createHash, randomBytes } from "node:crypto";

/** A URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * SHA-256, hex. Used to store bearer tokens (session cookies, registration
 * links) so that reading the database is not enough to use one.
 *
 * A plain hash is sufficient here — unlike passwords, these tokens carry 256
 * bits of entropy, so there is nothing for a slow KDF to protect.
 */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
