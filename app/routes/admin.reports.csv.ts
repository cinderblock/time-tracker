import { config } from "../../src/config.server.ts";
import { linesToCsv, reportLines } from "../../src/reports.ts";
import { reportQuery } from "../admin.server.ts";
import { requireAdmin } from "../auth.server.ts";
import type { Route } from "./+types/admin.reports.csv";

// The byte-order mark makes Excel read the file as UTF-8.
const BOM = String.fromCharCode(0xfeff);

/**
 * GET /admin/reports.csv — every entry a report covers, one per line, with
 * the same filters as the reports page.
 */
export function loader({ request, context }: Route.LoaderArgs) {
  requireAdmin(context, request);
  const query = reportQuery(new URL(request.url));
  const csv = linesToCsv(reportLines(query.filter), config.timezone);
  return new Response(`${BOM}${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="time-${query.from}-to-${query.to}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
