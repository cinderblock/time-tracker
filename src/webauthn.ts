import {
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

import { branding } from "./branding.ts";
import { config } from "./config.server.ts";
import { randomToken } from "./crypto.ts";
import type { Role } from "./users.ts";

/**
 * WebAuthn ceremonies (passkey registration and sign-in).
 *
 * Framework-agnostic: this module generates options and verifies responses.
 * Persisting users/credentials/sessions and setting cookies is the caller's
 * job, so the database writes can sit in one transaction with the checks that
 * guard them.
 */

// ---- relying party -----------------------------------------------------------

export interface RpParams {
  rpID: string;
  origin: string;
  rpName: string;
}

/**
 * Both the RP ID (bare hostname) and the expected origin come from
 * PUBLIC_BASE_URL. If that doesn't match how the browser actually reaches the
 * app, every ceremony fails with an opaque error — hence rpParams() is logged
 * alongside every verification failure.
 */
export function rpParams(): RpParams {
  const url = new URL(config.publicBaseUrl);
  return { rpID: url.hostname, origin: url.origin, rpName: branding().name };
}

// ---- ceremony store ------------------------------------------------------------

/**
 * A challenge must be generated and checked by the server, and used once. It
 * is held here, keyed by a random ceremony id that travels in a short-lived
 * cookie, rather than trusting the client to echo it back.
 *
 * In-memory is a deliberate choice: this app runs as one process, and a
 * challenge lost to a restart costs one extra tap. The map lives on globalThis
 * so Vite's SSR module re-evaluation doesn't drop in-flight ceremonies in
 * development.
 */
export const CEREMONY_TTL_MS = 5 * 60 * 1000;

export interface NewUserPlan {
  name: string;
  role: Role;
  webauthnUserId: string;
}

export type Ceremony =
  | {
      kind: "register";
      challenge: string;
      /** The one-time link being redeemed, if any. */
      registrationId: number | null;
      /** Existing person gaining a passkey (add_device, or signed-in "add"). */
      userId: number | null;
      /** Person to create on success (bootstrap / invite). */
      newUser: NewUserPlan | null;
      expiresAt: number;
    }
  | { kind: "authenticate"; challenge: string; expiresAt: number };

type CeremonyInput =
  | Omit<Extract<Ceremony, { kind: "register" }>, "expiresAt">
  | Omit<Extract<Ceremony, { kind: "authenticate" }>, "expiresAt">;

type GlobalWithCeremonies = typeof globalThis & {
  __timeTrackerCeremonies__?: Map<string, Ceremony>;
};

function store(): Map<string, Ceremony> {
  const g = globalThis as GlobalWithCeremonies;
  g.__timeTrackerCeremonies__ ??= new Map();
  return g.__timeTrackerCeremonies__;
}

function sweep(now: number): void {
  for (const [id, c] of store()) if (c.expiresAt <= now) store().delete(id);
}

export function putCeremony(data: CeremonyInput, now: number = Date.now()): string {
  sweep(now);
  const id = randomToken(18);
  store().set(id, { ...data, expiresAt: now + CEREMONY_TTL_MS } as Ceremony);
  return id;
}

/** Remove and return a ceremony. Null if unknown or expired. Single-use. */
export function takeCeremony(id: string | null | undefined, now: number = Date.now()): Ceremony | null {
  if (!id) return null;
  const ceremony = store().get(id);
  store().delete(id);
  sweep(now);
  return ceremony && ceremony.expiresAt > now ? ceremony : null;
}

// ---- helpers -------------------------------------------------------------------

/** Decode base64url into a Uint8Array backed by its own ArrayBuffer. */
export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(value, "base64url");
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

export interface ExistingPasskey {
  credentialId: string;
  transports: readonly string[];
}

// ---- registration --------------------------------------------------------------

export async function beginRegistration(args: {
  webauthnUserId: string;
  userName: string;
  /** The person's current passkeys, so the same authenticator isn't enrolled twice. */
  existing: readonly ExistingPasskey[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { rpID, rpName } = rpParams();
  return generateRegistrationOptions({
    rpName,
    rpID,
    userName: args.userName,
    userDisplayName: args.userName,
    userID: fromBase64url(args.webauthnUserId),
    attestationType: "none",
    excludeCredentials: args.existing.map((c) => ({
      id: c.credentialId,
      transports: [...c.transports],
    })),
    // A discoverable credential with user verification is what makes this a
    // passkey: Face ID / Touch ID / Windows Hello, and no username at sign-in.
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
}

export interface VerifiedRegistration {
  credential: WebAuthnCredential;
  deviceType: string;
  backedUp: boolean;
}

/** Verify an attestation. Null (and a log line) on any failure. */
export async function finishRegistration(args: {
  challenge: string;
  response: RegistrationResponseJSON;
}): Promise<VerifiedRegistration | null> {
  const rp = rpParams();
  try {
    const result = await verifyRegistrationResponse({
      response: args.response,
      expectedChallenge: args.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
    if (!result.verified) return null;
    const info = result.registrationInfo;
    return {
      credential: info.credential,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    };
  } catch (err) {
    console.error("[webauthn] registration verification failed", rp, err);
    return null;
  }
}

// ---- authentication ------------------------------------------------------------

export async function beginAuthentication(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  // No allowCredentials: the browser offers any passkey it holds for this RP.
  return generateAuthenticationOptions({
    rpID: rpParams().rpID,
    userVerification: "required",
  });
}

/** Verify an assertion against a stored passkey. Returns the new counter, or null. */
export async function finishAuthentication(args: {
  challenge: string;
  response: AuthenticationResponseJSON;
  credential: WebAuthnCredential;
}): Promise<{ newCounter: number } | null> {
  const rp = rpParams();
  try {
    const result = await verifyAuthenticationResponse({
      response: args.response,
      expectedChallenge: args.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: args.credential,
      requireUserVerification: true,
    });
    return result.verified ? { newCounter: result.authenticationInfo.newCounter } : null;
  } catch (err) {
    console.error("[webauthn] authentication verification failed", rp, err);
    return null;
  }
}
