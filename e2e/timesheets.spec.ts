import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { type APIRequestContext, type Browser, type BrowserContext, type Page, expect, test } from "@playwright/test";

import { e2eEnv } from "../playwright.config.ts";
import type { OpPayload, OpType } from "../src/ops-schema.ts";
import { formatWorkDate, today, zonedTimeToInstant } from "../src/time.ts";
import { uuidv7 } from "../src/uuid.ts";

/**
 * The admin side: rates and categories, the timesheet grid, submitting and
 * optional approval, an admin fixing someone's day, the calendar, reports and
 * the CSV export.
 *
 * Runs after auth.spec.ts, so `admin-link` hands out admin invites.
 * Set E2E_SCREENSHOTS=<dir> to save screenshots of the admin pages.
 */
test.describe.configure({ mode: "serial" });

const TZ = e2eEnv.TZ;
const TODAY = today(TZ);
const at = (time: string) => zonedTimeToInstant(TODAY, time, TZ);

let admin: { context: BrowserContext; page: Page };
let employee: { context: BrowserContext; page: Page };
let employeeId = 0;
const echo = uuidv7();
const foxtrot = uuidv7();

async function withPasskeys(browser: Browser, viewport?: { width: number; height: number }) {
  const context = await browser.newContext(viewport ? { viewport } : {});
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

async function send<T extends OpType>(request: APIRequestContext, type: T, payload: OpPayload<T>) {
  const response = await request.post("/api/ops", {
    headers: { Origin: e2eEnv.PUBLIC_BASE_URL, "Content-Type": "application/json" },
    data: { ops: [{ opId: uuidv7(), type, deviceId: "e2e-setup", clientTime: Date.now(), payload }] },
  });
  const body = await response.json();
  expect(body.results[0], JSON.stringify(body)).toMatchObject({ ok: true });
}

async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: false }).first().click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

const toast = (page: Page, text: string | RegExp) => page.locator(".mantine-Notification-root").filter({ hasText: text });

async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SCREENSHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

test.afterAll(async () => {
  await admin?.context.close();
  await employee?.context.close();
});

