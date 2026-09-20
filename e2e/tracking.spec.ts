import { execFileSync } from "node:child_process";

import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  expect,
  test,
} from "@playwright/test";

import { e2eEnv } from "../playwright.config.ts";
import type { OpPayload, OpType } from "../src/ops-schema.ts";
import { uuidv7 } from "../src/uuid.ts";

/**
 * Time tracking through the real UI: timers (start, pause, switch, discard
 * with undo, stop), required notes, manual entries, notes rolled up into
 * time, and moving between days.
 *
 * Runs after auth.spec.ts against the same server, so an admin already
 * exists: `admin-link` hands out an admin invite, used here for a fresh person.
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

/** Choose a job in one of the searchable job pickers. */
async function pickJob(input: Locator, name: string) {
  await input.click();
  await input.fill(name);
  await page.getByRole("option", { name, exact: true }).click();
}

/** A change made straight through the API, as another device of the same person would. */
async function send<T extends OpType>(request: APIRequestContext, type: T, payload: OpPayload<T>) {
  const response = await request.post("/api/ops", {
    headers: { Origin: e2eEnv.PUBLIC_BASE_URL, "Content-Type": "application/json" },
    data: { ops: [{ opId: uuidv7(), type, deviceId: "e2e-other-device", clientTime: Date.now(), payload }] },
  });
  const body = await response.json();
  expect(body.results[0], JSON.stringify(body)).toMatchObject({ ok: true });
}

const timerCard = () => page.locator(".mantine-Card-root", { has: page.getByRole("button", { name: "Stop" }) });
const entryRows = () =>
  page.locator(".mantine-Card-root", { has: page.getByRole("button", { name: /^Edit / }) });

test.afterAll(async () => {
  await ctx?.close();
});

test("set up: a person, a customer and two jobs under it", async ({ browser }) => {
  ({ context: ctx, page } = await signUp(browser, "Tess Tracker"));
  await page.getByRole("link", { name: "Jobs" }).click();
  await page.getByLabel("New customer").fill("Riverside");
  await page.getByRole("button", { name: "Add customer" }).click();
  const customer = page.getByRole("group", { name: "Riverside", exact: true });
  await expect(customer).toBeVisible();
  await expect(page.getByLabel("New customer")).toHaveValue("");
  for (const name of ["Alpha Site", "Bravo Site"]) {
    await customer.getByRole("button", { name: "Add a job" }).click();
    await customer.getByLabel("New job for Riverside").fill(name);
    await customer.getByRole("button", { name: "Add job", exact: true }).click();
    await expect(page.getByRole("group", { name: `Riverside:${name}` })).toBeVisible();
  }
});

