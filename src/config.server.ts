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
  publicBaseUrl: required("PUBLIC_BASE_URL"),

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
    // Web Push (VAPID). Optional and fail-soft: with either key unset, push is
    // disabled — the client hides the toggle and the server never sends.
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || null,
    vapidSubject: process.env.VAPID_SUBJECT || null,
  },

  /**
   * Secret used to sign session cookies. Required — there is no safe default,
   * and a generated-at-boot fallback would silently log everyone out on every
   * deploy.
   */
  sessionSecret: required("SESSION_SECRET"),
} as const;

/** True when the configured accounting backend needs network credentials. */
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
