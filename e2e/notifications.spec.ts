import { execFileSync } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";

import { type Browser, type BrowserContext, type Page, expect, test } from "@playwright/test";
// @ts-expect-error http_ece ships no types; it's web-push's own decryption counterpart.
import ece from "http_ece";

import { e2eEnv, fakePushUrl } from "../playwright.config.ts";

/**
 * Notifications from the account page: a device is registered, a test is
 * sent through the real web-push library to a pretend push service and
 * decrypted here, the settings and the day off are kept, a notification's
 * button works with its token and only with it, and a device the push
 * service says is gone is forgotten.
 *
 * Headless Chromium can't subscribe to a real push service, so the
 * subscription is made up here (with real keys, so what arrives can be
 * decrypted) and posted the way the page posts the browser's own.
 */
test.describe.configure({ mode: "serial" });

let ctx: BrowserContext;
let page: Page;

const client = createECDH("prime256v1");
client.generateKeys();
const authSecret = randomBytes(16);
const ENDPOINT = `${fakePushUrl}/push/nora`;

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

interface Received {
  path: string;
  headers: Record<string, string>;
  body: string;
}

async function received(): Promise<Received[]> {
  const response = await page.request.get(`${fakePushUrl}/__test/received`, { ignoreHTTPSErrors: true });
  return response.json();
}

function decrypt(message: Received): Record<string, unknown> {
  const plain: Buffer = ece.decrypt(Buffer.from(message.body, "base64"), {
    version: "aes128gcm",
    privateKey: client,
    authSecret: authSecret.toString("base64url"),
  });
  return JSON.parse(plain.toString("utf8"));
}

const section = () => page.locator("#notifications");
const devices = () => section().getByTestId("push-device");

test.beforeAll(async ({ browser }) => {
  ({ context: ctx, page } = await signUp(browser, "Nora Notify"));
});

test.afterAll(async () => {
  await ctx?.close();
});

test("the account page offers to turn notifications on for this browser", async () => {
  await page.goto("/account");
  // The worker registers on first load; with it running, the browser is ready.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect(section().getByRole("heading", { name: "Notifications" })).toBeVisible();
  const thisDevice = section().getByTestId("this-device");
  await expect(thisDevice.getByText("Off")).toBeVisible();
  // Not asked yet: the button that asks.
  await expect(thisDevice.getByRole("button", { name: "Turn on notifications here" })).toBeVisible();

  // Blocked: no button, and how to fix it.
  const cdp = await ctx.newCDPSession(page);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  const setPermission = (setting: "denied" | "granted") =>
    cdp.send("Browser.setPermission", {
      permission: { name: "notifications" },
      setting,
      origin: e2eEnv.PUBLIC_BASE_URL,
      browserContextId: targetInfo.browserContextId,
    });
  await setPermission("denied");
  await page.reload();
  await expect(thisDevice.getByText(/Notifications are blocked for this site/)).toBeVisible();
  await expect(thisDevice.getByRole("button", { name: "Turn on notifications here" })).toHaveCount(0);

  // Allowed.
  await setPermission("granted");
  await page.reload();
  await expect(thisDevice.getByRole("button", { name: "Turn on notifications here" })).toBeVisible();
});

