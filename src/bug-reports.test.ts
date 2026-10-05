import { beforeEach, describe, expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";

import { createBugReport, deleteBugReport, getBugReport, getBugReportImage, listBugReports, openBugReportIds, reportBundle, setBugReportStatus } from "./bug-reports.ts";
import type { BugReportPayload } from "./bug-schema.ts";
import { LIMITS } from "./bug-schema.ts";
import { db } from "./db.server.ts";
import { OpError } from "./op-error.ts";
import { freshDb } from "./testing/db.ts";
import { createUser } from "./users.ts";
import { uuidv7 } from "./uuid.ts";

const NOW = Date.parse("2026-10-05T20:00:00Z");
const SERVER = { revision: "1111111111111111111111111111111111111111", buildId: "b1", builtAt: null };
// A 1×1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

let alice = 0;
let bob = 0;
beforeEach(() => {
  freshDb();
  alice = createUser({ name: "Alice", role: "employee", actorUserId: null }).id;
  bob = createUser({ name: "Bob", role: "admin", actorUserId: null }).id;
});

const payload = (over: Partial<BugReportPayload> = {}): BugReportPayload => ({
  id: uuidv7(),
  at: NOW - 60_000,
  description: "Turning notes into hours did nothing",
  expected: "The hours to show up on the right",
  url: "https://time.example/day/2026-10-01",
  revision: "2222222222222222222222222222222222222222",
  context: { breadcrumbs: [{ at: NOW - 70_000, kind: "click", text: "Turn 2 notes into hours" }], screens: { day: { workDate: "2026-10-01" } } },
  images: [{ kind: "drawn", mime: "image/png", width: 1, height: 1, data: PNG }],
  ...over,
});

const create = (p: unknown, userId = alice, now = NOW) => createBugReport({ userId, payload: p, server: SERVER, userAgent: "Phone", now });

describe("receiving", () => {
  test("a report is stored whole, with its screenshot, and listed as new", () => {
    const p = payload();
    expect(create(p)).toEqual({ id: p.id, duplicate: false });
    const r = getBugReport(p.id)!;
    expect(r).toMatchObject({
      userName: "Alice",
      description: p.description,
      expected: p.expected,
      clientRevision: p.revision,
      serverRevision: SERVER.revision,
      serverBuildId: "b1",
      userAgent: "Phone",
      status: "new",
      images: 1,
    });
    expect(r.context).toEqual(p.context);
    expect(r.imageList).toEqual([
      { id: expect.any(Number), kind: "drawn", mime: "image/png", width: 1, height: 1, bytes: Buffer.from(PNG, "base64").length },
    ]);
    expect(getBugReportImage(p.id, r.imageList[0]!.id)!.mime).toBe("image/png");
    expect(listBugReports().map((x) => x.id)).toEqual([p.id]);
    expect(openBugReportIds()).toEqual([p.id]);
  });

  test("the same report sent again is acknowledged, not stored twice; someone else's id is refused", () => {
    const p = payload();
    create(p);
    expect(create(p)).toEqual({ id: p.id, duplicate: true });
    expect(db().query("SELECT COUNT(*) AS n FROM bug_reports").get()).toEqual({ n: 1 });
    expect(() => create(p, bob)).toThrow(OpError);
  });

  test("malformed, oversized and too many are refused", () => {
    expect(() => create({ ...payload(), description: "  " })).toThrow("Say what you were trying to do.");
    const big = "A".repeat(Math.ceil((LIMITS.imageBytes * 4) / 3) + 100);
    expect(() => create(payload({ images: [{ kind: "drawn", mime: "image/png", data: big }] }))).toThrow(OpError);
    for (let i = 0; i < 20; i++) create(payload({ images: [] }));
    expect(() => create(payload({ images: [] }))).toThrow("That's a lot of reports in an hour.");
    // An hour later, fine again.
    expect(create(payload({ images: [] }), alice, NOW + 3600_001).duplicate).toBe(false);
  });
});

describe("dealing with them", () => {
  test("status changes are audited; delete removes the screenshots too", () => {
    const p = payload();
    create(p);
    setBugReportStatus({ id: p.id, status: "fixed", note: " in abc1234 ", actorUserId: bob, now: NOW });
    expect(getBugReport(p.id)).toMatchObject({ status: "fixed", statusNote: "in abc1234", statusByName: "Bob" });
    expect(openBugReportIds()).toEqual([]);
    expect(
      db().query("SELECT action, after_json FROM audit_log WHERE entity = 'bug_report' ORDER BY id").all(),
    ).toEqual([
      { action: "create", after_json: null },
      { action: "status", after_json: JSON.stringify({ status: "fixed", note: "in abc1234" }) },
    ]);
    deleteBugReport({ id: p.id, actorUserId: bob, now: NOW });
    expect(getBugReport(p.id)).toBeNull();
    expect(db().query("SELECT COUNT(*) AS n FROM bug_report_images").get()).toEqual({ n: 0 });
    expect(() => deleteBugReport({ id: p.id, actorUserId: bob, now: NOW })).toThrow(OpError);
  });

  test("the bundle for an agent: a readable summary, everything gathered, the screenshot", () => {
    const p = payload();
    create(p);
    const bundle = reportBundle(p.id)!;
    expect(bundle.name).toBe(`bug-report-2026-10-05-2222222-${p.id.slice(-8)}.zip`);
    const files = unzipSync(bundle.zip);
    expect(Object.keys(files).sort()).toEqual(["context.json", "report.md", "screenshot-1-drawn.png"]);
    const md = strFromU8(files["report.md"]!);
    expect(md).toContain("Turning notes into hours did nothing");
    expect(md).toContain("**not the server's**"); // the page ran another build than the server
    expect(md).toContain("`breadcrumbs`");
    const context = JSON.parse(strFromU8(files["context.json"]!)) as Record<string, unknown>;
    expect(context).toMatchObject({ id: p.id, reportedBy: { name: "Alice" }, breadcrumbs: p.context.breadcrumbs, screens: p.context.screens });
    expect(reportBundle(uuidv7())).toBeNull();
  });
});
