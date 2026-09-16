import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the real production build, driven through
 * Chromium with a CDP virtual authenticator standing in for Face ID.
 *
 * Every run gets a fresh database. The path is fixed in the environment once,
 * by the main process, so worker processes (which re-evaluate this file and
 * inherit the environment) agree with the server about where it is — the tests
 * use it to mint the first-admin link through `bun run admin-link`.
 */
const PORT = Number(process.env.E2E_PORT ?? 3140);
process.env.E2E_DATABASE_PATH ??= join(tmpdir(), `time-tracker-e2e-${process.pid}-${Date.now()}.db`);

export const e2eEnv = {
  PORT: String(PORT),
  PUBLIC_BASE_URL: `http://localhost:${PORT}`,
  SESSION_SECRET: "e2e-only-session-secret",
  DATABASE_PATH: process.env.E2E_DATABASE_PATH,
  APP_NAME: "E2E Time",
  TZ: "America/Los_Angeles",
  ACCOUNTING_BACKEND: "none",
};

export default defineConfig({
  testDir: "./e2e",
  // The flows share one database and build on each other's state.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: e2eEnv.PUBLIC_BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run start",
    url: `${e2eEnv.PUBLIC_BASE_URL}/signin`,
    env: e2eEnv,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
  },
});
