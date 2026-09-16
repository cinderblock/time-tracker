import { Alert, Button, Stack, Text, TextInput } from "@mantine/core";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { findUsableRegistration } from "../../src/registrations.ts";
import { NAME_MAX_LENGTH } from "../../src/limits.ts";
import { getUser } from "../../src/users.ts";
import { getAuth, joinCookie, readCookie } from "../auth.server.ts";
import { AuthCard } from "../components/auth-card.tsx";
import { PasskeyError, passkeysSupported, registerPasskey } from "../passkey-client.ts";
import type { Route } from "./+types/join";

export async function loader({ request, context }: Route.LoaderArgs) {
  const token = await readCookie(joinCookie, request);
  const registration = token ? findUsableRegistration(token) : null;
  if (!registration) return { state: "invalid" as const };

  const signedInAs = getAuth(context)?.user ?? null;
  const target = registration.userId != null ? getUser(registration.userId) : null;
  return {
    state: "ready" as const,
    purpose: registration.purpose,
    role: registration.role,
    nameHint: registration.nameHint ?? "",
    targetName: target?.name ?? null,
    signedInAs: signedInAs ? { id: signedInAs.id, name: signedInAs.name } : null,
    targetIsSignedInUser: target != null && signedInAs?.id === target.id,
  };
}

export function meta() {
  return [{ title: "Set up your passkey" }];
}

export default function Join({ loaderData }: Route.ComponentProps) {
  if (loaderData.state === "invalid") {
    return (
      <AuthCard heading="This link can't be used">
        <Text>
          It has expired, was already used, or was cancelled. Links work once. Ask an admin to send you a new one.
        </Text>
        <Button component={Link} to="/signin" variant="light">
          Go to sign in
        </Button>
      </AuthCard>
    );
  }
  return <JoinForm {...loaderData} />;
}

type ReadyData = Extract<Route.ComponentProps["loaderData"], { state: "ready" }>;

function JoinForm({ purpose, role, nameHint, targetName, signedInAs, targetIsSignedInUser }: ReadyData) {
  const [name, setName] = useState(nameHint);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; quiet: boolean } | null>(null);
  const [supported, setSupported] = useState(true);
  useEffect(() => setSupported(passkeysSupported()), []);

  const needsName = purpose !== "add_device";
  const heading =
    purpose === "bootstrap"
      ? "Set up the first admin"
      : purpose === "invite"
        ? "Create your account"
        : `Add this device for ${targetName}`;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const to = await registerPasskey(needsName ? name : undefined);
      // Full page load: the new session cookie must reach every loader, and
      // the join cookie has just been cleared.
      window.location.assign(to);
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof PasskeyError
          ? { message: err.message, quiet: err.cancelled }
          : { message: "Something went wrong. Please try again.", quiet: false },
      );
    }
  }

  return (
    <AuthCard heading={heading}>
      <Text>
        {purpose === "bootstrap" && "You'll be the first admin. You can invite everyone else once you're in."}
        {purpose === "invite" &&
          (role === "admin" ? "You've been invited as an admin." : "You've been invited to track your time here.")}
        {purpose === "add_device" &&
          "This adds a passkey on this device, so you can sign in here too. Your existing passkeys keep working."}
      </Text>

      {signedInAs && !targetIsSignedInUser && (
        <Alert color="yellow">
          This browser is signed in as {signedInAs.name}. Continuing signs {signedInAs.name} out here and signs in
          as {needsName ? "the new account" : targetName} instead.
        </Alert>
      )}

      {!supported && (
        <Alert color="red" title="Passkeys aren't available">
          This browser can't create passkeys. Open this link in a current version of Safari, Chrome, Edge or
          Firefox.
        </Alert>
      )}

      <form onSubmit={submit}>
        <Stack gap="md">
          {needsName && (
            <TextInput
              label="Your name"
              description="As your admin and co-workers will see it."
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              maxLength={NAME_MAX_LENGTH}
              required
              autoComplete="name"
              data-autofocus
            />
          )}
          <Button type="submit" size="lg" fullWidth loading={busy} disabled={!supported || (needsName && !name.trim())}>
            Create passkey
          </Button>
          <Text size="sm" c="dimmed">
            Your device will ask for Face ID, Touch ID, or your screen lock to save the passkey. There's no password
            to remember.
          </Text>
        </Stack>
      </form>

      {error && (
        <Alert color={error.quiet ? "gray" : "red"} role="alert">
          {error.message}
        </Alert>
      )}
    </AuthCard>
  );
}
