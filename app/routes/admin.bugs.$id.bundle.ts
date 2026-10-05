import { reportBundle } from "../../src/bug-reports.ts";
import { requireAdmin } from "../auth.server.ts";
import type { Route } from "./+types/admin.bugs.$id.bundle";

/** GET /admin/bugs/:id/bundle.zip — the whole report, for an agent: report.md, context.json, screenshots. */
export function loader({ request, context, params }: Route.LoaderArgs) {
  requireAdmin(context, request);
  const bundle = reportBundle(params.id);
  if (!bundle) throw new Response("That report no longer exists.", { status: 404 });
  return new Response(bundle.zip.slice(), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${bundle.name}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
