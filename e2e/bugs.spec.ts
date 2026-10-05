import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { type Browser, type BrowserContext, type Page, expect, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

import { e2eEnv } from "../playwright.config.ts";

/**
 * Problems: an error in the page reaches the server on its own, grouped on
 * the admin page; "Report a problem" sends what the person says with a
 * screenshot and everything the page knew, offline too; the report downloads
 * as one bundle for an agent.
 *
 * Runs after auth.spec.ts, so an admin exists; the person signed up here is
 * an admin too (an admin invite), so the same browser can read the reports.
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

test.beforeAll(async ({ browser }) => {
  ({ context: ctx, page } = await signUp(browser, "Rita Reporter"));
});

test.afterAll(async () => {
  await ctx?.close();
});

const shots = process.env.E2E_SCREENSHOTS;

test("an error in the page is sent on its own, grouped, with who it happened to", async () => {
  await page.goto("/");
  const sent = page.waitForResponse((r) => r.url().endsWith("/api/client-errors") && r.status() === 204);
  // The same fault twice, with different numbers in it: one group.
  await page.evaluate(() => {
    setTimeout(() => {
      throw new TypeError("e2e: entry 41 has no job");
    });
    setTimeout(() => {
      throw new TypeError("e2e: entry 42 has no job");
    });
  });
  await sent;

  await page.goto("/admin/bugs");
  // One kind of error, though it happened twice.
  await page.getByText("Errors (1 open)", { exact: true }).click();
  const row = page.getByRole("link", { name: /TypeError: e2e: entry 4\d has no job/ });
  await expect(row).toHaveCount(1);
  await expect(page.getByRole("row").filter({ has: row })).toContainText("Rita Reporter");
  await row.click();
  await expect(page.getByText(/2 times/)).toBeVisible();
  await page.getByRole("button", { name: "Mark fixed" }).click();
  await expect(page.getByText("Marked fixed.", { exact: false })).toBeVisible();
});

test("Report a problem: what the person says, a screenshot, and what the page knew", async () => {
  await page.goto("/");
  // Something to find in the breadcrumbs.
  await page.getByRole("link", { name: "Your account" }).first().click();
  await expect(page).toHaveURL(/\/account$/);
  await page.getByRole("link", { name: "Track time" }).click();

  await page.getByRole("button", { name: "Report a problem" }).click();
  const dialog = page.getByRole("dialog", { name: "Report a problem" });
  await expect(dialog.getByRole("img", { name: "The page when you pressed the button" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Send report" })).toBeDisabled();
  await dialog.getByRole("button", { name: "What's sent with this" }).click();
  await expect(dialog.getByText("Only admins can read reports.")).toBeVisible();
  await dialog.getByLabel("What were you trying to do?").fill("Checking the week's total");
  await dialog.getByLabel("What happened instead?").fill("It showed yesterday");
  if (shots) await page.screenshot({ path: `${shots}/bug-report-dialog.png` });
  await dialog.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByText("Thanks — your report was sent")).toBeVisible();
  await expect(dialog).toBeHidden();

  await page.goto("/admin/bugs");
  await page.getByRole("link", { name: "Checking the week's total" }).click();
  await expect(page.getByRole("heading", { name: "Report from Rita Reporter" })).toBeVisible();
  await expect(page.getByText("It showed yesterday")).toBeVisible();
  await expect(page.getByRole("img", { name: "The page as drawn by the app" })).toBeVisible();
  // Only this one tab was open: it doesn't count itself as another.
  await expect(page.getByText("Other tabs open:")).toHaveCount(0);
  // The trail: the visit to the account page, and the button itself.
  await expect(page.getByRole("cell", { name: "/account" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Report a problem pressed" })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/bug-report-admin.png`, fullPage: true });

  // One file for an agent.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download for an agent" }).click()]);
  const files = unzipSync(readFileSync(await download.path()));
  expect(Object.keys(files).sort()).toEqual(expect.arrayContaining(["context.json", "report.md"]));
  expect(Object.keys(files).some((f) => f.startsWith("screenshot-1-drawn."))).toBe(true);
  expect(strFromU8(files["report.md"]!)).toContain("Checking the week's total");
  const context = JSON.parse(strFromU8(files["context.json"]!)) as { screens: Record<string, unknown>; device: unknown; breadcrumbs: unknown[] };
  // The day screen's own data rode along.
  expect(Object.keys(context.screens)).toContain("day");
  expect(context.breadcrumbs.length).toBeGreaterThan(2);

  await page.getByRole("combobox", { name: "Status" }).click();
  await page.getByRole("option", { name: "Fixed" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Marked fixed.", { exact: true })).toBeVisible();
});

test("a report made offline is kept on the device and sent when the connection is back", async () => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Report a problem" })).toBeVisible();
  await ctx.setOffline(true);
  await page.getByRole("button", { name: "Report a problem" }).click();
  const dialog = page.getByRole("dialog", { name: "Report a problem" });
  await dialog.getByLabel("What were you trying to do?").fill("Reported from the basement");
  await dialog.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByText("Report saved")).toBeVisible();

  const arrived = page.waitForResponse((r) => r.url().endsWith("/api/bug-reports") && r.ok());
  await ctx.setOffline(false);
  await arrived;
  await page.goto("/admin/bugs");
  await expect(page.getByRole("link", { name: "Reported from the basement" })).toBeVisible();
});