test("set up: an admin, an employee, two jobs, and some time", async ({ browser }) => {
  admin = await withPasskeys(browser);
  const url = execFileSync("bun", ["src/cli/admin-link.ts"], {
    env: { ...process.env, ...e2eEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .trim()
    .split(/\r?\n/)
    .pop()!;
  await admin.page.goto(url);
  await admin.page.getByLabel("Your name").fill("Paula Payroll");
  await admin.page.getByRole("button", { name: "Create passkey" }).click();
  await expect(admin.page.getByRole("banner").getByText("Paula Payroll")).toBeVisible();
  // Two customers, a job under each.
  const echoCo = uuidv7();
  const foxtrotCo = uuidv7();
  await send(admin.context.request, "job.create", { jobId: echoCo, name: "Echo Co" });
  await send(admin.context.request, "job.create", { jobId: echo, name: "Echo Works", parentId: echoCo });
  await send(admin.context.request, "job.create", { jobId: foxtrotCo, name: "Foxtrot Co" });
  await send(admin.context.request, "job.create", { jobId: foxtrot, name: "Foxtrot Farm", parentId: foxtrotCo });

  await admin.page.goto("/admin/people");
  await admin.page.getByLabel("Their name").fill("Eddie Employee");
  await admin.page.getByRole("button", { name: "Create invite link" }).click();
  const dialog = admin.page.getByRole("dialog");
  const invite = (await dialog.locator("pre, code").first().innerText()).trim();
  await dialog.getByRole("button", { name: "Done" }).click();

  employee = await withPasskeys(browser);
  await employee.page.goto(invite);
  await employee.page.getByRole("button", { name: "Create passkey" }).click();
  await expect(employee.page.getByRole("banner").getByText("Eddie Employee")).toBeVisible();

  const request = employee.context.request;
  await send(request, "entry.create", {
    entryId: uuidv7(),
    jobId: echo,
    startedAt: at("09:00"),
    endedAt: at("11:00"),
    note: "Framing",
  });
  await send(request, "entry.create", { entryId: uuidv7(), jobId: foxtrot, workDate: TODAY, durationSeconds: 5400, note: "Fencing" });
  await send(request, "timer.start", { entryId: uuidv7(), jobId: foxtrot, at: Date.now() - 60_000 });

  await admin.page.goto("/admin/people");
  await admin.page.getByRole("link", { name: /Eddie Employee/ }).click();
  await expect(admin.page).toHaveURL(/\/admin\/people\/\d+$/);
  employeeId = Number(new URL(admin.page.url()).pathname.split("/").pop());
  expect(employeeId).toBeGreaterThan(0);
});

test("employees can't reach the admin pages or act for anyone", async () => {
  const response = await employee.page.goto("/admin/timesheets");
  expect(response?.status()).toBe(403);
  await expect(employee.page.getByText("This page is for admins.")).toBeVisible();
  const api = await employee.context.request.post(`/api/admin/people/${employeeId}/ops`, {
    headers: { Origin: e2eEnv.PUBLIC_BASE_URL, "Content-Type": "application/json" },
    data: { ops: [] },
  });
  expect(api.status()).toBe(403);
  await employee.page.goto("/");
});

test("rates: an organisation default and a person's own rate", async () => {
  const { page } = admin;
  await page.getByRole("link", { name: "Rates & categories" }).click();
  await expect(page.getByRole("heading", { name: "Rates & categories" })).toBeVisible();

  await page.getByLabel("Hourly rate").fill("50");
  await page.getByRole("button", { name: "Set rate" }).click();
  await expect(toast(page, "Rate set: $50.00/h")).toBeVisible();

  await choose(page, "Rate for", "A person");
  await choose(page, "Person", "Eddie Employee");
  await page.getByLabel("Hourly rate").fill("40");
  await page.getByRole("button", { name: "Set rate" }).click();
  await expect(toast(page, "Rate set: $40.00/h")).toBeVisible();

  const rows = page.getByRole("row");
  await expect(rows.filter({ hasText: "Everyone" })).toContainText("$50.00/h");
  await expect(rows.filter({ hasText: "Eddie Employee" })).toContainText("$40.00/h");
  await expect(rows.filter({ hasText: "Eddie Employee" })).toContainText("current");
});

test("categories: add one and put someone in it", async () => {
  const { page } = admin;
  await page.getByLabel("New category").fill("Field crew");
  await page.getByRole("button", { name: "Add category" }).click();
  await expect(toast(page, "Added “Field crew”.")).toBeVisible();
  await shot(page, "rates");

  await page.goto(`/admin/people/${employeeId}`);
  await choose(page, "Category", "Field crew");
  await expect(toast(page, "Eddie Employee is now in Field crew.")).toBeVisible();
});

test("a day with a timer still running can't be submitted", async () => {
  const { page } = employee;
  await page.reload();
  await expect(page.getByText("Stop the timer first — a running timer can't be submitted.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit this day" })).toBeDisabled();
});

test("timesheets: the week at a glance, filtered, and submitted for someone in one tap", async () => {
  const { page } = admin;
  await page.getByRole("link", { name: "Timesheets" }).first().click();
  const eddie = page.getByRole("group", { name: "Eddie Employee" });
  await expect(eddie).toBeVisible();
  await expect(eddie.getByText("running")).toBeVisible();
  await expect(
    eddie.getByRole("link", { name: new RegExp(`^Eddie Employee, ${formatWorkDate(TODAY)}: 3h 3\\dm, 2 not submitted$`) }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "Paula Payroll" })).toBeVisible();

  await choose(page, "Category", "Field crew");
  await expect(page).toHaveURL(/category=\d+/);
  await expect(page.getByRole("group", { name: "Paula Payroll" })).toHaveCount(0);
  await shot(page, "timesheets");

  // Nobody has to approve anything: an admin submitting for someone is the
  // safety net for a person who hasn't got to it.
  await eddie.getByRole("button", { name: "Submit Eddie Employee's week" }).click();
  await expect(
    toast(page, "Eddie Employee: Submitted 2 entries. A running timer was left out; submit again once it stops."),
  ).toBeVisible();
  await expect(eddie.getByText("submitted", { exact: true })).toBeVisible();
  await expect(eddie.getByRole("button", { name: "Reopen Eddie Employee's week" })).toBeVisible();
  await expect(eddie.getByRole("link", { name: /, submitted$/ })).toHaveCount(0); // a running timer isn't submitted
});

test("the employee sees submitted time locked, and takes the day back themselves", async () => {
  const { page } = employee;
  await page.reload();
  const framing = page.locator(".mantine-Card-root", { hasText: "Framing" });
  await expect(framing.getByText("submitted", { exact: true })).toBeVisible();
  await expect(framing.getByRole("button")).toHaveCount(0);

  // Their own submission is theirs to withdraw — no admin involved.
  await page.getByRole("button", { name: "Take it back" }).click();
  await expect(framing.getByRole("button", { name: "Delete" })).toBeVisible();
  await expect(page.getByText("2 entries not submitted")).toBeVisible();
});

test("approvals can be switched on, and then time waits for an admin", async () => {
  const { page } = admin;
  await page.goto("/admin/settings");
  await page.getByLabel("An admin has to approve submitted time").click();
  await expect(toast(page, /waits for an admin to approve it/)).toBeVisible();

  await page.goto("/admin/timesheets");
  const eddie = page.getByRole("group", { name: "Eddie Employee" });
  await eddie.getByRole("button", { name: "Approve Eddie Employee's week" }).click();
  await expect(
    toast(page, "Eddie Employee: Approved 2 entries. A running timer was left out; approve again once it stops."),
  ).toBeVisible();
  await expect(eddie.getByText("approved", { exact: true })).toBeVisible();

  const { page: theirs } = employee;
  await theirs.reload();
  const framing = theirs.locator(".mantine-Card-root", { hasText: "Framing" });
  await expect(framing.getByText("approved", { exact: true })).toBeVisible();
  await expect(framing.getByText("Locked — an admin can reopen it for changes.")).toBeVisible();
  await expect(theirs.getByRole("button", { name: "Take it back" })).toHaveCount(0);
});

test("the calendar shows each block of time", async () => {
  const { page } = admin;
  await page.getByRole("link", { name: "Calendar" }).click();
  const block = page.getByRole("link", { name: "Eddie Employee, Echo Co:Echo Works, 9:00 AM – 11:00 AM, approved" });
  await expect(block).toBeVisible();
  await expect(page.getByRole("link", { name: /^Eddie Employee, Foxtrot Co:Foxtrot Farm, .* – now$/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Eddie Employee · 1h 30m · Foxtrot Co:Foxtrot Farm/ })).toBeVisible();
  await shot(page, "calendar");
  await block.click();
  await expect(page).toHaveURL(new RegExp(`/admin/people/${employeeId}/time$`));
});

test("an admin fixes someone's day on their tracking screen", async () => {
  const { page } = admin;
  await expect(page.getByText("Eddie Employee's time", { exact: true })).toBeVisible();
  const timer = page.locator(".mantine-Card-root", { has: page.getByRole("button", { name: "Stop" }) });
  await expect(timer.getByRole("heading", { name: "Foxtrot Farm" })).toBeVisible();
  await timer.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("heading", { name: "Start a timer" })).toBeVisible();
  // Straight to the server: nothing waits in the admin's own outbox.
  await expect(page.getByRole("banner").getByText(/to sync/)).toHaveCount(0);
  await shot(page, "acting-for");

  // The stopped timer is a draft, so it can be deleted — and undone.
  const stopped = () => page.locator(".mantine-Card-root", { hasText: "Foxtrot Farm", has: page.getByRole("button", { name: "Delete" }) });
  await expect(stopped()).toHaveCount(1);
  await stopped().getByRole("button", { name: "Delete" }).click();
  await expect(stopped()).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(stopped()).toHaveCount(1);
  await page.reload();
  await expect(stopped()).toHaveCount(1);

  // The employee sees the change.
  await employee.page.reload();
  await expect(employee.page.getByRole("heading", { name: "Start a timer" })).toBeVisible();
});

