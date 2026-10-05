import { strToU8, zipSync } from "fflate";

import { audit } from "./audit.ts";
import { type BugReportPayload, LIMITS, bugReport } from "./bug-schema.ts";
import { shortRevision } from "./build-info.ts";
import type { ServerBuild } from "./build-info.server.ts";
import { db } from "./db.server.ts";
import { OpError } from "./op-error.ts";

/**
 * Bug reports: a person's "this went wrong", with everything their browser
 * gathered about the moment (app/bugs/). Stored whole, read by admins, and
 * exported as one bundle an agent can work from (`reportBundle`).
 */

export type BugReportStatus = "new" | "fixed" | "wont_fix";

export interface BugReportSummary {
  id: string;
  userId: number;
  userName: string;
  clientTime: number;
  receivedAt: number;
  description: string;
  url: string;
  clientRevision: string;
  serverRevision: string;
  status: BugReportStatus;
  images: number;
}

export interface BugReport extends BugReportSummary {
  expected: string | null;
  serverBuildId: string;
  userAgent: string | null;
  context: Record<string, unknown>;
  statusNote: string | null;
  statusAt: number | null;
  statusByName: string | null;
  imageList: { id: number; kind: "drawn" | "captured"; mime: string; width: number | null; height: number | null; bytes: number }[];
}

// ---- receiving -----------------------------------------------------------------------

const REPORTS_PER_HOUR = 20;

/**
 * Store a report. The id is the device's, so the same report sent again (a
 * lost answer, the offline queue) is accepted once and acknowledged again.
 */