test("a device is registered, and a test reaches it, signed and encrypted", async () => {
  const response = await page.request.post("/account", {
    headers: { Origin: e2eEnv.PUBLIC_BASE_URL },
    form: {
      intent: "push-subscribe",
      subscription: JSON.stringify({
        endpoint: ENDPOINT,
        keys: { p256dh: client.getPublicKey("base64url"), auth: authSecret.toString("base64url") },
      }),
    },
  });
  expect(response.status()).toBe(200);

  await page.reload();
  await expect(devices()).toHaveCount(1);
  await expect(devices().first()).toContainText("Chrome on Windows");

  await devices().first().getByRole("button", { name: "Test" }).click();
  await expect(page.getByText("Sent. It should appear in a few seconds.")).toBeVisible();

  const messages = await received();
  expect(messages).toHaveLength(1);
  const [message] = messages;
  expect(message!.path).toBe("/push/nora");
  expect(message!.headers["content-encoding"]).toBe("aes128gcm");
  expect(message!.headers.ttl).toBe("300");
  expect(message!.headers.urgency).toBe("high");
  expect(message!.headers.topic).toBe("tt-test");
  expect(message!.headers.authorization).toMatch(/^vapid t=/);
  expect(message!.headers.authorization).toContain(`k=${e2eEnv.VAPID_PUBLIC_KEY}`);

  const payload = decrypt(message!);
  expect(payload).toMatchObject({
    title: "Notifications are working",
    url: "/account#notifications",
    tag: "tt-test",
  });
  expect(typeof payload.id).toBe("number");
  expect(typeof payload.token).toBe("string");
});

test("a notification's button works with its token, and only with it", async () => {
  const payload = decrypt((await received())[0]!);
  const press = (body: Record<string, unknown>) =>
    page.request.post("/api/notifications/action", {
      headers: { Origin: e2eEnv.PUBLIC_BASE_URL, "Content-Type": "application/json" },
      data: body,
    });

  const wrong = await press({ id: payload.id, token: `${String(payload.token).slice(0, -2)}xx`, action: "snooze" });
  expect(wrong.status()).toBe(403);
  const otherSite = await page.request.post("/api/notifications/action", {
    headers: { Origin: "https://elsewhere.example", "Content-Type": "application/json" },
    data: { id: payload.id, token: payload.token, action: "snooze" },
  });
  expect(otherSite.status()).toBe(403);

  const ok = await press({ id: payload.id, token: payload.token, action: "snooze" });
  expect(ok.status()).toBe(200);

  await page.reload();
  const recent = section().getByTestId("recent-notification").first();
  await expect(recent).toContainText("Notifications are working");
  await expect(recent).toContainText("to 1 device");
  await expect(recent).toContainText("snoozed until");
});

test("settings are kept", async () => {
  const empty = section().getByLabel("If I haven't entered my time");
  await expect(empty).toBeChecked();
  await empty.uncheck({ force: true });
  await section().getByLabel("End-of-day reminders at").fill("16:30");
  await section().getByRole("combobox", { name: "Days with time not submitted" }).click();
  await page.getByRole("option", { name: "Every workday, about earlier days" }).click();
  await section().getByRole("button", { name: "Save notification settings" }).click();
  await expect(page.getByText("Notification settings saved.")).toBeVisible();

  await page.reload();
  await expect(section().getByLabel("If I haven't entered my time")).not.toBeChecked();
  await expect(section().getByLabel("End-of-day reminders at")).toHaveValue("16:30");
  await expect(section().getByRole("combobox", { name: "Days with time not submitted" })).toHaveValue(
    "Every workday, about earlier days",
  );
  await expect(section().getByRole("button", { name: "Save notification settings" })).toBeDisabled();
});

test("a day off is kept", async () => {
  await section().getByLabel("Today is a day off").check({ force: true });
  await expect(page.getByText("No day reminders today.")).toBeVisible();
  await page.reload();
  await expect(section().getByLabel("Today is a day off")).toBeChecked();
});

test("screenshots of the Notifications section", async () => {
  const dir = process.env.E2E_SCREENSHOTS;
  test.skip(!dir, "screenshots only");
  await section().screenshot({ path: `${dir}/notifications.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await section().screenshot({ path: `${dir}/phone-notifications.png` });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
});

test("a device the push service says is gone is forgotten", async () => {
  await page.request.post(`${fakePushUrl}/__test/gone`, { data: { name: "nora" }, ignoreHTTPSErrors: true });
  await devices().first().getByRole("button", { name: "Test" }).click();
  await expect(page.getByText(/The push service didn't take it: Chrome on Windows: 410/)).toBeVisible();
  await page.reload();
  await expect(devices()).toHaveCount(0);
});
