import { execFileSync } from "node:child_process";

import { type Browser, type BrowserContext, type Locator, type Page, expect, test } from "@playwright/test";

import { e2eEnv } from "../playwright.config.ts";

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

const timerCard = () => page.locator(".mantine-Card-root", { has: page.getByRole("button", { name: "Stop" }) });
const entryRows = () =>
  page.locator(".mantine-Card-root", { has: page.getByRole("button", { name: /^Edit / }) });

test.afterAll(async () => {
  await ctx?.close();
});

test("set up: a person and two jobs", async ({ browser }) => {
  ({ context: ctx, page } = await signUp(browser, "Tess Tracker"));
  await page.getByRole("link", { name: "Jobs" }).click();
  for (const name of ["Alpha Site", "Bravo Site"]) {
    await page.getByLabel("New job").fill(name);
    await page.getByRole("button", { name: "Add job" }).click();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await expect(page.getByLabel("New job")).toHaveValue("");
  }
});

test("start, pause and resume a timer", async () => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start a timer" })).toBeVisible();
  await pickJob(page.getByPlaceholder("Any job — type to search"), "Alpha Site");

  const card = timerCard();
  await expect(card.getByRole("heading", { name: "Alpha Site" })).toBeVisible();
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
  const alphaRow = admin.locator(".mantine-Card-root", { hasText: "Alpha Site" });
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

test("jot notes through the day, then turn them into time", async () => {
  const noteBox = page.getByPlaceholder("What are you working on now?");
  await noteBox.fill("Measuring the east wall");
  await pickJob(page.getByPlaceholder("Job (optional)").first(), "Bravo Site");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText("Measuring the east wall")).toBeVisible();

  await noteBox.fill("Cutting studs");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText("Cutting studs")).toBeVisible();

  await page.getByRole("button", { name: "Turn 2 notes into time" }).click();
  const review = page.getByRole("dialog", { name: "Turn notes into time" });
  // Both notes are on Bravo and consecutive, so they merge into one line.
  await expect(review.getByText("2 notes")).toBeVisible();
  // They were written moments apart; give the line a real span.
  await review.getByLabel("From").fill("08:00");
  await review.getByLabel("Last note runs until").fill("09:15");
  await review.getByRole("button", { name: "Add 1 entry" }).click();
  await expect(review).toBeHidden();

  const row = entryRows().filter({ hasText: "Measuring the east wall; Cutting studs" });
  await expect(row.getByText("from notes")).toBeVisible();
  await expect(row.getByText("1h 15m")).toBeVisible();
  await expect(page.getByText("added to time")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Turn \d+ notes? into time/ })).toHaveCount(0);
});

test("create a job on the spot while starting a timer", async () => {
  await page.getByRole("button", { name: "New job…" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New job" });
  await dialog.getByLabel("Job name").fill("Charlie Emergency");
  await dialog.getByRole("button", { name: "Create job" }).click();
  await expect(timerCard().getByRole("heading", { name: "Charlie Emergency" })).toBeVisible();
  await timerCard().getByRole("button", { name: "Stop" }).click();
  await expect(entryRows().filter({ hasText: "Charlie Emergency" })).toHaveCount(1);
});
