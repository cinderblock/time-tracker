import { LIMITS, clientErrorBatch } from "../../src/bug-schema.ts";
import { recordClientErrors } from "../../src/client-errors.ts";
import { assertSameOrigin, getAuth, isPost, readJsonLimited } from "../auth.server.ts";
import type { Route } from "./+types/api.client-errors";

/**
 * POST /api/client-errors — errors from a browser, sent by the page on its
 * own (app/bugs/errors.ts). Body: `{ errors: ClientError[] }`.
 *
 * Signed out is allowed: a failing sign-in is exactly what's worth hearing
 * about. Those are stored without a name, under one shared rate limit. Answers 204; a malformed batch is refused, and the page
 * doesn't try again.
 */
export async function action({ request, context }: Route.ActionArgs) {
  isPost(request);
  assertSameOrigin(request);
  const auth = getAuth(context);
  const body = await readJsonLimited(request, LIMITS.errorBatchBytes);
  const parsed = clientErrorBatch.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Malformed error report." }, { status: 400 });
  recordClientErrors({
    errors: parsed.data.errors,
    userId: auth?.user.id ?? null,
    // Signed out, everyone shares one allowance: rare, and an address
    // header is the sender's to make up.
    sender: auth ? `user:${auth.user.id}` : "signed-out",
    userAgent: request.headers.get("User-Agent"),
    now: Date.now(),
  });
  return new Response(null, { status: 204 });
}
