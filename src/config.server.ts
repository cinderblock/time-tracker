import { createECDH } from "node:crypto";

/**
 * Runtime configuration, read once from the environment.
 *
 * Deliberately free of any deployment-specific default: this repo ships as a
 * generic self-hostable time tracker, and every company name, hostname, colour
 * and credential arrives from the environment. If you find yourself wanting to
 * write an organisation's name in here, it belongs in that deployment's env
 * file instead. See plans/time-tracker.md ("Things not to do").
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/** Backends the app can push approved time into. */
export type AccountingBackendKind = "none" | "qb-bridge" | "qb-webconnector";

const backendKinds: readonly AccountingBackendKind[] = ["none", "qb-bridge", "qb-webconnector"];

function backendKind(): AccountingBackendKind {
  const raw = process.env.ACCOUNTING_BACKEND ?? "none";
  if (!backendKinds.includes(raw as AccountingBackendKind)) {
    throw new Error(
      `ACCOUNTING_BACKEND must be one of ${backendKinds.join(", ")} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw as AccountingBackendKind;
}

function nonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number of seconds (got ${JSON.stringify(raw)})`);
  return value;
}

/**
 * PUBLIC_BASE_URL must be exactly the origin browsers see — scheme and host,
 * no path, no trailing slash, no default port, lower case — because passkeys
 * are bound to it and a near miss fails as an opaque browser error.
 */
export function publicOrigin(raw: string): string {
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    // reported below
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== raw) {
    throw new Error(
      `PUBLIC_BASE_URL must be just the origin, like https://time.example.com — no path or trailing slash (got ${JSON.stringify(raw)})`,
    );
  }
  return raw;
}

function vapidSubject(raw: string): string | null {
  return /^(https:\/\/|mailto:)\S+$/.test(raw) ? raw : null;
}

/**
 * The VAPID key pair, from the private key alone if need be: the public key is
 * derived from it, so a deployment can generate one random 32-byte secret and
 * nothing else. A public key given alongside must be the private key's own —
 * a mismatched pair is refused every message by every push service.
 */
export function vapidKeys(
  publicRaw: string | undefined,
  privateRaw: string | undefined,
): { publicKey: string; privateKey: string } | { problem: string } | null {
  if (!privateRaw) return publicRaw ? { problem: "VAPID_PUBLIC_KEY is set without VAPID_PRIVATE_KEY" } : null;
  const secret = Buffer.from(privateRaw, "base64url");
  if (secret.length !== 32) return { problem: "VAPID_PRIVATE_KEY must be 32 bytes, base64url-encoded" };
  let derived: string;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(secret);
    derived = ecdh.getPublicKey("base64url");
  } catch {
    return { problem: "VAPID_PRIVATE_KEY isn't a valid P-256 private key" };
  }
  if (publicRaw && publicRaw !== derived) {
    return { problem: "VAPID_PUBLIC_KEY doesn't belong to VAPID_PRIVATE_KEY (leave it unset; it's derived)" };
  }
  // Re-encoded, so a generated value with spare trailing bits reads canonically.
  return { publicKey: derived, privateKey: secret.toString("base64url") };
}

const vapid = vapidKeys(process.env.VAPID_PUBLIC_KEY || undefined, process.env.VAPID_PRIVATE_KEY || undefined);

function currencyCode(raw: string): string {
  const code = raw.trim().toUpperCase();
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency: code });
  } catch {
    throw new Error(`APP_CURRENCY must be an ISO 4217 code like USD (got ${JSON.stringify(raw)})`);
  }
  return code;
}