test("reports: totals by customer, costs frozen at approval, and a CSV", async () => {
  const { page } = admin;
  // A raise after approval doesn't change approved time's cost.
  await page.goto("/admin/rates");
  await choose(page, "Rate for", "A person");
  await choose(page, "Person", "Eddie Employee");
  await page.getByLabel("Hourly rate").fill("45");
  await page.getByRole("button", { name: "Set rate" }).click();
  await expect(toast(page, "Rate set: $45.00/h")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Eddie Employee" })).toHaveCount(1);

  await page.getByRole("link", { name: "Reports" }).click();
  await expect(page.getByRole("row", { name: /Eddie Employee/ })).toBeVisible();
  await choose(page, "Group by", "Customer");
  await expect(page).toHaveURL(/by=customer/);
  const echoRow = page.getByRole("row", { name: /Echo Co/ });
  await expect(echoRow).toContainText("2h");
  await expect(echoRow).toContainText("$80.00");
  await shot(page, "reports");

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^time-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await file.path())!, "utf8");
  expect(csv).toContain("Date,Person,Category,Customer,Job,Start,End,Hours,Status,Rate,Cost,Note,Entry ID");
  expect(csv).toContain(`${TODAY},Eddie Employee,Field crew,Echo Co,Echo Co:Echo Works,9:00 AM,11:00 AM,2,Approved,40,80,Framing,`);
});

