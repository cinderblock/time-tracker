import {
  Badge,
  Button,
  Card,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";

import { formatDateTime, formatRelative } from "../../src/format.ts";
import {
  LINK_LIFETIMES,
  listOpenRegistrations,
  mintRegistration,
  revokeRegistration,
} from "../../src/registrations.ts";
import { NAME_MAX_LENGTH } from "../../src/limits.ts";
import { listUsers } from "../../src/users.ts";
import { type ActionResult, handleForm, intField, lifetimeFrom, stringField } from "../actions.server.ts";
import { requireAdmin } from "../auth.server.ts";
import { LinkReveal, type RevealedLink } from "../components/link-reveal.tsx";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import type { Route } from "./+types/_app.admin.people";

export function loader({ request, context }: Route.LoaderArgs) {
  requireAdmin(context, request);
  const now = Date.now();
  return {
    people: listUsers().map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role,
      active: u.active,
      passkeys: u.passkeyCount,
      lastSeen: u.lastSeenAt ? formatRelative(u.lastSeenAt, now) : "never",
    })),
    links: listOpenRegistrations(now).map((r) => ({
      id: r.id,
      description:
        r.purpose === "add_device"
          ? `New device for ${r.targetName ?? "someone"}`
          : r.purpose === "bootstrap"
            ? "First-admin setup"
            : `Invite${r.nameHint ? ` for ${r.nameHint}` : ""} (${r.role})`,
      createdBy: r.createdByName ?? "the server",
      expires: formatRelative(r.expiresAt, now),
    })),
    lifetimes: LINK_LIFETIMES.map((l) => ({ value: String(l.ms), label: l.label })),
  };
}

export function meta() {
  return [{ title: "People" }];
}

export async function action({ request, context }: Route.ActionArgs) {
  const { user } = requireAdmin(context, request);
  return handleForm<{ link?: RevealedLink }>(request, {
    invite: (form): ActionResult<{ link?: RevealedLink }> => {
      const role = stringField(form, "role") === "admin" ? "admin" : "employee";
      const nameHint = stringField(form, "nameHint").slice(0, NAME_MAX_LENGTH);
      const { url, registration } = mintRegistration({
        purpose: "invite",
        role,
        nameHint,
        createdBy: user.id,
        ttlMs: lifetimeFrom(form, 7 * 24 * 3600_000),
      });
      return {
        ok: true,
        message: "", // the link dialog is the confirmation
        link: {
          url,
          label: `Invite${registration.nameHint ? ` for ${registration.nameHint}` : ""} (${role})`,
          expires: formatDateTime(registration.expiresAt),
        },
      };
    },
    "revoke-link": (form) => {
      revokeRegistration({ id: intField(form, "registrationId"), actorUserId: user.id });
      return { ok: true, message: "Link revoked." };
    },
  });
}

export default function People({ loaderData }: Route.ComponentProps) {
  const { people, links, lifetimes } = loaderData;

  return (
    <Stack gap="xl" maw={760}>
      <Title order={2}>People</Title>

      <InviteForm lifetimes={lifetimes} />

      <Stack gap="sm">
        <Title order={3}>Everyone</Title>
        {people.map((p) => (
          <Card key={p.id} withBorder padding="sm" component={Link} to={`/admin/people/${p.id}`}>
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={2}>
                <Group gap="xs">
                  <Text fw={500} c={p.active ? undefined : "dimmed"}>
                    {p.name}
                  </Text>
                  {p.role === "admin" && (
                    <Badge size="sm" variant="light">
                      admin
                    </Badge>
                  )}
                  {!p.active && (
                    <Badge size="sm" color="gray">
                      deactivated
                    </Badge>
                  )}
                </Group>
                <Text size="sm" c="dimmed">
                  {p.passkeys} passkey{p.passkeys === 1 ? "" : "s"} · last active {p.lastSeen}
                </Text>
              </Stack>
              <Text c="dimmed" aria-hidden>
                ›
              </Text>
            </Group>
          </Card>
        ))}
      </Stack>

      <Stack gap="sm">
        <Title order={3}>Open links</Title>
        {links.length === 0 ? (
          <Text c="dimmed">No unused links.</Text>
        ) : (
          links.map((l) => <OpenLinkRow key={l.id} link={l} />)
        )}
        <Text size="sm" c="dimmed">
          Links are shown once, when created. An unused link can be revoked here at any time.
        </Text>
      </Stack>
    </Stack>
  );
}

function InviteForm({ lifetimes }: { lifetimes: { value: string; label: string }[] }) {
  const fetcher = useFetcher<typeof action>();
  useActionFeedback(fetcher.data);
  const [revealed, setRevealed] = useState<RevealedLink | null>(null);
  const [role, setRole] = useState("employee");
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    const data = fetcher.data;
    if (data?.ok && data.link) {
      setRevealed(data.link);
      setFormKey((k) => k + 1); // reset the form for the next invite
    }
  }, [fetcher.data]);

  return (
    <Card withBorder>
      <fetcher.Form method="post" key={formKey}>
        <input type="hidden" name="intent" value="invite" />
        <input type="hidden" name="role" value={role} />
        <Stack gap="sm">
          <Title order={3}>Invite someone</Title>
          <TextInput
            name="nameHint"
            label="Their name"
            description="Optional — pre-fills the sign-up form. They can change it."
            maxLength={NAME_MAX_LENGTH}
          />
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Role
            </Text>
            <SegmentedControl
              value={role}
              onChange={setRole}
              data={[
                { value: "employee", label: "Employee" },
                { value: "admin", label: "Admin" },
              ]}
            />
            <Text size="xs" c="dimmed">
              {role === "admin"
                ? "Admins see everyone's time, manage people, and approve time for payroll."
                : "Employees track and see only their own time."}
            </Text>
          </Stack>
          <Select
            name="ttl"
            label="Link works for"
            data={lifetimes}
            defaultValue={lifetimes.find((l) => l.label === "7 days")?.value}
            allowDeselect={false}
          />
          <Group>
            <Button type="submit" loading={fetcher.state !== "idle"}>
              Create invite link
            </Button>
          </Group>
        </Stack>
      </fetcher.Form>
      <LinkReveal link={revealed} onClose={() => setRevealed(null)} />
    </Card>
  );
}

function OpenLinkRow({ link }: { link: { id: number; description: string; createdBy: string; expires: string } }) {
  const fetcher = useFetcher();
  useActionFeedback(fetcher.data);
  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" wrap="nowrap">
        <Stack gap={2}>
          <Text fw={500}>{link.description}</Text>
          <Text size="sm" c="dimmed">
            By {link.createdBy} · expires {link.expires}
          </Text>
        </Stack>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="revoke-link" />
          <input type="hidden" name="registrationId" value={link.id} />
          <Button type="submit" size="xs" variant="subtle" color="red" loading={fetcher.state !== "idle"}>
            Revoke
          </Button>
        </fetcher.Form>
      </Group>
    </Card>
  );
}

