import { redirect } from "react-router";

import { revokeSession } from "../../src/sessions.ts";
import { assertSameOrigin, clearCookie, getAuth, sessionCookie } from "../auth.server.ts";
import type { Route } from "./+types/signout";

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const auth = getAuth(context);
  if (auth) {
    revokeSession({ id: auth.session.id, userId: auth.user.id, actorUserId: auth.user.id });
  }
  return redirect("/signin", {
    headers: { "Set-Cookie": await clearCookie(sessionCookie) },
  });
}

// A plain GET (a bookmark, a stale link) shouldn't sign anyone out — that has
// to be a deliberate POST — so just send them home.
export function loader() {
  return redirect("/");
}
