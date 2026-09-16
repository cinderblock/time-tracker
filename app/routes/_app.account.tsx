import { Alert, Button, Card, Group, Stack, Switch, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";

import { removeCredential, renameCredential } from "../../src/credentials.ts";
import { revokeAllSessions, revokeSession } from "../../src/sessions.ts";
import { NAME_MAX_LENGTH } from "../../src/limits.ts";
import { renameUser } from "../../src/users.ts";
import { handleForm, intField, stringField } from "../actions.server.ts";
import { requireUser } from "../auth.server.ts";
import { PasskeyList, SessionList } from "../components/credential-lists.tsx";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import { PasskeyError, passkeysSupported, registerPasskey } from "../passkey-client.ts";
import { SignOutButton } from "../offline/SyncStatusBadge.tsx";
import { locationEnabled, setLocationEnabled } from "../tracker/location.ts";
import { passkeyViews, sessionViews } from "../views.server.ts";
import { pageTitle } from "../meta.ts";
import type { Route } from "./+types/_app.account";

export function loader({ request, context }: Route.LoaderArgs) {
  const { user, session } = requireUser(context, request);
  return {
    userId: user.id,
    name: user.name,
    role: user.role,
    passkeys: passkeyViews(user.id),
    sessions: sessionViews(user.id, session.id),
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Your account");
}

export async function action({ request, context }: Route.ActionArgs) {
  const { user, session } = requireUser(context, request);
  const self = { userId: user.id, actorUserId: user.id };
  return handleForm(request, {
    rename: (form) => {
      renameUser({ ...self, name: stringField(form, "name") });
      return { ok: true, message: "Name updated." };
    },
    "rename-passkey": (form) => {
      renameCredential({ ...self, id: intField(form, "credentialId"), nickname: stringField(form, "nickname") });
      return { ok: true, message: "Passkey renamed." };
    },
    "remove-passkey": (form) => {
      const removed = removeCredential({ ...self, id: intField(form, "credentialId") });
      return { ok: true, message: `Removed “${removed.nickname}”.` };
    },
    "revoke-session": (form) => {
      revokeSession({ ...self, id: stringField(form, "sessionId") });
      return { ok: true, message: "Signed that device out." };
    },
    "revoke-sessions": () => {
      const n = revokeAllSessions({ ...self, exceptId: session.id });
      return { ok: true, message: `Signed out ${n} other device${n === 1 ? "" : "s"}.` };
    },
  });
}

export default function Account({ loaderData }: Route.ComponentProps) {
  const { userId, name, role, passkeys, sessions } = loaderData;

  return (
    <Stack gap="xl" maw={640}>
      <Stack gap={4}>
        <Title order={2}>Your account</Title>
        <Text c="dimmed">{role === "admin" ? "Admin" : "Employee"}</Text>
      </Stack>

      <RenameSelf name={name} />

      <Stack gap="sm">
        <Title order={3}>Passkeys</Title>
        <Text size="sm" c="dimmed">
          Each passkey lets one device (or one password manager) sign in. Keep at least two if you can, so losing a
          phone doesn't lock you out.
        </Text>
        <PasskeyList passkeys={passkeys} action="/account" canRemoveLast={false} />
        <AddPasskeyButton />
      </Stack>

      <LocationSetting />

      <Stack gap="sm">
        <Title order={3}>Signed-in devices</Title>
        <SessionList sessions={sessions} action="/account" revokeLabel="Sign out all other devices" />
      </Stack>

      <SignOutButton userId={userId}>
        {(signOut) => (
          <Group>
            <Button variant="default" onClick={signOut}>
              Sign out of this device
            </Button>
          </Group>
        )}
      </SignOutButton>
    </Stack>
  );
}

function RenameSelf({ name }: { name: string }) {
  const fetcher = useFetcher();
  useActionFeedback(fetcher.data);
  return (
    <Card withBorder>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="rename" />
        <Group align="end" gap="xs">
          <TextInput
            name="name"
            label="Your name"
            defaultValue={name}
            maxLength={NAME_MAX_LENGTH}
            required
            style={{ flex: 1 }}
            autoComplete="name"
          />
          <Button type="submit" variant="light" loading={fetcher.state !== "idle"}>
            Save
          </Button>
        </Group>
      </fetcher.Form>
    </Card>
  );
}

function AddPasskeyButton() {
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      if (!passkeysSupported()) throw new PasskeyError("This browser can't create passkeys.");
      await registerPasskey();
      notifications.show({ message: "Passkey added.", color: "green" });
      await revalidator.revalidate();
    } catch (err) {
      if (!(err instanceof PasskeyError && err.cancelled)) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap="xs">
      <Group>
        <Button variant="light" onClick={add} loading={busy}>
          Add a passkey on this device
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        For a different phone, sign in there with a link from an admin instead.
      </Text>
      {error && (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      )}
    </Stack>
  );
}

/**
 * Location is a per-device choice, stored in the browser: the same person may
 * want it on their work phone and off on a laptop.
 */
function LocationSetting() {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setOn(locationEnabled()), []);

  async function toggle(next: boolean) {
    setBusy(true);
    setProblem(null);
    const result = await setLocationEnabled(next);
    setOn(result);
    setBusy(false);
    if (next && !result) {
      setProblem(
        "Location isn't available. Allow it for this site in the browser's settings (on iPhone: Settings → Privacy → Location Services), then try again.",
      );
    }
  }

  return (
    <Stack gap="sm">
      <Title order={3}>Location</Title>
      <Card withBorder>
        <Stack gap="xs">
          <Switch
            label="Record where I am when I start, stop or add a note"
            checked={on}
            disabled={busy}
            onChange={(e) => void toggle(e.currentTarget.checked)}
          />
          <Text size="xs" c="dimmed">
            Only on this device, and only while the app is open — it can't follow you around in the background.
            Your admins can see these locations with your time.
          </Text>
          {problem && <Alert color="yellow">{problem}</Alert>}
        </Stack>
      </Card>
    </Stack>
  );
}