export function createBugReport(args: {
  userId: number;
  payload: unknown;
  server: ServerBuild;
  userAgent: string | null;
  now: number;
}): { id: string; duplicate: boolean } {
  const parsed = bugReport.safeParse(args.payload);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new OpError("invalid", first ? `${first.path.join(".") || "report"}: ${first.message}` : "That report was malformed.");
  }
  const r = parsed.data;
  const existing = db().query<{ user_id: number }, [string]>("SELECT user_id FROM bug_reports WHERE id = ?").get(r.id);
  if (existing) {
    if (existing.user_id !== args.userId) throw new OpError("forbidden", "That report id belongs to someone else.");
    return { id: r.id, duplicate: true };
  }
  const recent = db()
    .query<{ n: number }, [number, number]>("SELECT COUNT(*) AS n FROM bug_reports WHERE user_id = ? AND received_at > ?")
    .get(args.userId, args.now - 3600_000)!.n;
  if (recent >= REPORTS_PER_HOUR) throw new OpError("conflict", "That's a lot of reports in an hour. Try again a little later.");

  const context = JSON.stringify(r.context);
  if (context.length > LIMITS.contextBytes) throw new OpError("invalid", "The report's context is too large.");
  const images = r.images.map((img) => {
    const data = Buffer.from(img.data, "base64");
    if (data.length === 0 || data.length > LIMITS.imageBytes) throw new OpError("invalid", "A screenshot is too large.");
    return { ...img, bytes: data };
  });

  db().transaction(() => {
    db()
      .query(
        `INSERT INTO bug_reports
           (id, user_id, client_time, received_at, description, expected, url, client_revision,
            server_revision, server_build_id, user_agent, context)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        args.userId,
        r.at,
        args.now,
        r.description,
        r.expected || null,
        r.url,
        r.revision,
        args.server.revision,
        args.server.buildId,
        args.userAgent,
        context,
      );
    const put = db().query(
      "INSERT INTO bug_report_images (report_id, kind, mime, width, height, data) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const img of images) put.run(r.id, img.kind, img.mime, img.width ?? null, img.height ?? null, img.bytes);
    audit({ actorUserId: args.userId, entity: "bug_report", entityId: r.id, action: "create", at: args.now });
  })();
  return { id: r.id, duplicate: false };
}

// ---- reading -------------------------------------------------------------------------

interface SummaryRow {
  id: string;
  user_id: number;
  user_name: string;
  client_time: number;
  received_at: number;
  description: string;
  url: string;
  client_revision: string;
  server_revision: string;
  status: BugReportStatus;
  images: number;
}

const SUMMARY_SQL = `
  SELECT r.id, r.user_id, u.name AS user_name, r.client_time, r.received_at, r.description, r.url,
         r.client_revision, r.server_revision, r.status,
         (SELECT COUNT(*) FROM bug_report_images i WHERE i.report_id = r.id) AS images
    FROM bug_reports r JOIN users u ON u.id = r.user_id`;

const toSummary = (r: SummaryRow): BugReportSummary => ({
  id: r.id,
  userId: r.user_id,
  userName: r.user_name,
  clientTime: r.client_time,
  receivedAt: r.received_at,
  description: r.description,
  url: r.url,
  clientRevision: r.client_revision,
  serverRevision: r.server_revision,
  status: r.status,
  images: r.images,
});

/** Reports, the open ones first, newest first. */
export function listBugReports(limit = 200): BugReportSummary[] {
  return db()
    .query<SummaryRow, [number]>(`${SUMMARY_SQL} ORDER BY r.status = 'new' DESC, r.received_at DESC LIMIT ?`)
    .all(limit)
    .map(toSummary);
}

export function getBugReport(id: string): BugReport | null {
  const row = db()
    .query<
      SummaryRow & {
        expected: string | null;
        server_build_id: string;
        user_agent: string | null;
        context: string;
        status_note: string | null;
        status_at: number | null;
        status_by_name: string | null;
      },
      [string]
    >(
      `SELECT r.id, r.user_id, u.name AS user_name, r.client_time, r.received_at, r.description, r.url,
              r.client_revision, r.server_revision, r.status,
              (SELECT COUNT(*) FROM bug_report_images i WHERE i.report_id = r.id) AS images,
              r.expected, r.server_build_id, r.user_agent, r.context, r.status_note, r.status_at,
              s.name AS status_by_name
         FROM bug_reports r JOIN users u ON u.id = r.user_id LEFT JOIN users s ON s.id = r.status_by
        WHERE r.id = ?`,
    )
    .get(id);
  if (!row) return null;
  const imageList = db()
    .query<{ id: number; kind: "drawn" | "captured"; mime: string; width: number | null; height: number | null; bytes: number }, [string]>(
      "SELECT id, kind, mime, width, height, length(data) AS bytes FROM bug_report_images WHERE report_id = ? ORDER BY id",
    )
    .all(id);
  return {
    ...toSummary(row),
    expected: row.expected,
    serverBuildId: row.server_build_id,
    userAgent: row.user_agent,
    context: JSON.parse(row.context) as Record<string, unknown>,
    statusNote: row.status_note,
    statusAt: row.status_at,
    statusByName: row.status_by_name,
    imageList,
  };
}

export function getBugReportImage(reportId: string, imageId: number): { mime: string; data: Uint8Array } | null {
  return db()
    .query<{ mime: string; data: Uint8Array }, [string, number]>(
      "SELECT mime, data FROM bug_report_images WHERE report_id = ? AND id = ?",
    )
    .get(reportId, imageId);
}

/** Ids of reports nobody has dealt with yet. */
export function openBugReportIds(): string[] {
  return db()
    .query<{ id: string }, []>("SELECT id FROM bug_reports WHERE status = 'new' ORDER BY id")
    .all()
    .map((r) => r.id);
}

export function setBugReportStatus(args: {
  id: string;
  status: BugReportStatus;
  note?: string | null;
  actorUserId: number;
  now: number;
}): void {
  const row = db().query<{ status: BugReportStatus }, [string]>("SELECT status FROM bug_reports WHERE id = ?").get(args.id);
  if (!row) throw new OpError("not_found", "That report no longer exists.");
  const note = args.note?.trim() || null;
  db()
    .query("UPDATE bug_reports SET status = ?, status_note = ?, status_at = ?, status_by = ? WHERE id = ?")
    .run(args.status, note, args.now, args.actorUserId, args.id);
  audit({
    actorUserId: args.actorUserId,
    entity: "bug_report",
    entityId: args.id,
    action: "status",
    before: { status: row.status },
    after: { status: args.status, note },
    at: args.now,
  });
}

export function deleteBugReport(args: { id: string; actorUserId: number; now: number }): void {
  const gone = db().query("DELETE FROM bug_reports WHERE id = ?").run(args.id).changes;
  if (!gone) throw new OpError("not_found", "That report no longer exists.");
  audit({ actorUserId: args.actorUserId, entity: "bug_report", entityId: args.id, action: "delete", at: args.now });
}

// ---- the bundle for an agent ---------------------------------------------------------

const EXT: Record<string, string> = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg" };

const iso = (t: number | null | undefined) => (t == null ? "—" : new Date(t).toISOString());

/** The files of a report's bundle: a readable summary, everything gathered, and the screenshots. */
export function reportFiles(id: string): Record<string, Uint8Array> | null {
  const r = getBugReport(id);
  if (!r) return null;
  const images = r.imageList.map((img, i) => ({
    name: `screenshot-${i + 1}-${img.kind}.${EXT[img.mime] ?? "bin"}`,
    img,
    data: getBugReportImage(id, img.id)!.data,
  }));
  const stale = r.clientRevision !== r.serverRevision;
  const md = [
    `# Bug report ${r.id}`,
    "",
    `Reported by **${r.userName}** (user ${r.userId}) at ${iso(r.clientTime)} by their device's clock; received ${iso(r.receivedAt)}.`,
    "",
    "## What they were trying to do",
    "",
    r.description,
    "",
    ...(r.expected ? ["## What happened instead / what they expected", "", r.expected, ""] : []),
    "## Where",
    "",
    `- Page: ${r.url}`,
    `- Code the page was running: \`${r.clientRevision}\`${stale ? " — **not the server's**: the tab was open across an update" : ""}`,
    `- Server: \`${r.serverRevision}\` (build ${r.serverBuildId})`,
    `- Device: ${r.userAgent ?? "unknown"}`,
    `- Status here: ${r.status}${r.statusNote ? ` — ${r.statusNote}` : ""}`,
    "",
    "## Files",
    "",
    "- `context.json` — everything the page gathered when the button was pressed. Its keys:",
    ...Object.keys(r.context)
      .sort()
      .map((k) => `  - \`${k}\``),
    ...images.map((i) => `- \`${i.name}\` — ${i.img.kind === "drawn" ? "the page, drawn by the app when the button was pressed (styling can be slightly off)" : "a real capture of the screen, taken by the person"}`),
    "",
    "## Working from this",
    "",
    `Check out \`${r.clientRevision === "dev" ? r.serverRevision : r.clientRevision}\` of the app repo to read the code this page ran.`,
    "`breadcrumbs` in context.json is what the person did, oldest first, up to the moment they pressed the button;",
    "`errors` is what went wrong in the page; `screens` holds the data the screen was showing.",
    "",
  ].join("\n");
  const files: Record<string, Uint8Array> = {
    "report.md": strToU8(md),
    "context.json": strToU8(
      JSON.stringify(
        {
          id: r.id,
          reportedBy: { id: r.userId, name: r.userName },
          clientTime: r.clientTime,
          receivedAt: r.receivedAt,
          description: r.description,
          expected: r.expected,
          url: r.url,
          clientRevision: r.clientRevision,
          serverRevision: r.serverRevision,
          serverBuildId: r.serverBuildId,
          userAgent: r.userAgent,
          ...r.context,
        },
        null,
        2,
      ),
    ),
  };
  for (const i of images) files[i.name] = i.data;
  return files;
}

/** One zip of `reportFiles`, named for the report. */
export function reportBundle(id: string): { name: string; zip: Uint8Array } | null {
  const files = reportFiles(id);
  if (!files) return null;
  const r = getBugReport(id)!;
  const day = new Date(r.clientTime).toISOString().slice(0, 10);
  return { name: `bug-report-${day}-${shortRevision(r.clientRevision)}-${id.slice(-8)}.zip`, zip: zipSync(files, { level: 6 }) };
}

export type { BugReportPayload };
