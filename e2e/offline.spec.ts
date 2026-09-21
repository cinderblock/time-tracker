import { execFileSync } from "node:child_process";

import { type Browser, type BrowserContext, type Locator, type Page, expect, test } from "@playwright/test";

import { e2eEnv } from "../playwright.config.ts";

/**
 * Offline, in a real browser with the real service worker: tracking with no
 * connection, relaunching the app offline, the app being down while the
 * network is up, and a change made offline that the server later refuses.
 */
test.describe.configure({ mode: "serial" });

let ctx: BrowserContext;
let page: Page;

async function signUp(browser: Browser, name: string) {
  const context = await browser.newContext();
  const p = await context.newPage();
  const cdp = await context.newCDPSession(p);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const url = execFileSync("bun", ["src/cli/admin-link.ts"], {
    env: { ...process.env, ...e2eEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .trim()
    .split(/\r?\n/)
    .pop()!;
  await p.goto(url);
  await p.getByLabel("Your name").fill(name);
  await p.getByRole("button", { name: "Create passkey" }).click();
  await expect(p.getByRole("banner").getByText(name)).toBeVisible();
  return { context, page: p };
}

async function pickJob(input: Locator, name: string) {
  await input.click();
  await input.fill(name);
  await page.getByRole("option", { name, exact: true }).click();
}

const timerCard = () => page.locator(".mantine-Card-root", { has: page.getByRole("button", { name: "Stop" }) });
// Not a job's notes section, whose rows open for editing the same way.
const entryRows = () =>
  page.locator(".mantine-Card-root:not([role='group'])", { has: page.getByRole("button", { name: /^Edit / }) });
// The header, where the sync status appears. (The person here is called
// "Olive Offline", so match status text precisely, not on the word "Offline".)
const syncBadge = () => page.getByRole("banner");

test.afterAll(async () => {
  await ctx?.close();
});

test("set up, and let the service worker take over", async ({ browser }) => {
  ({ context: ctx, page } = await signUp(browser, "Olive Offline"));
  await page.goto("/admin/jobs");
  await page.getByLabel("New customer").fill("Delta");
  await page.getByRole("button", { name: "Add customer" }).click();
  const customer = page.getByRole("group", { name: "Delta", exact: true });
  await customer.getByRole("button", { name: "Add a job" }).click();
  await customer.getByLabel("New job for Delta").fill("Delta Dock");
  await customer.getByRole("button", { name: "Add job", exact: true }).click();
  await expect(page.getByRole("group", { name: "Delta › Delta Dock" })).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start a timer" })).toBeVisible();
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15_000 });
  // One more online load of Today, so the worker keeps a copy of it.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Start a timer" })).toBeVisible();
});

test("with no connection, tracking still works and changes wait on the device", async () => {
  await ctx.setOffline(true);

  await pickJob(page.getByPlaceholder("Any job — type to search"), "Delta Dock");
  await expect(timerCard().getByRole("heading", { name: "Delta Dock" })).toBeVisible();
  await expect(syncBadge().getByText("Offline · 1 to sync")).toBeVisible();

  await timerCard().getByRole("button", { name: "Pause" }).click();
  await expect(timerCard().getByText("paused", { exact: true })).toBeVisible();
  await expect(syncBadge().getByText("Offline · 2 to sync")).toBeVisible();
});

test("the app relaunches offline, with the unsynced changes still there", async () => {
  await page.reload();
  await expect(page.getByText("Showing the copy saved on this device")).toBeVisible();
  await expect(timerCard().getByRole("heading", { name: "Delta Dock" })).toBeVisible();
  await expect(timerCard().getByText("paused", { exact: true })).toBeVisible();
  await expect(syncBadge().getByText("Offline · 2 to sync")).toBeVisible();

  await timerCard().getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("heading", { name: "Start a timer" })).toBeVisible();
  await expect(entryRows().filter({ hasText: "Delta Dock" })).toHaveCount(1);
  await expect(syncBadge().getByText("Offline · 3 to sync")).toBeVisible();
});

test("a day never opened on this device says so, and still takes time", async () => {
  await page.getByRole("link", { name: "Previous day" }).click();
  await expect(page.getByText("Offline — this day isn't on this device")).toBeVisible();
  // It doesn't claim the day is empty — it doesn't know.
  await expect(page.getByText("Time saved for this day isn't on this device.")).toBeVisible();
  await expect(page.getByText("Nothing recorded for this day yet.")).toHaveCount(0);
  await page.getByRole("link", { name: "Back to today" }).click();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
});