test("reopening a week unlocks it again", async () => {
  const { page } = admin;
  await page.getByRole("link", { name: "Timesheets" }).first().click();
  const eddie = page.getByRole("group", { name: "Eddie Employee" });
  // Part approved: the stopped timer waits, the rest can be reopened.
  await expect(eddie.getByRole("button", { name: "Approve Eddie Employee's week" })).toHaveText("Approve 1");
  await eddie.getByRole("button", { name: "Reopen Eddie Employee's week" }).click();
  await expect(toast(page, "Eddie Employee: Reopened 2 entries.")).toBeVisible();
  await expect(eddie.getByRole("button", { name: "Approve Eddie Employee's week" })).toHaveText("Approve 3");

  await employee.page.reload();
  const framing = employee.page.locator(".mantine-Card-root", { hasText: "Framing" });
  await expect(framing.getByRole("button", { name: "Delete" })).toBeVisible();
});

test("weeks can start on another day", async () => {
  const { page } = admin;
  await page.goto("/admin/settings");
  await choose(page, "Weeks start on", "Monday");
  await expect(toast(page, "Weeks now start on Monday.")).toBeVisible();
  await page.goto("/admin/timesheets");
  await expect(
    page.getByRole("group", { name: "Eddie Employee" }).getByRole("link", { name: /^Eddie Employee, / }).first(),
  ).toHaveAttribute("aria-label", /^Eddie Employee, Mon, /);

  // Put it back for the specs that follow.
  await page.goto("/admin/settings");
  await choose(page, "Weeks start on", "Sunday");
  await expect(toast(page, "Weeks now start on Sunday.")).toBeVisible();
});

test("the app's name and colour are set by an admin", async () => {
  const { page } = admin;
  await page.getByRole("link", { name: "Settings" }).click();
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toHaveValue("E2E Time");
  await name.fill("Crew Hours");
  await page.getByRole("textbox", { name: "Short name" }).fill("Hours");
  await page.getByRole("textbox", { name: "Colour" }).fill("#0ca678");
  await page.keyboard.press("Tab"); // leaving the field closes the colour picker
  await expect(page.locator(".mantine-Badge-root", { hasText: "Crew Hours" })).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".mantine-Notification-root", { hasText: "Saved." })).toBeVisible();

  // Everywhere the name appears, it's the new one.
  await page.reload();
  await expect(page.getByRole("banner").getByRole("link", { name: "Crew Hours" })).toBeVisible();
  await expect(page).toHaveTitle("Settings · Crew Hours");
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ name: "Crew Hours", short_name: "Hours", theme_color: "#0ca678" });
  await shot(page, "settings");

  // Back to the deployment's defaults, for the specs that follow.
  await page.getByRole("button", { name: /^Use the defaults/ }).click();
  await expect(page.getByRole("banner").getByRole("link", { name: "E2E Time" })).toBeVisible();
  expect((await (await page.request.get("/manifest.webmanifest")).json()).name).toBe("E2E Time");
});

test("on a phone, the admin pages fit", async ({ browser }) => {
  test.skip(!process.env.E2E_SCREENSHOTS, "screenshots only");
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await admin.context.storageState() });
  const page = await phone.newPage();
  for (const path of ["timesheets", "calendar", "reports", "rates", "settings"]) {
    await page.goto(`/admin/${path}`);
    await shot(page, `phone-${path}`);
  }
  await phone.close();
});