test("start, pause and resume a timer", async () => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start a timer" })).toBeVisible();
  await pickJob(page.getByPlaceholder("Any job — type to search"), "Alpha Site");

  const card = timerCard();
  await expect(card.getByRole("heading", { name: "Alpha Site" })).toBeVisible();
  await expect(card.getByText("Riverside", { exact: true })).toBeVisible();
  await expect(card.getByText("running", { exact: true })).toBeVisible();
  await expect(card.getByText(/^00:0\d$/)).toBeVisible(); // ticking elapsed time

  await card.getByRole("button", { name: "Pause" }).click();
  await expect(card.getByText("paused", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Resume" }).click();
  await expect(card.getByText("running", { exact: true })).toBeVisible();
});

test("switch jobs in one step; the first timer stops as the second starts", async () => {
  await pickJob(page.getByPlaceholder("Another job — type to search"), "Bravo Site");
  await expect(timerCard().getByRole("heading", { name: "Bravo Site" })).toBeVisible();

  const alpha = entryRows().filter({ hasText: "Alpha Site" });
  await expect(alpha).toHaveCount(1);
  await expect(alpha.getByText("running")).toHaveCount(0);

  // Alpha is now a recent job: one tap switches back.
  await timerCard().getByRole("button", { name: "Alpha Site" }).click();
  await expect(timerCard().getByRole("heading", { name: "Alpha Site" })).toBeVisible();
  await expect(entryRows().filter({ hasText: "Bravo Site" })).toHaveCount(1);

  // The picker lists recent jobs first (by full path), then each customer's jobs by name.
  await page.getByPlaceholder("Another job — type to search").click();
  await expect(page.getByText("Recent", { exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Riverside:Bravo Site", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Bravo Site", exact: true })).toBeVisible();
  // A customer is a heading, never a choice.
  await expect(page.getByRole("option", { name: "Riverside", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("an accidental timer is discarded without a question, and undo brings it back", async () => {
  await timerCard().getByRole("button", { name: "Discard this timer" }).click();
  await expect(page.getByRole("heading", { name: "Start a timer" })).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(timerCard().getByRole("heading", { name: "Alpha Site" })).toBeVisible();
  await expect(timerCard().getByText("running", { exact: true })).toBeVisible();
});

test("a job that needs a note won't stop without one", async () => {
  // Turn the requirement on for Alpha, in another tab.
  const admin = await ctx.newPage();
  await admin.goto("/admin/jobs");
  const alphaRow = admin.getByRole("group", { name: "Riverside:Alpha Site" });
  await alphaRow.getByRole("switch", { name: "Needs a note" }).click({ force: true });
  await expect(alphaRow.getByRole("switch", { name: "Needs a note" })).toBeChecked();
  await admin.close();

  await page.reload();
  const card = timerCard();
  await card.getByRole("button", { name: "Stop" }).click();
  await expect(card.getByText("This job needs a note before the timer can stop.")).toBeVisible();
  await expect(card.getByRole("heading", { name: "Alpha Site" })).toBeVisible();

  await card.getByLabel("Note").fill("Poured the footings");
  await card.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("heading", { name: "Start a timer" })).toBeVisible();
  await expect(entryRows().filter({ hasText: "Poured the footings" })).toHaveCount(1);
});

test("delete an entry from the list, then undo", async () => {
  const bravo = entryRows().filter({ hasText: "Bravo Site" });
  await bravo.getByRole("button", { name: "Delete" }).click();
  await expect(entryRows().filter({ hasText: "Bravo Site" })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(entryRows().filter({ hasText: "Bravo Site" })).toHaveCount(1);
});

test("add time by hand, as a plain duration", async () => {
  await page.getByRole("button", { name: "Add time manually" }).click();
  const dialog = page.getByRole("dialog", { name: "Add time" });
  await pickJob(dialog.getByRole("combobox", { name: /^Job/ }), "Bravo Site");
  await dialog.getByText("Just a duration").click();
  await dialog.getByLabel("Hours").fill("1");
  await dialog.getByLabel("Minutes").fill("30");
  await dialog.getByLabel("Note").fill("Paperwork");
  await dialog.getByRole("button", { name: "Add time" }).click();
  await expect(dialog).toBeHidden();

  const row = entryRows().filter({ hasText: "Paperwork" });
  await expect(row.getByText("Duration only")).toBeVisible();
  await expect(row.getByText("1h 30m")).toBeVisible();
});

test("edit an entry's times; an end before the start runs past midnight", async () => {
  await entryRows().filter({ hasText: "Paperwork" }).getByRole("button", { name: /^Edit / }).click();
  const dialog = page.getByRole("dialog", { name: "Edit entry" });
  // A typed-in duration is edited as a duration.
  await expect(dialog.getByLabel("Hours")).toHaveValue("1");
  await dialog.getByLabel("Minutes").fill("45");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(entryRows().filter({ hasText: "Paperwork" }).getByText("1h 45m")).toBeVisible();

  await page.getByRole("button", { name: "Add time manually" }).click();
  const add = page.getByRole("dialog", { name: "Add time" });
  await pickJob(add.getByRole("combobox", { name: /^Job/ }), "Alpha Site");
  await add.getByRole("textbox", { name: "Start", exact: true }).fill("22:00");
  await add.getByRole("textbox", { name: "End", exact: true }).fill("01:30");
  await expect(add.getByText("3h 30m — ends the next day")).toBeVisible();
  await add.getByLabel("Note").fill("Night pour");
  // Today's evening hasn't happened yet, so book it on yesterday.
  const yesterday = await page.evaluate(() => {
    const d = new Date(Date.now() - 86_400_000);
    return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  });
  await add.getByLabel("Date").fill(yesterday);
  await add.getByRole("button", { name: "Add time" }).click();
  await expect(add).toBeHidden();
});

test("move to the previous day and back", async () => {
  await page.getByRole("link", { name: "Previous day" }).click();
  await expect(page).toHaveURL(/\/day\/\d{4}-\d{2}-\d{2}$/);
  const night = entryRows().filter({ hasText: "Night pour" });
  await expect(night.getByText("3h 30m")).toBeVisible();
  await expect(night.getByText("10:00 PM – 1:30 AM")).toBeVisible();
  await page.getByRole("link", { name: "Back to today" }).click();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();

  const response = await page.goto("/day/2999-01-01");
  expect(response?.status()).toBe(404);
  await page.goto("/");
});

test("create a job on the spot while starting a timer, at a customer that's new too", async () => {
  await page.getByRole("button", { name: "New job…" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New job" });
  // The known customers are offered; this work is for a new one.
  await expect(dialog.getByRole("combobox", { name: /^Customer/ })).toBeVisible();
  await dialog.getByText("New customer", { exact: true }).click();
  await dialog.getByLabel("Customer name").fill("Delta Homes");
  await dialog.getByLabel("Job name").fill("Charlie Emergency");
  await dialog.getByRole("button", { name: "Create job" }).click();
  const card = timerCard();
  await expect(card.getByRole("heading", { name: "Charlie Emergency" })).toBeVisible();
  await expect(card.getByText("Delta Homes", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Stop" }).click();
  await expect(entryRows().filter({ hasText: "Delta Homes:Charlie Emergency" })).toHaveCount(1);

  // Both are provisional, grouped on the Jobs page like any other.
  await page.goto("/admin/jobs");
  const customer = page.getByRole("group", { name: "Delta Homes", exact: true });
  await expect(customer.getByText("Charlie Emergency", { exact: true })).toBeVisible();
  await page.goto("/");
});

test("switch to notes mode: add a job for the day, jot under it, and turn each job's notes into hours", async () => {
  await page.goto("/account");
  await page.getByRole("radio", { name: "Notes through the day" }).check();
  await expect(page.locator(".mantine-Notification-root").filter({ hasText: "You'll jot notes" })).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start a timer" })).toHaveCount(0);
  await expect(page.getByText(/You track with notes/)).toBeVisible();

  // The first job of the day: from now on, that's what's being done.
  await pickJob(page.getByPlaceholder("Add a job for today — type to search"), "Bravo Site");
  const bravo = page.getByRole("group", { name: "Riverside:Bravo Site" });
  await expect(bravo.getByText("Started")).toBeVisible();
  await bravo.getByPlaceholder("What did you do?").fill("Measuring the east wall");
  await bravo.getByRole("button", { name: "Add", exact: true }).click();
  await expect(bravo.getByText("Measuring the east wall")).toBeVisible();
  await bravo.getByPlaceholder("What did you do?").fill("Cutting studs");
  await bravo.getByRole("button", { name: "Add", exact: true }).click();
  await expect(bravo.getByText("Cutting studs")).toBeVisible();

  // A second job, later in the day.
  await pickJob(page.getByPlaceholder("Add a job for today — type to search"), "Alpha Site");
  const alpha = page.getByRole("group", { name: "Riverside:Alpha Site" });
  await expect(alpha.getByText("Started")).toBeVisible();
  await alpha.getByPlaceholder("What did you do?").fill("Site walk");
  await alpha.getByRole("button", { name: "Add", exact: true }).click();
  await expect(alpha.getByText("Site walk")).toBeVisible();

  // Bravo's notes ran until Alpha started, moments later; the hours are set by hand.
  await bravo.getByRole("button", { name: "Turn 2 notes into hours" }).click();
  const dialog = page.getByRole("dialog", { name: "Hours for Riverside:Bravo Site" });
  await expect(dialog.getByLabel("Note")).toHaveValue("Measuring the east wall; Cutting studs");
  await expect(dialog.getByLabel("Worked until")).toHaveCount(0);
  await dialog.getByLabel("Hours").fill("1");
  await dialog.getByLabel("Minutes").fill("15");
  await dialog.getByRole("button", { name: "Add 1h 15m to Bravo Site" }).click();
  await expect(dialog).toBeHidden();
  const row = entryRows().filter({ hasText: "Measuring the east wall; Cutting studs" });
  await expect(row.getByText("from notes")).toBeVisible();
  await expect(row.getByText("Duration only")).toBeVisible();
  await expect(row.getByText("1h 15m")).toBeVisible();
  await expect(bravo.getByText("added to time")).toHaveCount(3);
  await expect(bravo.getByRole("button", { name: /into hours/ })).toHaveCount(0);

  // Alpha runs to the end of the day, so it asks when that was.
  await alpha.getByRole("button", { name: "Turn 1 note into hours" }).click();
  const alphaDialog = page.getByRole("dialog", { name: "Hours for Riverside:Alpha Site" });
  await expect(alphaDialog.getByLabel("Worked until")).toBeVisible();
  await alphaDialog.getByLabel("Hours").fill("0");
  await alphaDialog.getByLabel("Minutes").fill("45");
  await alphaDialog.getByRole("button", { name: "Add 45m to Alpha Site" }).click();
  await expect(alphaDialog).toBeHidden();
  await expect(entryRows().filter({ hasText: "Site walk" }).getByText("45m")).toBeVisible();
  await expect(page.getByRole("button", { name: /into hours/ })).toHaveCount(0);
});

test("in notes mode, yesterday's notes have to become hours before today's can start", async () => {
  // A note left on yesterday with no job, as another device might leave it.
  const at = Date.now() - 86_400_000;
  const yesterday = new Date(at).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  await send(ctx.request, "note.create", { noteId: uuidv7(), at, text: "Left over from yesterday" });

  await page.reload();
  const held = page.getByRole("alert").filter({ hasText: "isn't finished" });
  await expect(held).toContainText("Turn its note into hours before today's notes start.");
  await expect(page.getByPlaceholder("Add a job for today — type to search")).toHaveCount(0);
  await held.getByRole("link", { name: /^Go to / }).click();
  await expect(page).toHaveURL(new RegExp(`/day/${yesterday}$`));
  await expect(page.getByRole("button", { name: "Next day" })).toBeDisabled();
  await expect(page.getByText("Turn this day's notes into hours to move on.")).toBeVisible();

  // Without a job it can't become hours: give it one.
  const orphan = page.getByRole("group", { name: "No job yet" });
  await expect(orphan.getByText("Left over from yesterday")).toBeVisible();
  await orphan.getByRole("button", { name: "Edit" }).click();
  await pickJob(orphan.getByRole("combobox"), "Alpha Site");
  await orphan.getByRole("button", { name: "Save" }).click();
  const alpha = page.getByRole("group", { name: "Riverside:Alpha Site" });
  await expect(alpha.getByText("Left over from yesterday")).toBeVisible();

  await alpha.getByRole("button", { name: "Turn 1 note into hours" }).click();
  const dialog = page.getByRole("dialog", { name: "Hours for Riverside:Alpha Site" });
  await expect(dialog.getByLabel("Worked until")).toBeVisible();
  await dialog.getByLabel("Hours").fill("1");
  await dialog.getByLabel("Minutes").fill("0");
  await dialog.getByRole("button", { name: "Add 1h to Alpha Site" }).click();
  await expect(dialog).toBeHidden();

  // The way forward opens, and today takes a job again.
  await page.getByRole("link", { name: "Next day" }).click();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.getByPlaceholder("Add a job for today — type to search")).toBeVisible();
});
