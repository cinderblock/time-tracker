import { OpError } from "../../src/op-error.ts";
import { applyOps } from "../../src/ops.ts";
import { assertSameOrigin, getAuth, isPost, readJson } from "../auth.server.ts";
import type { Route } from "./+types/api.ops";

/**
 * POST /api/ops — apply a batch of tracking operations for the signed-in
 * person. Body: `{ ops: Op[] }`. Answers `{ results: OpResult[] }`, one per op,
 * in order; a rejected op doesn't stop the ones after it.
 */
export async function action({ request, context }: Route.ActionArgs) {
  isPost(request);
  assertSameOrigin(request);
  const auth = getAuth(context);
  if (!auth) {
    // JSON, not a redirect: this is called by fetch, and the offline outbox
    // needs to tell "signed out" apart from "server unreachable".
    return Response.json({ error: "Signed out.", code: "signed_out" }, { status: 401 });
  }
  const body = await readJson(request);
  try {
    return Response.json({ results: applyOps(auth.user.id, body.ops) });
  } catch (err) {
    if (err instanceof OpError) return Response.json({ error: err.message, code: err.code }, { status: 400 });
    throw err;
  }
}
