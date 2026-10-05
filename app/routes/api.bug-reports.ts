import { LIMITS } from "../../src/bug-schema.ts";
import { createBugReport } from "../../src/bug-reports.ts";
import { serverBuild } from "../../src/build-info.server.ts";
import { OpError } from "../../src/op-error.ts";
import { assertSameOrigin, getAuth, isPost, readJsonLimited } from "../auth.server.ts";
import type { Route } from "./+types/api.bug-reports";

/**
 * POST /api/bug-reports — a person's report of a problem, with what the
 * page gathered (app/bugs/). Body: a `bugReport` (src/bug-schema.ts).
 * Answers `{ id, server }`: the server's build, so the page can tell the
 * person if theirs is out of date. Sending the same report again is fine.
 */
export async function action({ request, context }: Route.ActionArgs) {
  isPost(request);
  assertSameOrigin(request);
  const auth = getAuth(context);
  if (!auth) return Response.json({ error: "Signed out.", code: "signed_out" }, { status: 401 });
  const body = await readJsonLimited(request, LIMITS.reportBytes);
  try {
    const server = serverBuild();
    const { id } = createBugReport({
      userId: auth.user.id,
      payload: body,
      server,
      userAgent: request.headers.get("User-Agent"),
      now: Date.now(),
    });
    return Response.json({ id, server: { revision: server.revision, buildId: server.buildId } });
  } catch (err) {
    if (err instanceof OpError) {
      return Response.json({ error: err.message, code: err.code }, { status: err.code === "forbidden" ? 403 : 400 });
    }
    throw err;
  }
}
