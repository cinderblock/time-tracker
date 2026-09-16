import { execFileSync } from "node:child_process";

import { type Browser, type BrowserContext, type Page, expect, test } from "@playwright/test";

import { e2eEnv } from "../playwright.config.ts";

/**
 * The whole passkey lifecycle, in order, in real Chromium:
 * first-admin setup → sign out → sign in → invite → employee sign-up →
 * permissions → link reuse → deactivation.
 */
test.describe.configure({ mode: "serial" });

/** A browser context with a platform authenticator that always says yes. */
async function contextWithPasskeys(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
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
  return { context, page };
}

function mintAdminLink(): string {
  const out = execFileSync("bun", ["src/cli/admin-link.ts"], {
    env: { ...process.env, ...e2eEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const url = out.trim().split(/\r?\n/).pop() ?? "";
  expect(url).toMatch(/\/join\/[\w-]+$/);
  return url;
}

let admin: { context: BrowserContext; page: Page };
let employee: { context: BrowserContext; page: Page };
let inviteUrl = "";

test.afterAll(async () => {
  await admin?.context.close();
  await employee?.context.close();
});

test("signed-out visitors are sent to sign-in, which explains setup is pending", async ({ page }) => {
  await page.goto("/account");
  await expect(page).toHaveURL(/\/signin\?next=%2Faccount$/);
  await expect(page.getByText("No admin exists yet")).toBeVisible();
});

test("the first admin sets up with a one-time link and a passkey", async ({ browser }) => {
  admin = await contextWithPasskeys(browser);
  const { page } = admin;

  await page.goto(mintAdminLink());
  // The token is moved out of the address bar before anything renders.
  await expect(page).toHaveURL(/\/join$/);
  await expect(page.getByRole("heading", { name: "Set up the first admin" })).toBeVisible();

  await page.getByLabel("Your name").fill("Ada Lovelace");
  await page.getByRole("button", { name: "Create passkey" }).click();

  await expect(page.getByRole("heading", { name: "Hi, Ada" })).toBeVisible();
  await expect(page.getByText("Accounting backend", { exact: true })).toBeVisible();
  await expect(page).toHaveTitle("E2E Time");
});

test("the admin can sign out and back in with the passkey", async () => {
  const { page } = admin;
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign out of this device" }).click();
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByText("No admin exists yet")).toHaveCount(0);

  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Hi, Ada" })).toBeVisible();
});

test("sign-in returns to the page that asked for it", async () => {
  const { page } = admin;
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign out of this device" }).click();
  await page.goto("/admin/people");
  await expect(page).toHaveURL(/\/signin\?next=%2Fadmin%2Fpeople$/);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "People", exact: true })).toBeVisible();
});

test("the admin invites an employee and sees the link exactly once", async () => {
  const { page } = admin;
  await page.goto("/admin/people");
  // Setup is done, so no first-admin link may still be open.
  await expect(page.getByText("First-admin setup")).toHaveCount(0);
  await page.getByLabel("Their name").fill("Grace Hopper");
  await page.getByRole("button", { name: "Create invite link" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Invite for Grace Hopper (employee)")).toBeVisible();
  inviteUrl = (await dialog.locator("pre, code").first().innerText()).trim();
  expect(inviteUrl).toMatch(/^http:\/\/localhost:\d+\/join\/[\w-]+$/);
  await dialog.getByRole("button", { name: "Done" }).click();

  await expect(page.getByText("Invite for Grace Hopper (employee)")).toBeVisible();
  // The open-links list never shows the URL again.
  await expect(page.getByText(inviteUrl)).toHaveCount(0);
});

test("the employee signs up from the invite on their own device", async ({ browser }) => {
  employee = await contextWithPasskeys(browser);
  const { page } = employee;

  await page.goto(inviteUrl);
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.getByLabel("Your name")).toHaveValue("Grace Hopper");
  await page.getByRole("button", { name: "Create passkey" }).click();

  await expect(page.getByRole("heading", { name: "Hi, Grace" })).toBeVisible();
  // Employees don't see backend status or the admin area.
  await expect(page.getByText("Accounting backend", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "People" })).toHaveCount(0);
});

test("employees are refused the admin pages", async () => {
  const { page } = employee;
  const response = await page.goto("/admin/people");
  expect(response?.status()).toBe(403);
  await expect(page.getByText("This page is for admins.")).toBeVisible();
});

test("a used invite link can't be used again", async ({ browser }) => {
  const stranger = await contextWithPasskeys(browser);
  await stranger.page.goto(inviteUrl);
  await expect(stranger.page).toHaveURL(/\/join\?invalid=1$/);
  await expect(stranger.page.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
  await stranger.context.close();
});

test("deactivating the employee signs them out immediately", async () => {
  const { page } = admin;
  await page.goto("/admin/people");
  await page.getByRole("link", { name: /Grace Hopper/ }).click();
  await expect(page.getByRole("heading", { name: "Grace Hopper" })).toBeVisible();
  await page.getByRole("switch", { name: "Can sign in" }).click({ force: true });
  await expect(page.getByText("deactivated", { exact: true })).toBeVisible();

  // Their next request, from wherever they were, lands on sign-in.
  await employee.page.goto("/");
  await expect(employee.page).toHaveURL(/\/signin$/);

  await employee.page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(employee.page.getByText("This account has been deactivated")).toBeVisible();
});

test("the only admin cannot deactivate themselves", async () => {
  const { page } = admin;
  await page.goto("/admin/people");
  await page.getByRole("link", { name: /Ada Lovelace/ }).click();
  await page.getByRole("switch", { name: "Can sign in" }).click({ force: true });
  await expect(page.getByText("This is the only active admin")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("switch", { name: "Can sign in" })).toBeChecked();
});

test("the passkey API refuses cross-origin calls", async ({ request }) => {
  const response = await request.post("/api/passkey/signin-options", {
    headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
    data: {},
  });
  expect(response.status()).toBe(403);
});
