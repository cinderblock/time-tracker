import { execFileSync } from "node:child_process";

import { type BrowserContext, type Locator, type Page, expect, test } from "@playwright/test";

import { bridgeEnv, fakeBridgeUrl } from "../playwright.config.ts";

/**
 * Sending approved time to QuickBooks through the (pretend) QB Bridge, from
 * the admin's side: fetching lists, linking people and jobs, items, sending,
 * the bridge being down, a refusal, creating a job there, and reopening.
 */
test.describe.configure({ mode: "serial" });

let ctx: BrowserContext;
let page: Page;

interface BridgeState {
  records: { date: string; entity: string; customer: string | null; item: string | null; payrollItem: string | null; duration: string; notes: string; billable: string }[];
  customers: { id: string; name: string; fullName: string }[];
}

async function bridge(): Promise<BridgeState> {
  return (await (await fetch(`${fakeBridgeUrl}/__test/state`)).json()) as BridgeState;
}

async function bridgeControl(path: "down" | "fail", body: unknown) {
  await fetch(`${fakeBridgeUrl}/__test/${path}`, { method: "POST", body: JSON.stringify(body) });
}

const toast = (text: string | RegExp) => page.locator(".mantine-Notification-root").filter({ hasText: text });
const stat = (label: string) => page.locator(".mantine-Card-root", { has: page.getByText(label, { exact: true }) });

