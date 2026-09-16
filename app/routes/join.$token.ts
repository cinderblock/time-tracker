import { redirect } from "react-router";

import { findUsableRegistration } from "../../src/registrations.ts";
import { clearCookie, joinCookie } from "../auth.server.ts";
import type { Route } from "./+types/join.$token";

/**
 * Entry point for a one-time link. Moves the token out of the URL — into a
 * short-lived signed cookie — and redirects, so the token doesn't linger in
 * the address bar, history, or a screenshot of the next page.
 *
 * Nothing is consumed here: the link is only used up once a passkey is
 * actually registered.
 */
export async function loader({ params }: Route.LoaderArgs) {
  if (!findUsableRegistration(params.token)) {
    return redirect("/join?invalid=1", {
      headers: { "Set-Cookie": await clearCookie(joinCookie) },
    });
  }
  return redirect("/join", {
    headers: {
      "Set-Cookie": await joinCookie.serialize(params.token),
      // The token must never be sent onward as a referrer.
      "Referrer-Policy": "no-referrer",
    },
  });
}
