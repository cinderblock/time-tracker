import { Anchor, Badge, Button, Card, Group, Select, Stack, Switch, Text, TextInput, Timeline, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { Link, data, useFetcher } from "react-router";

import { auditFor } from "../../src/audit.ts";
import { removeCredential, renameCredential } from "../../src/credentials.ts";
import { formatDateTime } from "../../src/format.ts";
import { LINK_LIFETIMES, mintRegistration } from "../../src/registrations.ts";
import { revokeAllSessions, revokeSession } from "../../src/sessions.ts";
import { NAME_MAX_LENGTH } from "../../src/limits.ts";
import { getUser, renameUser, updateUserAccess } from "../../src/users.ts";
import { type ActionResult, handleForm, intField, lifetimeFrom, stringField } from "../actions.server.ts";
import { requireAdmin } from "../auth.server.ts";
import { PasskeyList, SessionList } from "../components/credential-lists.tsx";
import { LinkReveal, type RevealedLink } from "../components/link-reveal.tsx";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import { passkeyViews, sessionViews } from "../views.server.ts";
import { pageTitle } from "../meta.ts";
import type { Route } from "./+types/_app.admin.people.$userId";

function targetUser(params: { userId: string }) {
  const user = getUser(Number(params.userId));
  if (!user) throw data("There's nobody with that id.", { status: 404 });
  return user;
}

/** Plain-language lines for the history panel. Keeps secrets out by construction. */
function describeAudit(action: string, entity: string, after: Record<string, unknown> | null): string {
  if (entity === "user") {
    switch (action) {
      case "create":
        return "Account created";
      case "rename":
        return `Renamed to ${String(after?.name ?? "")}`;
      case "access":
        return `Now ${after?.active ? "active" : "deactivated"}, ${String(after?.role ?? "")}`;
      case "revoke_sessions":
        return `Signed out of ${String(after?.count ?? "")} device(s)`;
      case "signin_refused_inactive":
        return "Sign-in refused (deactivated)";
    }
  }
  return `${entity} ${action}`;
}

export function loader({ request, context, params }: Route.LoaderArgs) {
  const { user: me, session } = requireAdmin(context, request);
  const user = targetUser(params);
  return {
    person: { id: user.id, name: user.name, role: user.role, active: user.active },
    isMe: user.id === me.id,
    passkeys: passkeyViews(user.id),
    sessions: sessionViews(user.id, user.id === me.id ? session.id : null),
    history: auditFor("user", user.id)
      .reverse()
      .slice(0, 20)
      .map((e) => ({
        id: e.id,
        when: formatDateTime(e.at),
        text: describeAudit(e.action, e.entity, e.after_json ? JSON.parse(e.after_json) : null),
      })),
    lifetimes: LINK_LIFETIMES.map((l) => ({ value: String(l.ms), label: l.label })),
  };
}

export function meta({ loaderData, matches }: Route.MetaArgs) {
  return pageTitle(matches, loaderData?.person.name ?? "Person");
}

type Extra = { link?: RevealedLink };

export async function action({ request, context, params }: Route.ActionArgs) {
  const { user: me, session } = requireAdmin(context, request);
  const user = targetUser(params);
  const target = { userId: user.id, actorUserId: me.id };

  return handleForm<Extra>(request, {
    rename: (form) => {
      renameUser({ ...target, name: stringField(form, "name") });
      return { ok: true, message: "Name updated." };
    },
    role: (form) => {
      const role = stringField(form, "role") === "admin" ? "admin" : "employee";
      updateUserAccess({ ...target, role });
      return { ok: true, message: role === "admin" ? `${user.name} is now an admin.` : `${user.name} is now an employee.` };
    },
    active: (form) => {
      const active = stringField(form, "active") === "true";
      updateUserAccess({ ...target, active });
      return {
        ok: true,
        message: active ? `${user.name} can sign in again.` : `${user.name} is deactivated and signed out everywhere.`,
      };
    },
    "device-link": (form): ActionResult<Extra> => {
      const { url, registration } = mintRegistration({
        purpose: "add_device",
        userId: user.id,
        createdBy: me.id,
        ttlMs: lifetimeFrom(form, 24 * 3600_000),
      });
      return {
        ok: true,
        message: "", // the link dialog is the confirmation
        link: { url, label: `New device for ${user.name}`, expires: formatDateTime(registration.expiresAt) },
      };
    },
    "rename-passkey": (form) => {
      renameCredential({ ...target, id: intField(form, "credentialId"), nickname: stringField(form, "nickname") });
      return { ok: true, message: "Passkey renamed." };
    },
    "remove-passkey": (form) => {
      const removed = removeCredential({ ...target, id: intField(form, "credentialId") });
      return { ok: true, message: `Removed “${removed.nickname}”.` };
    },
    "revoke-session": (form) => {
      revokeSession({ ...target, id: stringField(form, "sessionId") });
      return { ok: true, message: "Signed that device out." };
    },
    "revoke-sessions": () => {
      const n = revokeAllSessions({ ...target, exceptId: user.id === me.id ? session.id : undefined });
      return { ok: true, message: `Signed out ${n} device${n === 1 ? "" : "s"}.` };
    },
  });
}

export default function Person({ loaderData }: Route.ComponentProps) {
  const { person, isMe, passkeys, sessions, history, lifetimes } = loaderData;

  return (
    <Stack gap="xl" maw={640}>
      <Stack gap={4}>
        <Anchor component={Link} to="/admin/people" size="sm">
          ‹ People
        </Anchor>
        <Group gap="xs">
          <Title order={2}>{person.name}</Title>
          {!person.active && <Badge color="gray">deactivated</Badge>}
        </Group>
        {isMe && (
          <Text size="sm" c="dimmed">
            This is you. Your own passkeys and devices are also on{" "}
            <Anchor component={Link} to="/account">
              your account page
            </Anchor>
            .
          </Text>
        )}
      </Stack>

      <AccessCard person={person} />

      <DeviceLinkCard active={person.active} name={person.name} lifetimes={lifetimes} />

      <Stack gap="sm">
        <Title order={3}>Passkeys</Title>
        <PasskeyList passkeys={passkeys} action={`/admin/people/${person.id}`} canRemoveLast={!isMe} />
      </Stack>

      <Stack gap="sm">
        <Title order={3}>Signed-in devices</Title>
        <SessionList
          sessions={sessions}
          action={`/admin/people/${person.id}`}
          revokeLabel={isMe ? "Sign out all your other devices" : "Sign out of every device"}
        />
      </Stack>

      <Stack gap="sm">
        <Title order={3}>History</Title>
        <Timeline bulletSize={12} lineWidth={2}>
          {history.map((h) => (
            <Timeline.Item key={h.id}>
              <Text size="sm">{h.text}</Text>
              <Text size="xs" c="dimmed">
                {h.when}
              </Text>
            </Timeline.Item>
          ))}
        </Timeline>
      </Stack>
    </Stack>
  );
}

function AccessCard({ person }: { person: { name: string; role: string; active: boolean } }) {
  const rename = useFetcher();
  const role = useFetcher();
  const active = useFetcher();
  useActionFeedback(rename.data);
  useActionFeedback(role.data);
  useActionFeedback(active.data);

  return (
    <Card withBorder>
      <Stack gap="md">
        <rename.Form method="post">
          <input type="hidden" name="intent" value="rename" />
          <Group align="end" gap="xs">
            <TextInput
              name="name"
              label="Name"
              defaultValue={person.name}
              maxLength={NAME_MAX_LENGTH}
              required
              style={{ flex: 1 }}
            />
            <Button type="submit" variant="light" loading={rename.state !== "idle"}>
              Save
            </Button>
          </Group>
        </rename.Form>

        <Select
          label="Role"
          value={person.role}
          data={[
            { value: "employee", label: "Employee" },
            { value: "admin", label: "Admin" },
          ]}
          allowDeselect={false}
          disabled={role.state !== "idle"}
          onChange={(value) => value && role.submit({ intent: "role", role: value }, { method: "post" })}
        />

        <Stack gap={4}>
          <Switch
            label="Can sign in"
            checked={person.active}
            disabled={active.state !== "idle"}
            onChange={(e) =>
              active.submit({ intent: "active", active: String(e.currentTarget.checked) }, { method: "post" })
            }
          />
          <Text size="xs" c="dimmed">
            Turning this off signs {person.name} out everywhere immediately. Their time history is kept.
          </Text>
        </Stack>
      </Stack>
    </Card>
  );
}

function DeviceLinkCard({
  active,
  name,
  lifetimes,
}: {
  active: boolean;
  name: string;
  lifetimes: { value: string; label: string }[];
}) {
  const fetcher = useFetcher<typeof action>();
  useActionFeedback(fetcher.data);
  const [revealed, setRevealed] = useState<RevealedLink | null>(null);
  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data.link) setRevealed(fetcher.data.link);
  }, [fetcher.data]);

  return (
    <Card withBorder>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="device-link" />
        <Stack gap="sm">
          <Title order={3}>New phone?</Title>
          <Text size="sm" c="dimmed">
            A device link lets {name} add a passkey on another device and sign in there. Remove a lost phone's
            passkey below.
          </Text>
          <Select
            name="ttl"
            label="Link works for"
            data={lifetimes}
            defaultValue={lifetimes.find((l) => l.label === "1 day")?.value}
            allowDeselect={false}
          />
          <Group>
            <Button type="submit" variant="light" disabled={!active} loading={fetcher.state !== "idle"}>
              Create device link
            </Button>
          </Group>
          {!active && (
            <Text size="sm" c="dimmed">
              Turn “Can sign in” back on first.
            </Text>
          )}
        </Stack>
      </fetcher.Form>
      <LinkReveal link={revealed} onClose={() => setRevealed(null)} />
    </Card>
  );
}
