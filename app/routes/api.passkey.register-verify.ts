import type { RegistrationResponseJSON } from "@simplewebauthn/server";

import { finishEnrollment } from "../../src/auth-flows.ts";
import { revokeSession } from "../../src/sessions.ts";
import {
  assertSameOrigin,
  ceremonyCookie,
  clearCookie,
  getAuth,
  isPost,
  joinCookie,
  readCookie,
  readJson,
  sessionCookie,
  userErrorResponse,
} from "../auth.server.ts";
import type { Route } from "./+types/api.passkey.register-verify";

export async function action({ request, context }: Route.ActionArgs) {
  isPost(request);
  assertSameOrigin(request);
  const body = await readJson(request);
  const headers = new Headers();
  headers.append("Set-Cookie", await clearCookie(ceremonyCookie));

  try {
    const result = await finishEnrollment({
      ceremonyId: await readCookie(ceremonyCookie, request),
      response: body.response as RegistrationResponseJSON,
      userAgent: request.headers.get("User-Agent"),
    });

    if (!result.sessionToken) {
      // Added a passkey to the account already signed in here.
      return Response.json({ ok: true, redirectTo: "/account" }, { headers });
    }

    // A link signed this browser in as `result.user`. Whatever session the
    // browser held before is now unreachable from it, so end it rather than
    // leave it valid until expiry.
    const previous = getAuth(context);
    if (previous) {
      revokeSession({ id: previous.session.id, userId: previous.user.id, actorUserId: previous.user.id });
    }
    headers.append("Set-Cookie", await sessionCookie.serialize(result.sessionToken));
    headers.append("Set-Cookie", await clearCookie(joinCookie));
    return Response.json({ ok: true, redirectTo: "/" }, { headers });
  } catch (err) {
    const response = userErrorResponse(err);
    for (const cookie of headers.getSetCookie()) response.headers.append("Set-Cookie", cookie);
    return response;
  }
}