export const config = {
  /**
   * Branding. All user-visible naming comes from here so the same image can be
   * deployed for any organisation. Defaults are generic on purpose.
   */
  branding: {
    name: process.env.APP_NAME ?? "Time Tracker",
    shortName: process.env.APP_SHORT_NAME ?? "Time",
    /** Any CSS colour; drives the Mantine theme and the PWA manifest. */
    themeColor: process.env.APP_THEME_COLOR ?? "#1c7ed6",
  },

  /**
   * Public origin the app is served from. Load-bearing beyond cosmetics: it is
   * the WebAuthn Relying Party origin and the base for one-time invite URLs, so
   * a wrong value silently breaks passkey registration.
   */
  publicBaseUrl: publicOrigin(required("PUBLIC_BASE_URL")),

  /** Where the SQLite file lives. The container bind-mounts /data. */
  databasePath: process.env.DATABASE_PATH ?? "./data/time-tracker.db",

  port: Number(process.env.PORT ?? 3000),

  /**
   * The timezone all "what day is this work on?" decisions are made in.
   * Load-bearing: a time entry's `work_date` and the daily note rollup are
   * wall-clock concepts, and QuickBooks stores a date with no zone. Getting
   * this wrong books evening work onto the wrong day.
   */
  timezone: process.env.TZ ?? "UTC",

  /** ISO 4217 code that rates and costs are shown in. Display only; nothing is converted. */
  currency: currencyCode(process.env.APP_CURRENCY ?? "USD"),

  accounting: {
    kind: backendKind(),
    /**
     * QB Bridge base URL. Use the IPv4 literal — the bridge rejects non-private
     * source addresses with 403 before it checks the key, and a hostname that
     * resolves to public IPv6 makes that look like an auth failure.
     */
    bridgeBaseUrl: process.env.QB_BRIDGE_URL ?? null,
    bridgeApiKey: process.env.QB_BRIDGE_API_KEY ?? null,
    /**
     * How often approved time is sent through the bridge, in seconds. 0 turns
     * the automatic loop off: time goes only when an admin presses Send now.
     */
    syncEverySeconds: nonNegativeInt("ACCOUNTING_SYNC_EVERY_SECONDS", 60),
    /** Credentials the QuickBooks Web Connector authenticates with. */
    webConnectorUsername: process.env.QBWC_USERNAME || "time-tracker",
    webConnectorPassword: process.env.QBWC_PASSWORD || null,
  },

  push: {
    // Web Push (VAPID). Optional and fail-soft: with no usable key, push is
    // disabled — the account page says so and the server never sends.
    vapidPublicKey: vapid && "publicKey" in vapid ? vapid.publicKey : null,
    vapidPrivateKey: vapid && "privateKey" in vapid ? vapid.privateKey : null,
    /** Why the keys given can't be used, for the startup log. */
    vapidProblem: vapid && "problem" in vapid ? vapid.problem : null,
    /**
     * Who push services contact about this sender: a mailto: or https: URL
     * (anything else, and they refuse every message). Defaults to the site's
     * own address when that is https, so no one's email goes to them; null
     * means push is off, and the startup log says why.
     */
    vapidSubject: vapidSubject(process.env.VAPID_SUBJECT || process.env.PUBLIC_BASE_URL || ""),
    /** How often reminders are checked for, in seconds. 0 turns them off (tests still send). */
    checkEverySeconds: nonNegativeInt("NOTIFY_EVERY_SECONDS", 60),
  },

  /**
   * Secret used to sign session cookies. Required — there is no safe default,
   * and a generated-at-boot fallback would silently log everyone out on every
   * deploy.
   */
  sessionSecret: required("SESSION_SECRET"),
} as const;

/**
 * The resolved settings that aren't secret, for the log at startup. TZ in
 * particular can be inherited from wherever the container runs, and a wrong
 * one books evening work onto the next day — better seen in the log than at
 * payroll.
 */
export function describeConfig(): string {
  const a = config.accounting;
  const lines = [
    "Configuration:",
    `  PUBLIC_BASE_URL     ${config.publicBaseUrl}`,
    `  TZ                  ${config.timezone}`,
    `  APP_CURRENCY        ${config.currency}`,
    `  ACCOUNTING_BACKEND  ${a.kind}`,
  ];
  if (a.kind === "qb-bridge") lines.push(`  QB_BRIDGE_URL       ${a.bridgeBaseUrl ?? "(unset)"}`);
  if (a.kind === "qb-webconnector") lines.push(`  QBWC_USERNAME       ${a.webConnectorUsername}`);
  const p = config.push;
  lines.push(
    `  web push            ${
      p.vapidProblem
        ? `OFF — ${p.vapidProblem}`
        : !p.vapidPrivateKey
          ? "off (no VAPID_PRIVATE_KEY)"
          : !p.vapidSubject
            ? "OFF — VAPID_SUBJECT must be an https: or mailto: URL (PUBLIC_BASE_URL is used when it is https)"
            : `on, reminders ${p.checkEverySeconds ? `checked every ${p.checkEverySeconds}s` : "off"}`
    }`,
  );
  return lines.join("\n");
}

/** True when the configured accounting backend has the credentials it needs. */
export function accountingConfigured(): boolean {
  switch (config.accounting.kind) {
    case "none":
      return true;
    case "qb-bridge":
      return Boolean(config.accounting.bridgeBaseUrl && config.accounting.bridgeApiKey);
    case "qb-webconnector":
      return Boolean(config.accounting.webConnectorPassword);
  }
}

// A deployment that asked for QuickBooks and quietly got nothing would look
// fine right up until payroll, so it doesn't start — like a missing
// PUBLIC_BASE_URL or SESSION_SECRET.
if (!accountingConfigured()) {
  const needs = config.accounting.kind === "qb-bridge" ? "QB_BRIDGE_URL and QB_BRIDGE_API_KEY" : "QBWC_PASSWORD";
  throw new Error(`ACCOUNTING_BACKEND=${config.accounting.kind} needs ${needs}.`);
}
