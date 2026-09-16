import { Badge, Button, Card, Group, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { useFetcher } from "react-router";

import { useActionFeedback } from "./use-action-feedback.ts";

/** A passkey as loaders hand it to the page: display strings only. */
export interface PasskeyView {
  id: number;
  nickname: string;
  created: string;
  lastUsed: string;
  synced: boolean;
}

export interface SessionView {
  id: string;
  device: string;
  passkey: string | null;
  lastUsed: string;
  current: boolean;
}

/**
 * A person's passkeys, each with rename and remove. The server enforces who
 * may remove what; `canRemoveLast` only decides whether the button is offered.
 */
export function PasskeyList({
  passkeys,
  action,
  canRemoveLast,
}: {
  passkeys: PasskeyView[];
  action: string;
  canRemoveLast: boolean;
}) {
  if (passkeys.length === 0) {
    return <Text c="dimmed">No passkeys. This person can't sign in until they use a device link.</Text>;
  }
  return (
    <Stack gap="sm">
      {passkeys.map((p) => (
        <PasskeyRow
          key={p.id}
          passkey={p}
          action={action}
          removable={canRemoveLast || passkeys.length > 1}
        />
      ))}
    </Stack>
  );
}

function PasskeyRow({ passkey, action, removable }: { passkey: PasskeyView; action: string; removable: boolean }) {
  const fetcher = useFetcher();
  useActionFeedback(fetcher.data);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const busy = fetcher.state !== "idle";

  return (
    <Card withBorder padding="sm">
      {editing ? (
        <fetcher.Form method="post" action={action} onSubmit={() => setEditing(false)}>
          <input type="hidden" name="intent" value="rename-passkey" />
          <input type="hidden" name="credentialId" value={passkey.id} />
          <Group align="end" gap="xs">
            <TextInput name="nickname" label="Passkey name" defaultValue={passkey.nickname} style={{ flex: 1 }} required />
            <Button type="submit" loading={busy}>
              Save
            </Button>
            <Button variant="subtle" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </Group>
        </fetcher.Form>
      ) : (
        <Stack gap={6}>
          <Group justify="space-between" wrap="nowrap" align="start">
            <Stack gap={2}>
              <Group gap="xs">
                <Text fw={500}>{passkey.nickname}</Text>
                {passkey.synced && (
                  <Badge variant="light" size="sm">
                    synced
                  </Badge>
                )}
              </Group>
              <Text size="sm" c="dimmed">
                Added {passkey.created} · last used {passkey.lastUsed}
              </Text>
            </Stack>
          </Group>
          <Group gap="xs">
            <Button size="xs" variant="subtle" onClick={() => setEditing(true)}>
              Rename
            </Button>
            {removable && !confirming && (
              <Button size="xs" variant="subtle" color="red" onClick={() => setConfirming(true)}>
                Remove
              </Button>
            )}
          </Group>
          {confirming && (
            <fetcher.Form method="post" action={action}>
              <input type="hidden" name="intent" value="remove-passkey" />
              <input type="hidden" name="credentialId" value={passkey.id} />
              <Stack gap="xs">
                <Text size="sm">
                  Remove “{passkey.nickname}”? That device will no longer be able to sign in.
                </Text>
                <Group gap="xs">
                  <Button type="submit" size="xs" color="red" loading={busy}>
                    Remove passkey
                  </Button>
                  <Button size="xs" variant="subtle" onClick={() => setConfirming(false)}>
                    Keep it
                  </Button>
                </Group>
              </Stack>
            </fetcher.Form>
          )}
        </Stack>
      )}
    </Card>
  );
}

/** Where a person is signed in, with a way to end those sessions. */
export function SessionList({
  sessions,
  action,
  revokeLabel,
}: {
  sessions: SessionView[];
  action: string;
  /** Text for the bulk button, e.g. "Sign out other devices". */
  revokeLabel: string;
}) {
  const fetcher = useFetcher();
  useActionFeedback(fetcher.data);
  const others = sessions.filter((s) => !s.current);

  if (sessions.length === 0) return <Text c="dimmed">Not signed in anywhere.</Text>;

  return (
    <Stack gap="sm">
      {sessions.map((s) => (
        <Card key={s.id} withBorder padding="sm">
          <Group justify="space-between" wrap="nowrap">
            <Stack gap={2}>
              <Group gap="xs">
                <Text fw={500}>{s.device}</Text>
                {s.current && (
                  <Badge variant="light" color="green" size="sm">
                    this device
                  </Badge>
                )}
              </Group>
              <Text size="sm" c="dimmed">
                Active {s.lastUsed}
                {s.passkey ? ` · signed in with “${s.passkey}”` : ""}
              </Text>
            </Stack>
            {!s.current && (
              <fetcher.Form method="post" action={action}>
                <input type="hidden" name="intent" value="revoke-session" />
                <input type="hidden" name="sessionId" value={s.id} />
                <Button type="submit" size="xs" variant="subtle" color="red" loading={fetcher.state !== "idle"}>
                  Sign out
                </Button>
              </fetcher.Form>
            )}
          </Group>
        </Card>
      ))}
      {others.length > 1 && (
        <fetcher.Form method="post" action={action}>
          <input type="hidden" name="intent" value="revoke-sessions" />
          <Button type="submit" variant="light" color="red" loading={fetcher.state !== "idle"}>
            {revokeLabel}
          </Button>
        </fetcher.Form>
      )}
    </Stack>
  );
}
