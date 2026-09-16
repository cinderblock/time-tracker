import { Alert, Button, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { redirect, useNavigate } from "react-router";

import { safeRedirectPath } from "../../src/safe-redirect.ts";
import { countActiveAdmins } from "../../src/users.ts";
import { getAuth } from "../auth.server.ts";
import { AuthCard } from "../components/auth-card.tsx";
import { PasskeyError, passkeysSupported, signInWithPasskey } from "../passkey-client.ts";
import { pageTitle } from "../meta.ts";
import type { Route } from "./+types/signin";

export function loader({ request, context }: Route.LoaderArgs) {
  const next = new URL(request.url).searchParams.get("next");
  if (getAuth(context)) throw redirect(safeRedirectPath(next));
  return { next, setupPending: countActiveAdmins() === 0 };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Sign in");
}

export default function SignIn({ loaderData }: Route.ComponentProps) {
  const { next, setupPending } = loaderData;
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; quiet: boolean } | null>(null);
  // Only known after hydration; assume support until the browser says otherwise
  // so the server render and first client render agree.
  const [supported, setSupported] = useState(true);
  useEffect(() => setSupported(passkeysSupported()), []);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const to = await signInWithPasskey(next);
      // A client-side navigation is enough: the session cookie arrived with
      // the verify response, and the destination's loaders run fresh.
      navigate(to, { replace: true });
    } catch (err) {
      setError(
        err instanceof PasskeyError
          ? { message: err.message, quiet: err.cancelled }
          : { message: "Something went wrong. Please try again.", quiet: false },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard heading="Sign in">
      {setupPending && (
        <Alert color="yellow" title="Not set up yet">
          No admin exists yet. The server prints a one-time setup link to its log when it starts; open that
          link to create the first admin. On the server, <code>bun run admin-link</code> prints a fresh one.
        </Alert>
      )}

      {!supported && (
        <Alert color="red" title="Passkeys aren't available">
          This browser can't use passkeys. Use a current version of Safari, Chrome, Edge or Firefox.
        </Alert>
      )}

      <Stack gap="xs">
        <Button size="lg" fullWidth loading={busy} disabled={!supported} onClick={signIn}>
          Sign in with a passkey
        </Button>
        <Text size="sm" c="dimmed">
          Your device will ask for Face ID, Touch ID, or your screen lock. There's no password.
        </Text>
      </Stack>

      {error && (
        <Alert color={error.quiet ? "gray" : "red"} role="alert">
          {error.message}
        </Alert>
      )}

      <Text size="sm" c="dimmed">
        New here, or on a new phone? Ask an admin for a sign-up link.
      </Text>
    </AuthCard>
  );
}
