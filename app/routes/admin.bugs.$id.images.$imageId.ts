import { getBugReportImage } from "../../src/bug-reports.ts";
import { requireAdmin } from "../auth.server.ts";
import type { Route } from "./+types/admin.bugs.$id.images.$imageId";

/** GET /admin/bugs/:id/images/:imageId — one of a report's screenshots. */
export function loader({ request, context, params }: Route.LoaderArgs) {
  requireAdmin(context, request);
  const image = getBugReportImage(params.id, Number(params.imageId));
  if (!image) throw new Response("Not found.", { status: 404 });
  return new Response(image.data.slice(), {
    headers: { "Content-Type": image.mime, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" },
  });
}