async function choose(select: Locator, option: string) {
  await select.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function sendNow(result: string | RegExp) {
  await page.getByRole("button", { name: "Send now" }).click();
  await expect(toast(result)).toBeVisible();
}

/** Add time on the tracking screen as a plain duration. */
async function addTime(job: string, hours: string, minutes: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Add time manually" }).click();
  const dialog = page.getByRole("dialog", { name: "Add time" });
  const jobInput = dialog.getByRole("combobox", { name: /^Job/ });
  await jobInput.click();
  await jobInput.fill(job);
  await page.getByRole("option", { name: job, exact: true }).click();
  await dialog.getByText("Just a duration").click();
  await dialog.getByLabel("Hours").fill(hours);
  await dialog.getByLabel("Minutes").fill(minutes);
  await dialog.getByRole("button", { name: "Add time" }).click();
  await expect(dialog).toBeHidden();
}

async function approveWeek() {
  await page.goto("/admin/timesheets");
  await page.getByRole("group", { name: "Ivy Integrator" }).getByRole("button", { name: "Approve Ivy Integrator's week" }).click();
  await expect(toast(/^Ivy Integrator: Approved/)).toBeVisible();
}

test.afterAll(async () => {
  await ctx?.close();
});

test("set up: the first admin, and QuickBooks' lists", async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const url = execFileSync("bun", ["src/cli/admin-link.ts"], {
    env: { ...process.env, ...bridgeEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .trim()
    .split(/\r?\n/)
    .pop()!;
  await page.goto(url);
  await page.getByLabel("Your name").fill("Ivy Integrator");
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect(page.getByRole("banner").getByText("Ivy Integrator")).toBeVisible();

  await page.getByRole("link", { name: "Accounting" }).click();
  await expect(page.getByText("QuickBooks, through the QB Bridge")).toBeVisible();
  await expect(page.getByText("Connected to QuickBooks (Pretend Company).")).toBeVisible();
  await expect(page.getByText("Approved time is sent when you press Send now.")).toBeVisible();
  await expect(page.getByText("The lists haven't been fetched yet.")).toBeVisible();
  await expect(page.getByText("Fetch the lists from QuickBooks first.")).toBeVisible();

  await page.getByRole("button", { name: "Refresh lists" }).click();
  await expect(toast("Lists will refresh at the next contact. Sent 1 request.")).toBeVisible();
  await expect(page.getByText(/Lists last refreshed/)).toBeVisible();

  await page.goto("/admin/jobs");
  await expect(page.getByText("Acme:Phase 2", { exact: true })).toBeVisible();
  // Names come from QuickBooks: no renaming here.
  const acme = page.locator(".mantine-Card-root", { hasText: "Acme:Phase 2" });
  await expect(acme.getByRole("button", { name: "Rename" })).toHaveCount(0);
  await expect(page.getByText("Old Client", { exact: true })).toBeVisible();
  await expect(page.locator(".mantine-Card-root", { hasText: "Old Client" }).getByText("inactive in QuickBooks")).toBeVisible();
});

test("link a person, pick default items, and send approved time", async () => {
  await page.goto("/admin/accounting");
  await choose(page.getByRole("combobox", { name: "QuickBooks name for Ivy Integrator" }), "Alice A");
  await expect(toast("Link saved.")).toBeVisible();
  // Linked to an employee: a payroll item can be chosen too.
  await expect(page.getByRole("combobox", { name: "Payroll item for Ivy Integrator" })).toBeVisible();
  await choose(page.getByRole("combobox", { name: "Default service item" }), "Labor");
  await expect(toast("Default service item saved.")).toBeVisible();
  await choose(page.getByRole("combobox", { name: "Default payroll item" }), "Hourly");
  await expect(toast("Default payroll item saved.")).toBeVisible();

  // Some time on a real job, and some on a job made up on the spot.
  await page.goto("/admin/jobs");
  await page.getByLabel("New job").fill("Pop-up job");
  await page.getByRole("button", { name: "Add job" }).click();
  await expect(page.locator(".mantine-Card-root", { hasText: "Pop-up job" }).getByText("not in QuickBooks yet")).toBeVisible();
  await addTime("Acme:Phase 2", "2", "0");
  await addTime("Pop-up job", "0", "45");
  await approveWeek();

  await page.goto("/admin/accounting");
  await expect(stat("Ready to send")).toContainText("1");
  await expect(stat("Waiting on a fix")).toContainText("1");
  const waiting = page.getByRole("alert").filter({ hasText: "Approved time that can't be sent yet" });
  await expect(waiting).toContainText("The job “Pop-up job” was made here and isn't in the accounting system yet. (1 entry, 45m)");
  await expect(waiting.getByRole("link", { name: "Link jobs" })).toBeVisible();

  await sendNow("Sent 1 request.");
  expect((await bridge()).records).toEqual([
    {
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      entity: "E-ALICE",
      customer: "C-ACME-2",
      item: "I-LABOR",
      payrollItem: "W-HOURLY",
      duration: "PT2H0M0S",
      notes: expect.stringMatching(/^\[ref [0-9a-f]{12}\]$/),
      billable: "Billable",
    },
  ]);
  await expect(stat("Sent")).toContainText("1");
});

test("a job made here is linked to the real one, and its time follows", async () => {
  const card = page.locator(".mantine-Card-root", { hasText: "Pop-up job" });
  await choose(card.getByRole("combobox", { name: "Link Pop-up job to" }), "Acme");
  await expect(toast("Linked. Its time now belongs to that job.")).toBeVisible();
  await expect(page.getByText("None. Every job is in QuickBooks.")).toBeVisible();
  await sendNow("Sent 1 request.");
  expect((await bridge()).records.map((r) => [r.customer, r.duration])).toEqual([
    ["C-ACME-2", "PT2H0M0S"],
    ["C-ACME", "PT0H45M0S"],
  ]);

  // The tracking screen shows the time under the real job now.
  await page.goto("/");
  await expect(page.locator(".mantine-Card-root", { hasText: "45m" })).toContainText("Acme");
  await expect(page.getByText("in accounting")).toHaveCount(2);
});

test("a job made here can be created in QuickBooks instead", async () => {
  await page.goto("/admin/jobs");
  await page.getByLabel("New job").fill("Brand New Site");
  await page.getByRole("button", { name: "Add job" }).click();
  await page.goto("/admin/accounting");
  await page.locator(".mantine-Card-root", { hasText: "Brand New Site" }).getByRole("button", { name: "Create in QuickBooks" }).click();
  await expect(toast("It will be created at the next contact. Sent 1 request.")).toBeVisible();
  expect((await bridge()).customers.map((c) => c.fullName)).toContain("Brand New Site");
  await expect(page.getByText("None. Every job is in QuickBooks.")).toBeVisible();
});

test("while QuickBooks is closed nothing is lost, and it goes once it's back", async () => {
  await addTime("Acme", "0", "30");
  await approveWeek();
  await bridgeControl("down", { down: true });
  await page.goto("/admin/accounting");
  await expect(page.getByText("not connected now")).toBeVisible();
  await sendNow(/The QB Bridge couldn't do it \(QBConnectionError: Could not open the company file\)/);
  await expect(stat("Refused")).toContainText("0"); // not the time's fault
  expect((await bridge()).records).toHaveLength(2);

  await bridgeControl("down", { down: false });
  await sendNow(/Sent \d requests?\./);
  expect((await bridge()).records).toHaveLength(3);
});

test("a refusal is shown, and can be retried", async () => {
  await addTime("Acme", "0", "15");
  await approveWeek();
  await page.goto("/admin/accounting");
  // After the page's own health check, so it's the time that's refused.
  await bridgeControl("fail", { code: 3140, message: "There is an invalid reference to QuickBooks Customer." });
  await sendNow("Sent 1 request.");
  const refused = page.getByRole("alert").filter({ hasText: "Refused by QuickBooks" });
  await expect(refused).toContainText(
    /\(15m\): There is an invalid reference to QuickBooks Customer\. — tries again (in under a minute|in 1 minute)\./,
  );
  await expect(stat("Refused")).toContainText("1");
  await refused.getByRole("button", { name: "Try again now" }).click();
  await expect(toast("Retrying 1 entry. Sent 1 request.")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Refused by QuickBooks" })).toHaveCount(0);
  expect((await bridge()).records).toHaveLength(4);
  await expect(page.getByText("Recent activity")).toBeVisible();
  await expect(page.getByText(/Sent time · just now — 3140: There is an invalid reference/)).toBeVisible();
});

test("reopened time is flagged until it's approved again, then amended in place", async () => {
  await page.goto("/admin/timesheets");
  await page.getByRole("group", { name: "Ivy Integrator" }).getByRole("button", { name: "Reopen Ivy Integrator's week" }).click();
  await expect(toast("Ivy Integrator: Reopened 4 entries.")).toBeVisible();
  await page.goto("/admin/accounting");
  await expect(page.getByRole("alert").filter({ hasText: "Reopened after being sent" })).toContainText(
    "QuickBooks still has the old version of these entries until they're approved again",
  );

  await approveWeek();
  await page.goto("/admin/accounting");
  await sendNow("Sent 4 requests.");
  expect((await bridge()).records).toHaveLength(4); // amended, not added
  await expect(page.getByRole("alert").filter({ hasText: "Reopened after being sent" })).toHaveCount(0);
});

test("screenshots of the Accounting page", async ({ browser }) => {
  const dir = process.env.E2E_SCREENSHOTS;
  test.skip(!dir, "screenshots only");
  await page.goto("/admin/accounting");
  await page.screenshot({ path: `${dir}/accounting.png`, fullPage: true });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await ctx.storageState() });
  const small = await phone.newPage();
  await small.goto("/admin/accounting");
  await small.screenshot({ path: `${dir}/phone-accounting.png`, fullPage: true });
  await phone.close();
});
