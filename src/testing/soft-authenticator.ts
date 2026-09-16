import { type KeyObject, createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

/**
 * A software passkey authenticator for tests.
 *
 * Produces genuine WebAuthn responses — a P-256 key pair, a CBOR "none"
 * attestation, ECDSA-signed assertions — that SimpleWebAuthn verifies exactly
 * as it would a phone's. That lets the enrollment and sign-in flows, including
 * their transactional edge cases, be tested without a browser.
 *
 * Test-only. Excluded from the container image by .dockerignore.
 */

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string) => new Uint8Array(createHash("sha256").update(data).digest());

// ---- minimal CBOR encoder (just what attestation objects need) -----------------

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function cborHead(major: number, n: number): number[] {
  const m = major << 5;
  if (n < 24) return [m | n];
  if (n < 0x100) return [m | 24, n];
  if (n < 0x10000) return [m | 25, n >> 8, n & 0xff];
  return [m | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function cbor(value: Cbor): Uint8Array {
  const out: number[] = [];
  const write = (v: Cbor): void => {
    if (typeof v === "number") {
      out.push(...(v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v)));
    } else if (typeof v === "string") {
      const bytes = new TextEncoder().encode(v);
      out.push(...cborHead(3, bytes.length), ...bytes);
    } else if (v instanceof Uint8Array) {
      out.push(...cborHead(2, v.length), ...v);
    } else {
      out.push(...cborHead(5, v.size));
      for (const [k, val] of v) {
        write(k);
        write(val);
      }
    }
  };
  write(value);
  return new Uint8Array(out);
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

const u32 = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);

// Flags: UP user present, UV user verified, AT attested credential data.
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export class SoftAuthenticator {
  readonly credentialId = new Uint8Array(randomBytes(32));
  private readonly privateKey: KeyObject;
  private readonly cosePublicKey: Uint8Array;
  private signCount = 0;
  /** The user handle this passkey was created for (discoverable credential). */
  userHandle: string | null = null;

  constructor(private readonly origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.cosePublicKey = cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
        [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
      ]),
    );
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  private clientData(type: "webauthn.create" | "webauthn.get", challenge: string): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }),
    );
  }

  /** Answer navigator.credentials.create() for the given options. */
  register(options: PublicKeyCredentialCreationOptionsJSON): RegistrationResponseJSON {
    this.userHandle = options.user.id;
    const authData = concat(
      sha256(options.rp.id!),
      new Uint8Array([FLAG_UP | FLAG_UV | FLAG_AT]),
      u32(this.signCount),
      new Uint8Array(16), // AAGUID: all zeros, as a "none" attestation permits
      new Uint8Array([this.credentialId.length >> 8, this.credentialId.length & 0xff]),
      this.credentialId,
      this.cosePublicKey,
    );
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(this.clientData("webauthn.create", options.challenge)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** Answer navigator.credentials.get() for the given options. */
  authenticate(
    options: PublicKeyCredentialRequestOptionsJSON,
    rpID = new URL(this.origin).hostname,
  ): AuthenticationResponseJSON {
    this.signCount += 1;
    const authData = concat(sha256(rpID), new Uint8Array([FLAG_UP | FLAG_UV]), u32(this.signCount));
    const clientDataJSON = this.clientData("webauthn.get", options.challenge);
    const signature = sign("sha256", concat(authData, sha256(clientDataJSON)), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(new Uint8Array(signature)),
        userHandle: this.userHandle ?? undefined,
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
