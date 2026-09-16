import { startSignIn } from "../../src/auth-flows.ts";
import { assertSameOrigin, ceremonyCookie, isPost } from "../auth.server.ts";
import type { Route } from "./+types/api.passkey.signin-options";

export async function action({ request }: Route.ActionArgs) {
  isPost(request);
  assertSameOrigin(request);
  const { ceremonyId, options } = await startSignIn();
  return Response.json(
    { options },
    { headers: { "Set-Cookie": await ceremonyCookie.serialize(ceremonyId) } },
  );
}
