import { OpError } from "../../src/op-error.ts";
import { applyOps } from "../../src/ops.ts";
import { getUser } from "../../src/users.ts";
import { assertSameOrigin, getAuth, isPost, readJson } from "../auth.server.ts";
import type { Route } from "./+types/api.admin.people.$userId.ops";

/**
 * POST /api/admin/people/:userId/ops — an admin changing someone else's time.
 * Same body and answer as /api/ops; the ops apply to that person and are
 * recorded as made by the admin. Not used by the offline outbox.
 */
export async function action({ request, context, params }: Route.ActionArgs) {
  isPost(request);
  assertSameOrigin(request);
  const auth = getAuth(context);
  if (!auth) return Response.json({ error: "Signed out.", code: "signed_out" }, { status: 401 });
  if (auth.user.role !== "admin") {
    return Response.json({ error: "Only admins can change someone else's time.", code: "forbidden" }, { status: 403 });
  }
  const person = getUser(Number(params.userId));
  if (!person) return Response.json({ error: "There's nobody with that id.", code: "not_found" }, { status: 404 });

  const body = await readJson(request);
  try {
    return Response.json({ results: applyOps({ userId: person.id, actorUserId: auth.user.id }, body.ops) });
  } catch (err) {
    if (err instanceof OpError) return Response.json({ error: err.message, code: err.code }, { status: 400 });
    throw err;
  }
}
