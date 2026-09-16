import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

import { finishSignIn } from "../../src/auth-flows.ts";
import { safeRedirectPath } from "../../src/safe-redirect.ts";
import { revokeSession } from "../../src/sessions.ts";
import {
  assertSameOrigin,
  ceremonyCookie,
  clearCookie,
  getAuth,
  isPost,
  readCookie,
  readJson,
  sessionCookie,
} from "../auth.server.ts";
import type { Route } from "./+types/api.passkey.signin-verify";

export async function action({ request, context }: Route.ActionArgs) {
  isPost(request);
  assertSameOrigin(request);
  const body = await readJson(request);
  const headers = new Headers();
  headers.append("Set-Cookie", await clearCookie(ceremonyCookie));

  const result = await finishSignIn({
    ceremonyId: await readCookie(ceremonyCookie, request),
    response: body.response as AuthenticationResponseJSON,
    userAgent: request.headers.get("User-Agent"),
  });

  if (!result.ok) {
    return Response.json(
      { error: result.message, unknownCredential: result.unknownCredential ?? null },
      { status: 401, headers },
    );
  }

  const previous = getAuth(context);
  if (previous) {
    revokeSession({ id: previous.session.id, userId: previous.user.id, actorUserId: previous.user.id });
  }
  headers.append("Set-Cookie", await sessionCookie.serialize(result.sessionToken));
  return Response.json(
    { ok: true, redirectTo: safeRedirectPath(typeof body.next === "string" ? body.next : null) },
    { headers },
  );
}
