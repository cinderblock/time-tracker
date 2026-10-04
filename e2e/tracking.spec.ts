import { execFileSync } from "node:child_process";

import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
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
  // Not a job's notes section, whose rows open for editing the same way.
  page.locator(".mantine-Card-root:not([role='group'])", { has: page.getByRole("button", { name: /^Edit / }) });

test.afterAll(async () => {
  await ctx?.close();
});

/**
 * What the open dialog's title was on each animation frame while `act` ran,
 * runs of identical frames collapsed. Mantine keeps a modal mounted through
 * its exit transition, so a dialog whose subject the close clears renders its
 * other self for those frames unless something holds it — see
 * app/components/use-held-open.ts.
 */
async function dialogTitlesWhile(act: () => Promise<void>, settleMs = 600) {
  const probe = () => (window as unknown as { __frames: string[] }).__frames;
  await page.evaluate(() => {
    const frames: string[] = [];
    (window as unknown as { __frames: string[] }).__frames = frames;
    const tick = () => {
      const dialog = document.querySelector("[role=dialog]");
      frames.push(dialog ? (dialog.querySelector(".mantine-Modal-title")?.textContent ?? "?") : "(gone)");
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await act();
  await page.waitForTimeout(settleMs);
  const frames = await page.evaluate(probe);
  return frames.filter((f, i) => f !== frames[i - 1]);
}

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
    await expect(page.getByRole("group", { name: `Riverside › ${name}` })).toBeVisible();
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
  await expect(page.getByRole("option", { name: "Riverside › Bravo Site", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Bravo Site", exact: true })).toBeVisible();
  // A customer is a heading, never a choice.
  await expect(page.getByRole("option", { name: "Riverside", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("a job's sub-jobs nest under it, instead of lines repeating its name", async () => {
  // A customer whose job has sub-jobs, the shape QuickBooks sends.
  const hillside = uuidv7();
  const phase = uuidv7();
  await send(ctx.request, "job.create", { jobId: hillside, name: "Hillside" });
  await send(ctx.request, "job.create", { jobId: phase, name: "Phase 1", parentId: hillside });
  await send(ctx.request, "job.create", { jobId: uuidv7(), name: "Roof", parentId: phase });
  await send(ctx.request, "job.create", { jobId: uuidv7(), name: "Deck", parentId: phase });
  await page.reload();

  // The manual-entry picker: inspecting the running timer's would switch it.
  await page.getByRole("button", { name: "Add time manually" }).click();
  const dialog = page.getByRole("dialog", { name: "Add time" });
  const picker = dialog.getByRole("combobox", { name: /^Job/ });
  await picker.click();
  const dropdown = page.getByRole("listbox");

  // Every row carries its own name; where it sits is drawn, not spelled out.
  // Phase 1 holds the other two, so it's the way to them rather than a choice.
  const heading = dropdown.getByRole("option", { name: "Phase 1 sub-jobs only", exact: true });
  await expect(heading).toBeVisible();
  await expect(heading).toHaveAttribute("data-combobox-disabled", "true");
  await expect(dropdown.getByRole("option", { name: "Deck", exact: true })).toBeVisible();
  await expect(dropdown.getByRole("option", { name: /Phase 1.Deck/ })).toHaveCount(0);
  const leftEdge = async (option: Locator) => (await option.locator("span").first().boundingBox())!.x;
  const optionNamed = (name: string) => dropdown.getByRole("option", { name, exact: true });
  expect(await leftEdge(optionNamed("Deck"))).toBeGreaterThan(await leftEdge(heading));
  // Siblings in order, under the job they belong to — at the same indent, to
  // within a pixel. Exact equality of two separately-measured boxes is a
  // promise about float arithmetic and a runner's font rendering, not about
  // indentation: CI once read 467.875 against 468.46875 for two spans that
  // are laid out identically. An indent step is many pixels wide, so a pixel
  // of slack costs the assertion nothing.
  const [roof, deck] = [await leftEdge(optionNamed("Roof")), await leftEdge(optionNamed("Deck"))];
  expect(Math.abs(roof - deck), `Roof at ${roof}, Deck at ${deck}`).toBeLessThan(1);
  const dir = process.env.E2E_SCREENSHOTS;
  if (dir) await page.screenshot({ path: `${dir}/job-picker-nested.png` });

  // Tapping the heading chooses nothing: the field keeps what it had.
  const before = await picker.inputValue();
  await heading.click();
  await expect(picker).toHaveValue(before);
  await expect(dropdown).toBeVisible();

  // Searching keeps the jobs above a match, so the way to it still reads —
  // and drops a customer with nothing left under it.
  await picker.fill("Deck");
  await expect(dropdown.getByRole("option", { name: "Deck", exact: true })).toBeVisible();
  await expect(heading).toBeVisible();
  await expect(dropdown.getByRole("option", { name: "Roof", exact: true })).toHaveCount(0);
  await expect(dropdown.getByText("Hillside", { exact: true })).toBeVisible();
  await expect(dropdown.getByText("Riverside", { exact: true })).toHaveCount(0);

  // Chosen, the whole path names it — with "›", never the stored ":".
  await dropdown.getByRole("option", { name: "Deck", exact: true }).click();
  await expect(picker).toHaveValue("Hillside › Phase 1 › Deck");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // The Jobs page nests them the same way, each named within the row above it.
  const admin = await ctx.newPage();
  await admin.goto("/admin/jobs");
  const parent = admin.getByRole("group", { name: "Hillside › Phase 1", exact: true });
  await expect(parent.getByText("Phase 1", { exact: true })).toBeVisible();
  await expect(parent.getByRole("group", { name: "Hillside › Phase 1 › Deck" }).getByText("Deck", { exact: true })).toBeVisible();

  // Whether a job takes hours is the admin's to set: Phase 1 holds sub-jobs,
  // so it takes none by default, and saying otherwise puts it back in reach.
  const hours = parent.getByRole("switch", { name: "Takes hours" }).first();
  await expect(hours).not.toBeChecked();
  await expect(parent.getByText("It holds sub-jobs, so hours go on those.")).toBeVisible();
  await hours.click({ force: true });
  await expect(admin.locator(".mantine-Notification-root").filter({ hasText: "Time can be booked to “Hillside › Phase 1”" })).toBeVisible();
  await admin.close();

  await page.reload();
  await page.getByRole("button", { name: "Add time manually" }).click();
  await page.getByRole("dialog", { name: "Add time" }).getByRole("combobox", { name: /^Job/ }).click();
  const nowPickable = page.getByRole("listbox").getByRole("option", { name: "Phase 1", exact: true });
  await expect(nowPickable).toBeVisible();
  await expect(nowPickable).not.toHaveAttribute("data-combobox-disabled", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Add time" }).getByRole("button", { name: "Cancel" }).click();
});

test("an accidental timer is discarded without a question, and undo brings it back", async () => {
  await timerCard().getByRole("button", { name: "Discard this timer" }).click();
  await expect(page.getByRole("heading", { name: "Start a timer" })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(timerCard().getByRole("heading", { name: "Alpha Site" })).toBeVisible();
  await expect(timerCard().getByText("running", { exact: true })).toBeVisible();
});

test("stopping a timer can be undone, from the header and from the keyboard", async () => {
  const card = timerCard();
  await expect(card.getByRole("heading", { name: "Alpha Site" })).toBeVisible();
  await card.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("heading", { name: "Start a timer" })).toBeVisible();
  // The way back names what it undoes, and brings the timer back running.
  await page.getByRole("button", { name: "Undo stopping the timer" }).click();
  await expect(timerCard().getByRole("heading", { name: "Alpha Site" })).toBeVisible();
  await expect(timerCard().getByText("running", { exact: true })).toBeVisible();
  // An undo is not itself undoable — Ctrl+Z walks back through changes rather
  // than ping-ponging between the last two — so the line is empty again.
  await expect(page.getByRole("button", { name: /^Undo / })).toHaveCount(0);
  // Stopped again, and undone from the keyboard, from anywhere that isn't a text field.
  await timerCard().getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("heading", { name: "Start a timer" })).toBeVisible();
  // Undo is offered once the server has taken the stop (a refused change has
  // nothing to undo); pressing it before then finds nothing to put back.
  await expect(page.getByRole("button", { name: "Undo stopping the timer" })).toBeVisible();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(timerCard().getByText("running", { exact: true })).toBeVisible();
});

test("a job that needs a note won't stop without one", async () => {
  // Turn the requirement on for Alpha, in another tab.
  const admin = await ctx.newPage();
  await admin.goto("/admin/jobs");
  const alphaRow = admin.getByRole("group", { name: "Riverside › Alpha Site" });
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
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(entryRows().filter({ hasText: "Bravo Site" })).toHaveCount(1);
});

test("time for a job already worked today joins its line, and undoes back off it", async () => {
  const bravo = () => entryRows().filter({ hasText: "Bravo Site" });
  await expect(bravo()).toHaveCount(1);
  await page.getByRole("button", { name: "Add time manually" }).click();
  const dialog = page.getByRole("dialog", { name: "Add time" });
  await pickJob(dialog.getByRole("combobox", { name: /^Job/ }), "Bravo Site");
  await dialog.getByText("Just a duration").click();
  await dialog.getByLabel("Time worked").fill("30m");
  await dialog.getByRole("button", { name: "Add time" }).click();
  await expect(dialog).toBeHidden();

  // Still one line for Bravo, holding both.
  await expect(bravo()).toHaveCount(1);
  await expect(bravo().getByText(/, plus 30m without times$/)).toBeVisible();
  await page.getByRole("button", { name: "Undo adding time" }).click();
  await expect(bravo().getByText(/plus 30m without times/)).toHaveCount(0);
  await expect(bravo()).toHaveCount(1);
});

test("add time by hand, as a plain duration", async () => {
  await page.getByRole("button", { name: "Add time manually" }).click();
  const dialog = page.getByRole("dialog", { name: "Add time" });
  // A job with no hours yet today: this is its own line.
  await pickJob(dialog.getByRole("combobox", { name: /^Job/ }), "Roof");
  await dialog.getByText("Just a duration").click();
  // One field, decimal hours; it says back what it understood.
  await dialog.getByLabel("Time worked").fill("1.5");
  await expect(dialog.getByText("1h 30m")).toBeVisible();
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
  // A typed-in duration is edited as a duration, in clock form.
  await expect(dialog.getByLabel("Time worked")).toHaveValue("1:30");
  await dialog.getByLabel("Time worked").fill("1h45");
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

test("a timer's entry can become a plain duration, and a duration can get times", async () => {
  const row = () => entryRows().filter({ hasText: "Paperwork" });
  await expect(row().getByText("Duration only")).toBeVisible();

  // A duration takes on times. The toggle is the same one "Add time" offers,
  // and it says what saving will do before it does it.
  await row().getByRole("button", { name: /^Edit / }).click();
  const dialog = page.getByRole("dialog", { name: "Edit entry" });
  await dialog.getByText("Start & end").click();
  await expect(dialog.getByText("Saving replaces the duration with these times.")).toBeVisible();
  await dialog.getByRole("textbox", { name: "Start", exact: true }).fill("08:00");
  await dialog.getByRole("textbox", { name: "End", exact: true }).fill("10:00");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(row().getByText("Duration only")).toHaveCount(0);
  await expect(row().getByText("2h")).toBeVisible();

  // And back: the times go, and the typed duration is what's left.
  await row().getByRole("button", { name: /^Edit / }).click();
  await expect(dialog.getByRole("textbox", { name: "Start", exact: true })).toHaveValue("08:00");
  await dialog.getByText("Just a duration").click();
  await expect(dialog.getByText("Saving replaces the start and end with this duration.")).toBeVisible();
  // Seeded with what the entry already holds, so agreeing is one tap.
  await expect(dialog.getByLabel("Time worked")).toHaveValue("2:00");
  await dialog.getByLabel("Time worked").fill("45m");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(row().getByText("Duration only")).toBeVisible();
  await expect(row().getByText("45m")).toBeVisible();
});

test("the editor keeps its own face all the way through closing", async () => {
  await entryRows().filter({ hasText: "Paperwork" }).getByRole("button", { name: /^Edit / }).click();
  const dialog = page.getByRole("dialog", { name: "Edit entry" });
  await expect(dialog).toBeVisible();

  const titles = await dialogTitlesWhile(() => dialog.getByRole("button", { name: "Cancel" }).click());
  // An "Add time" in here means the list cleared the entry being edited while
  // the dialog was still on screen, and it spent the fade-out as the create
  // form: a different title, a Start & end / Just a duration toggle, and no
  // Delete button.
  expect(titles).toEqual(["Edit entry", "(gone)"]);
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

test("move a week at a time, forward only as far as today", async () => {
  const dayIn = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  // From today there is nowhere forward to go, either way.
  await expect(page.getByRole("button", { name: "Next day" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next week" })).toBeDisabled();

  await page.getByRole("link", { name: "Previous week" }).click();
  await expect(page).toHaveURL(new RegExp(`/day/${dayIn(-7)}$`));
  await page.getByRole("link", { name: "Previous week" }).click();
  await expect(page).toHaveURL(new RegExp(`/day/${dayIn(-14)}$`));

  // Two weeks out, a week forward is a whole week.
  await page.getByRole("link", { name: "Next week" }).click();
  await expect(page).toHaveURL(new RegExp(`/day/${dayIn(-7)}$`));

  // One week out it is not: the same weekday won't come round for another
  // seven days, so rather than refuse, it goes as far as it can — today.
  await page.getByRole("link", { name: "Next week" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
});

/** Where the week strip starts, and where the record beside it does. */
const headerMetrics = () =>
  page.evaluate(() => {
    const strip = document.querySelector('[aria-current="date"]')!.parentElement!;
    const record = [...document.querySelectorAll("h3")].find((h) => h.textContent === "Time")!;
    return {
      stripTop: strip.getBoundingClientRect().top + window.scrollY,
      recordTop: record.getBoundingClientRect().top + window.scrollY,
      cellHeights: [...new Set([...strip.children].map((c) => c.getBoundingClientRect().height))],
    };
  });

test("the header is the same height on today as on any other day", async () => {
  // Today's second line is the date and every other day's is a button back to
  // it, and the two are not the same height on their own — which used to move
  // everything below the header by six pixels as you stepped off today.
  const today = await headerMetrics();
  await page.getByRole("link", { name: "Previous day" }).click();
  await expect(page.getByRole("link", { name: "Back to today" })).toBeVisible();
  const other = await headerMetrics();

  expect(other.stripTop).toBe(today.stripTop);
  expect(other.recordTop).toBe(today.recordTop);
  // And every day in the strip is one height, today's ring included.
  expect(today.cellHeights).toHaveLength(1);
  expect(other.cellHeights).toEqual(today.cellHeights);

  await page.getByRole("link", { name: "Back to today" }).click();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
});

test("a day slides its highlight along the strip, a week slides the whole strip, and the arrows stay put", async () => {
  // Which of the named parts the browser animated, and with what. The slide
  // is `tt-day-move-*` / `tt-week-move-*`; the highlight's travel is the
  // browser's own group animation, which only exists when it has somewhere
  // to go; anything the transition left alone gets the browser's own
  // cross-fade, which is what an unchanged week strip should get.
  const slidWhile = async (act: () => Promise<void>) => {
    await page.evaluate(() => {
      const seen = new Set<string>();
      (window as unknown as { __slid: Set<string> }).__slid = seen;
      const tick = () => {
        for (const a of document.getAnimations()) {
          const pseudo = (a.effect as KeyframeEffect | null)?.pseudoElement;
          if (pseudo?.startsWith("::view-transition-new") || pseudo === "::view-transition-group(tt-day-selected)") {
            seen.add(`${pseudo} ${(a as CSSAnimation).animationName}`);
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await act();
    await page.waitForTimeout(400);
    return page.evaluate(() => [...(window as unknown as { __slid: Set<string> }).__slid].sort());
  };

  const day = await slidWhile(async () => {
    await page.getByRole("link", { name: "Previous day" }).click();
    await expect(page.getByRole("link", { name: "Back to today" })).toBeVisible();
  });
  expect(day).toContain("::view-transition-new(tt-day-title) tt-day-move-in");
  expect(day).toContain("::view-transition-new(tt-day-body) tt-day-move-in");
  // The week didn't change, so the strip sits still under the moving day —
  // and the highlight travels along it on its own.
  expect(day).not.toContain("::view-transition-new(tt-week-strip) tt-week-move-in");
  expect(day.some((a) => a.startsWith("::view-transition-group(tt-day-selected) "))).toBe(true);

  const week = await slidWhile(async () => {
    await page.getByRole("link", { name: "Previous week" }).click();
  });
  expect(week).toContain("::view-transition-new(tt-week-strip) tt-week-move-in");
  expect(week).toContain("::view-transition-new(tt-day-body) tt-day-move-in");
  // The highlight left with its week rather than flying across to the new one.
  expect(week.some((a) => a.startsWith("::view-transition-group(tt-day-selected) "))).toBe(false);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
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
  const emergency = entryRows().filter({ hasText: "Charlie Emergency" });
  await expect(emergency).toHaveCount(1);
  await expect(emergency.getByText("Delta Homes", { exact: true })).toBeVisible();

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
  const bravo = page.getByRole("group", { name: "Riverside › Bravo Site" });
  await expect(bravo.getByText("Started")).toBeVisible();
  // Every op takes a beat from here, so the second note is typed while the
  // first is still in flight — someone jotting a day's work doesn't wait for
  // a spinner. The note box has to empty when Add is pressed rather than when
  // the answer lands, or this typing is wiped and Add sits disabled over a
  // field with words still in it. Without the delay that depends on how
  // loaded the machine is, which is how it reached CI.
  const slowOps = async (route: Route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  };
  await page.route("**/api/ops", slowOps);

  const noteBox = bravo.getByPlaceholder("What did you do?");
  const addNote = bravo.getByRole("button", { name: "Add", exact: true });
  await noteBox.fill("Measuring the east wall");
  await addNote.click();
  await expect(bravo.getByText("Measuring the east wall")).toBeVisible();
  await noteBox.fill("Cutting studs");
  // The first note's answer comes back about here; it must not take this with it.
  await page.waitForTimeout(600);
  await expect(noteBox, "the next note was wiped when the last one landed").toHaveValue("Cutting studs");
  await addNote.click();
  await expect(bravo.getByText("Cutting studs")).toBeVisible();
  // Let that last op out of the handler before taking the delay off; removing
  // a route while a request is still sleeping in it is an error on the route.
  await page.waitForTimeout(600);
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // A second job, later in the day — one tap on a recent job, no searching.
  const recentJobs = page.getByRole("group", { name: "Recent jobs" });
  await recentJobs.getByRole("button", { name: "Alpha Site" }).click();
  const alpha = page.getByRole("group", { name: "Riverside › Alpha Site" });
  await expect(alpha.getByText("Started")).toBeVisible();

  // Tapping a job already on the day is how you say you're back on it: no
  // second section, just the cursor in its note box.
  await recentJobs.getByRole("button", { name: "Bravo Site" }).click();
  await expect(bravo.getByPlaceholder("What did you do?")).toBeFocused();
  await expect(page.getByRole("group", { name: "Riverside › Bravo Site" })).toHaveCount(1);
  await alpha.getByPlaceholder("What did you do?").fill("Site walk");
  await alpha.getByRole("button", { name: "Add", exact: true }).click();
  await expect(alpha.getByText("Site walk")).toBeVisible();

  // Bravo's notes ran until Alpha started, moments later; the hours are set by hand.
  // Bravo already has a line today (its timers, earlier): the notes join it,
  // one line per job per day, and what's asked is the day's total.
  await bravo.getByRole("button", { name: "Turn 2 notes into hours" }).click();
  const dialog = page.getByRole("dialog", { name: "Hours for Riverside › Bravo Site" });
  await expect(dialog.getByLabel("Note")).toHaveValue("Measuring the east wall; Cutting studs");
  await expect(dialog.getByLabel("Worked until")).toHaveCount(0);
  await expect(dialog.getByText(/^Bravo Site already has .* today; these notes join those hours, as one line\.$/)).toBeVisible();
  await dialog.getByLabel("Total for the day").fill("1:15");
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/notes-join-line.png` });
  await dialog.getByRole("button", { name: /^Add .* to Bravo Site$/ }).click();
  await expect(dialog).toBeHidden();
  const bravoRows = () => entryRows().filter({ hasText: "Bravo Site" });
  await expect(bravoRows()).toHaveCount(1);
  const row = entryRows().filter({ hasText: "Measuring the east wall; Cutting studs" });
  await expect(row.getByText("1h 15m", { exact: true })).toBeVisible();
  await expect(row.getByText(/, plus .* without times$/)).toBeVisible();
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/line-mixed.png`, fullPage: true });
  await expect(bravo.getByText("added to time")).toHaveCount(3);
  await expect(bravo.getByRole("button", { name: /^Turn .*into hours/ })).toHaveCount(0);

  // A note about work already counted: attached to the line, with no time added.
  await bravo.getByPlaceholder("What did you do?").fill("Swept up");
  await bravo.getByRole("button", { name: "Add", exact: true }).click();
  await bravo.getByRole("button", { name: "Turn 1 note into hours" }).click();
  await dialog.getByLabel("Total for the day").fill("1:15");
  await dialog.getByRole("button", { name: "Attach the notes to Bravo Site" }).click();
  await expect(dialog).toBeHidden();
  await expect(bravoRows()).toHaveCount(1);
  await expect(bravoRows().getByText("1h 15m", { exact: true })).toBeVisible();
  await expect(bravoRows().getByText(/Cutting studs; Swept up/)).toBeVisible();
  // Lowering the hours is the line's own editor's job, not this dialog's.
  await bravo.getByPlaceholder("What did you do?").fill("Loaded the van");
  await bravo.getByRole("button", { name: "Add", exact: true }).click();
  await bravo.getByRole("button", { name: "Turn 1 note into hours" }).click();
  await dialog.getByLabel("Total for the day").fill("30m");
  await expect(dialog.getByText("That's less than the hours already there. To lower those, edit them.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Add .* to Bravo Site$/ })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await bravo.getByRole("button", { name: /^Edit Loaded the van/ }).click();
  await bravo.getByRole("button", { name: "Delete" }).click();

  // Alpha runs to the end of the day: its last run is taken to end now, and
  // the time worked is the person's to correct — no "worked until" to ask.
  await alpha.getByRole("button", { name: "Turn 1 note into hours" }).click();
  const alphaDialog = page.getByRole("dialog", { name: "Hours for Riverside › Alpha Site" });
  await expect(alphaDialog.getByText(/Alpha Site ran .* – /)).toBeVisible();
  await expect(alphaDialog.getByLabel("Worked until")).toHaveCount(0);
  // Alpha has a line already too: the field is the day's total.
  await alphaDialog.getByLabel("Total for the day").fill("45m");
  await alphaDialog.getByRole("button", { name: /^Add .* to Alpha Site$/ }).click();
  await expect(alphaDialog).toBeHidden();
  await expect(entryRows().filter({ hasText: "Site walk" }).getByText("45m", { exact: true })).toBeVisible();
  // Nothing left to turn into hours (the undo line offers to undo the last turning, which is not that).
  await expect(page.getByRole("button", { name: /^Turn .*into hours/ })).toHaveCount(0);
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
  await orphan.getByRole("button", { name: /^Edit / }).click();
  await pickJob(orphan.getByRole("combobox"), "Alpha Site");
  await orphan.getByRole("button", { name: "Save" }).click();
  const alpha = page.getByRole("group", { name: "Riverside › Alpha Site" });
  await expect(alpha.getByText("Left over from yesterday")).toBeVisible();

  await alpha.getByRole("button", { name: "Turn 1 note into hours" }).click();
  const dialog = page.getByRole("dialog", { name: "Hours for Riverside › Alpha Site" });
  await expect(dialog.getByLabel("Worked until")).toHaveCount(0);
  // That day's "Night pour" (3h 30m) is already Alpha's line: an hour more makes 4h 30m.
  await expect(dialog.getByText(/^Alpha Site already has 3h 30m on \w{3}, \w{3} \d+; these notes join those hours, as one line\.$/)).toBeVisible();
  await dialog.getByLabel("Total for the day").fill("4:30");
  await dialog.getByRole("button", { name: "Add 1h to Alpha Site" }).click();
  await expect(dialog).toBeHidden();

  // The way forward opens, and today takes a job again.
  await page.getByRole("link", { name: "Next day" }).click();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.getByPlaceholder("Add a job for today — type to search")).toBeVisible();
});

test("someone who'd rather finish old notes later can turn the hold off where it bites, and back on", async () => {
  const at = Date.now() - 86_400_000;
  const yesterday = new Date(at).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const leftover = uuidv7();
  await send(ctx.request, "note.create", { noteId: leftover, at, text: "Still to sort out" });

  await page.goto("/");
  const held = page.getByRole("alert").filter({ hasText: "isn't finished" });
  await expect(held).toBeVisible();
  const shots = process.env.E2E_SCREENSHOTS;
  if (shots) await page.screenshot({ path: `${shots}/notes-held.png`, fullPage: true });
  await held.getByRole("button", { name: "Start today anyway" }).click();

  // Today takes jobs; the unfinished day is a reminder now, not a wall.
  await expect(held).toHaveCount(0);
  await expect(page.getByPlaceholder("Add a job for today — type to search")).toBeVisible();
  const reminder = page.getByText(/still has a note to turn into hours/);
  await expect(reminder).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/notes-reminder.png`, fullPage: true });
  await page.getByRole("link", { name: /^Go to / }).click();
  await expect(page).toHaveURL(new RegExp(`/day/${yesterday}$`));
  // Moving on from it isn't held either.
  await expect(page.getByText("Turn this day's notes into hours to move on.")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Next day" })).toBeVisible();

  // The Account page has the same switch, to turn the hold back on.
  await page.goto("/account");
  const hold = page.getByLabel("Finish a day's notes before starting the next");
  await expect(hold).not.toBeChecked();
  await hold.check({ force: true });
  await expect(page.getByText("A day's notes will need to be hours before the next day starts.")).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("alert").filter({ hasText: "isn't finished" })).toBeVisible();

  // Leave the day as it was for what follows.
  await send(ctx.request, "note.delete", { noteId: leftover, at: Date.now() });
});

test("a second line for one job, from before one line per job, is flagged and combined on request", async () => {
  // No op can make one now, so it's written straight into the database, as
  // days from before the rule hold them.
  const script = `
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.DATABASE_PATH);
    db.exec("PRAGMA busy_timeout = 5000");
    const user = db.query("SELECT id FROM users WHERE name = 'Tess Tracker'").get();
    const job = db.query("SELECT id FROM jobs WHERE name = 'Bravo Site'").get();
    const day = new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ });
    const now = Date.now();
    db.query(\`INSERT INTO time_entries (id, user_id, job_id, work_date, duration_seconds, untimed_seconds, note, source, status, device_id, client_created_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, 600, 600, 'From before', 'manual', 'draft', 'old', ?, ?, ?)\`)
      .run(crypto.randomUUID(), user.id, job.id, day, now, now, now);
  `;
  execFileSync("bun", ["-e", script], { env: { ...process.env, ...e2eEnv }, stdio: "inherit" });

  await page.goto("/");
  const bravo = () => entryRows().filter({ hasText: "Bravo Site" });
  await expect(bravo()).toHaveCount(2);
  await expect(bravo().getByText("another line for this job")).toHaveCount(2);
  const flag = page.getByRole("alert").filter({ hasText: "Riverside › Bravo Site has 2 lines on this day" });
  await expect(flag).toContainText("It can't be undone.");
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/lines-combine.png`, fullPage: true });
  await flag.getByRole("button", { name: "Combine into one line" }).click();
  await expect(flag).toHaveCount(0);
  await expect(bravo()).toHaveCount(1);
  await expect(bravo().getByText(/From before/)).toBeVisible();
  await page.reload();
  await expect(bravo()).toHaveCount(1);
});

test("half-typed text comes back after a reload — an update, a crash — and goes once it's saved", async () => {
  await page.goto("/");
  // A note box, typed into and not added.
  const bravo = page.getByRole("group", { name: "Riverside › Bravo Site" });
  await bravo.getByPlaceholder("What did you do?").fill("Half a thought about the gutters");
  // An open dialog with things typed into it.
  await page.getByRole("button", { name: "Add time manually" }).click();
  const add = page.getByRole("dialog", { name: "Add time" });
  await add.getByLabel("Note").fill("Unsaved typing");

  await page.reload();
  await expect(page.getByRole("dialog", { name: "Add time" }).getByLabel("Note")).toHaveValue("Unsaved typing");
  await page.getByRole("dialog", { name: "Add time" }).getByRole("button", { name: "Cancel" }).click();
  await expect(bravo.getByPlaceholder("What did you do?")).toHaveValue("Half a thought about the gutters");

  // Saved, or cancelled: nothing comes back.
  await bravo.getByRole("button", { name: "Add", exact: true }).click();
  await expect(bravo.getByText("Half a thought about the gutters")).toBeVisible();
  await page.reload();
  await expect(bravo.getByPlaceholder("What did you do?")).toHaveValue("");
  await expect(page.getByRole("dialog", { name: "Add time" })).toHaveCount(0);
});

/**
 * Last, because it replaces the browser's clock and never puts it back.
 *
 * Only the browser's clock moves: the server's stays where it is, so the copy
 * it hands back still says the same day. What this proves is the part that
 * was missing — that the crossing is noticed at all, and a fresh copy asked
 * for. A page left open overnight used to go on calling the day it loaded on
 * "today" for as long as it stayed open. The arithmetic of *when* to look,
 * across midnights and daylight saving, is in app/tracker/day-steps.test.ts.
 */
test("a page left open past midnight asks for a fresh copy of the day", async () => {
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();

  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes(".data")) asked.push(new URL(r.url()).pathname);
  });

  await page.clock.fastForward("25:00:00");
  await expect.poll(() => asked.length, { message: "the day was never asked for again" }).toBeGreaterThan(0);
});