test("back online, everything syncs and the screen matches the server", async () => {
  await ctx.setOffline(false);
  await expect(syncBadge().getByText(/\d+ to sync/)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("Showing the copy saved on this device")).toHaveCount(0, { timeout: 30_000 });

  // A fresh load straight from the server shows the same thing.
  await page.reload();
  await expect(entryRows().filter({ hasText: "Delta Dock" })).toHaveCount(1);
  await expect(page.getByText("Showing the copy saved on this device")).toHaveCount(0);
});

test("when the app itself is down, changes wait and go through once it's back", async () => {
  // The proxy answers, the app doesn't: exactly what a crashed container looks like.
  await page.route("**/api/ops", (route) => route.fulfill({ status: 502, body: "Bad Gateway" }));
  await pickJob(page.getByPlaceholder("Any job — type to search"), "Delta Dock");
  await expect(timerCard().getByRole("heading", { name: "Delta Dock" })).toBeVisible();
  await expect(syncBadge().getByText("Offline · 1 to sync")).toBeVisible();

  await page.unroute("**/api/ops");
  // The outbox retries on its own schedule.
  await expect(syncBadge().getByText(/\d+ to sync/)).toHaveCount(0, { timeout: 20_000 });
  await expect(syncBadge().getByText("Offline", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(timerCard().getByRole("heading", { name: "Delta Dock" })).toBeVisible();
});

test("a change made offline that the server refuses is reported, not lost silently", async () => {
  // The running timer's id, from the device's own copy of today.
  const openId = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("time-tracker");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const days = await new Promise<{ open?: { id: string } | null }[]>((resolve) => {
      const r = db.transaction("snapshots").objectStore("snapshots").getAll();
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    return days.find((d) => d.open)?.open?.id ?? null;
  });
  expect(openId).not.toBeNull();

  await ctx.setOffline(true);
  // Meanwhile the same timer is stopped from another device. (Requests made
  // through `ctx.request` share the session but not the offline emulation.)
  const stoppedElsewhere = await ctx.request.post("/api/ops", {
    headers: { Origin: e2eEnv.PUBLIC_BASE_URL, "Content-Type": "application/json" },
    data: {
      ops: [
        {
          opId: crypto.randomUUID(),
          type: "timer.stop",
          deviceId: "other-device",
          clientTime: Date.now(),
          payload: { entryId: openId, at: Date.now() },
        },
      ],
    },
  });
  expect((await stoppedElsewhere.json()).results[0].ok).toBe(true);

  // This device, still offline, doesn't know and stops it too.
  await timerCard().getByRole("button", { name: "Stop" }).click();
  await expect(syncBadge().getByText("Offline · 1 to sync")).toBeVisible();

  await ctx.setOffline(false);
  await expect(page.getByText("Stopping a timer couldn't be saved")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("That timer has already been stopped.")).toBeVisible();
  await expect(syncBadge().getByText(/\d+ to sync/)).toHaveCount(0);
});

test("signing out with unsynced changes warns first, and keeps them for next time", async () => {
  // The refused stop above left the device's copy showing a timer the server
  // no longer has; a fresh load agrees with the server before going offline.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Start a timer" })).toBeVisible();

  await ctx.setOffline(true);
  await pickJob(page.getByPlaceholder("Any job — type to search"), "Delta Dock");
  await expect(timerCard().getByRole("heading", { name: "Delta Dock" })).toBeVisible();
  await expect(syncBadge().getByText("Offline · 1 to sync")).toBeVisible();

  // Keep the change from syncing once back online, so it's still waiting at
  // sign-out. (Set up before reconnecting: coming online syncs immediately.)
  await page.route("**/api/ops", (route) => route.fulfill({ status: 503, body: "" }));
  await ctx.setOffline(false);
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign out of this device" }).click();
  const dialog = page.getByRole("dialog", { name: "Changes not saved yet" });
  await expect(dialog.getByText("1 change hasn't reached the server yet")).toBeVisible();
  await dialog.getByRole("button", { name: "Stay signed in" }).click();
  await expect(dialog).toBeHidden();

  // Sign out anyway: the change stays on the device...
  await page.getByRole("button", { name: "Sign out of this device" }).click();
  await page.getByRole("dialog", { name: "Changes not saved yet" }).getByRole("button", { name: "Sign out anyway" }).click();
  await expect(page).toHaveURL(/\/signin$/);

  // ...and is saved when the same person signs back in here.
  await page.unroute("**/api/ops");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(syncBadge().getByText(/\d+ to sync/)).toHaveCount(0, { timeout: 15_000 });
  await page.reload();
  await expect(timerCard().getByRole("heading", { name: "Delta Dock" })).toBeVisible();
});
