import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";
import webpush from "web-push";

/**
 * End-to-end tests against the real production build, driven through
 * Chromium with a CDP virtual authenticator standing in for Face ID.
 *
 * Three copies of the app run, each with a fresh database:
 *   - standalone (no accounting system): auth, tracking, offline, admin
 *   - QuickBooks through a pretend QB Bridge (e2e/fake-bridge-server.ts)
 *   - QuickBooks through the Web Connector, driven by SOAP calls
 *
 * The standalone copy also sends Web Push, to a pretend push service
 * (e2e/fake-push-server.ts).
 *
 * Database paths are fixed in the environment once, by the main process, so
 * worker processes (which re-evaluate this file and inherit the environment)
 * agree with the servers about where they are — the tests use them to mint
 * first-admin links through `bun run admin-link`.
 */
const PORT = Number(process.env.E2E_PORT ?? 3140);
const BRIDGE_PORT = PORT + 1;
const BRIDGE_APP_PORT = PORT + 2;
const QBWC_APP_PORT = PORT + 3;
const PROXIED_APP_PORT = PORT + 4;
const PUSH_PORT = PORT + 5;

const stamp = `${process.pid}-${Date.now()}`;
process.env.E2E_DATABASE_PATH ??= join(tmpdir(), `time-tracker-e2e-${stamp}.db`);
process.env.E2E_BRIDGE_DATABASE_PATH ??= join(tmpdir(), `time-tracker-e2e-bridge-${stamp}.db`);
process.env.E2E_QBWC_DATABASE_PATH ??= join(tmpdir(), `time-tracker-e2e-qbwc-${stamp}.db`);
process.env.E2E_PROXIED_DATABASE_PATH ??= join(tmpdir(), `time-tracker-e2e-proxied-${stamp}.db`);
// Made once in the main process, like the paths above, so every process agrees.
if (!process.env.E2E_VAPID_PUBLIC_KEY) {
  const keys = webpush.generateVAPIDKeys();
  process.env.E2E_VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.E2E_VAPID_PRIVATE_KEY = keys.privateKey;
}

const common = {
  SESSION_SECRET: "e2e-only-session-secret",
  TZ: "America/Los_Angeles",
};

export const e2eEnv = {
  ...common,
  PORT: String(PORT),
  PUBLIC_BASE_URL: `http://localhost:${PORT}`,
  DATABASE_PATH: process.env.E2E_DATABASE_PATH,
  APP_NAME: "E2E Time",
  ACCOUNTING_BACKEND: "none",
  // The private key alone, as a deployment gives it: the public key is derived.
  VAPID_PRIVATE_KEY: process.env.E2E_VAPID_PRIVATE_KEY,
  // The site address is http here, which push services won't take as a contact.
  VAPID_SUBJECT: "mailto:push-e2e@example.invalid",
  // Tests send on demand (the test button); no reminders behind their backs.
  NOTIFY_EVERY_SECONDS: "0",
  // The pretend push service's certificate is self-signed.
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
};

export const fakePushUrl = `https://127.0.0.1:${PUSH_PORT}`;

export const fakeBridgeUrl = `http://127.0.0.1:${BRIDGE_PORT}`;

export const bridgeEnv = {
  ...common,
  PORT: String(BRIDGE_APP_PORT),
  PUBLIC_BASE_URL: `http://localhost:${BRIDGE_APP_PORT}`,
  DATABASE_PATH: process.env.E2E_BRIDGE_DATABASE_PATH,
  APP_NAME: "E2E Books",
  ACCOUNTING_BACKEND: "qb-bridge",
  QB_BRIDGE_URL: fakeBridgeUrl,
  QB_BRIDGE_API_KEY: "e2e-bridge-key",
  // Tests send on demand, so nothing happens behind their backs.
  ACCOUNTING_SYNC_EVERY_SECONDS: "0",
};

export const qbwcEnv = {
  ...common,
  PORT: String(QBWC_APP_PORT),
  PUBLIC_BASE_URL: `http://localhost:${QBWC_APP_PORT}`,
  DATABASE_PATH: process.env.E2E_QBWC_DATABASE_PATH,
  APP_NAME: "E2E Connector",
  ACCOUNTING_BACKEND: "qb-webconnector",
  QBWC_USERNAME: "e2e-qbwc",
  QBWC_PASSWORD: "e2e-qbwc-password",
};

/**
 * An instance that believes it is served as https://proxied.test — the way a
 * deployment behind a TLS-terminating reverse proxy sees itself — while it
 * actually listens on plain http here. Only e2e/proxied.spec.ts talks to it,
 * with hand-made requests carrying the proxy's headers.
 */
export const proxiedListenUrl = `http://localhost:${PROXIED_APP_PORT}`;
export const proxiedEnv = {
  ...common,
  PORT: String(PROXIED_APP_PORT),
  PUBLIC_BASE_URL: "https://proxied.test",
  DATABASE_PATH: process.env.E2E_PROXIED_DATABASE_PATH,
  APP_NAME: "E2E Proxied",
  ACCOUNTING_BACKEND: "none",
};

const app = (env: Record<string, string | undefined>, listenUrl = env.PUBLIC_BASE_URL) => ({
  command: "bun run start",
  url: `${listenUrl}/signin`,
  env: env as Record<string, string>,
  reuseExistingServer: false,
  timeout: 60_000,
  stdout: "pipe" as const,
});

export default defineConfig({
  testDir: "./e2e",
  // The flows share one database per app and build on each other's state.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      testIgnore: /(accounting|webconnector|proxied)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: e2eEnv.PUBLIC_BASE_URL },
    },
    {
      name: "qb-bridge",
      testMatch: /accounting\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: bridgeEnv.PUBLIC_BASE_URL },
    },
    {
      name: "qb-webconnector",
      testMatch: /webconnector\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: qbwcEnv.PUBLIC_BASE_URL },
    },
    {
      // Plain requests, no browser: the point is which layer answers.
      name: "proxied",
      testMatch: /proxied\.spec\.ts/,
    },
  ],
  webServer: [
    app(e2eEnv),
    {
      command: "bun e2e/fake-push-server.ts",
      url: `${fakePushUrl}/__test/received`,
      ignoreHTTPSErrors: true,
      env: { PORT: String(PUSH_PORT) },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "bun e2e/fake-bridge-server.ts",
      url: `${fakeBridgeUrl}/__test/state`,
      env: { PORT: String(BRIDGE_PORT), QB_BRIDGE_API_KEY: bridgeEnv.QB_BRIDGE_API_KEY },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    app(bridgeEnv),
    app(qbwcEnv),
    app(proxiedEnv, proxiedListenUrl),
  ],
});
