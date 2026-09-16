import { data } from "react-router";

import { accountingBackendOrError } from "../../src/accounting/index.ts";
import { qwcFile } from "../../src/accounting/webconnector.ts";
import { config } from "../../src/config.server.ts";
import { webConnectorIds } from "../../src/settings.ts";
import { requireAdmin } from "../auth.server.ts";
import type { Route } from "./+types/admin.accounting.qwc";

/** GET /admin/accounting.qwc — the file that adds this app to the Web Connector. */
export function loader({ request, context }: Route.LoaderArgs) {
  requireAdmin(context, request);
  if (accountingBackendOrError().backend?.kind !== "qb-webconnector") {
    throw data("The Web Connector isn't the configured accounting backend.", { status: 404 });
  }
  const slug = config.branding.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "time-tracker";
  return new Response(qwcFile(webConnectorIds()), {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}.qwc"`,
      "Cache-Control": "no-store",
    },
  });
}
