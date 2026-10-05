import { Anchor, Badge, Button, Card, Code, Group, Stack, Table, Text, Title } from "@mantine/core";
import { Link, useFetcher } from "react-router";

import { shortRevision } from "../../src/build-info.ts";
import { type ErrorGroupStatus, getErrorGroup, setErrorGroupStatus } from "../../src/client-errors.ts";
import { OpError } from "../../src/op-error.ts";
import { UserInputError } from "../../src/users.ts";
import { handleForm, stringField } from "../actions.server.ts";
import { requireAdmin } from "../auth.server.ts";
import { ERROR_STATUS, at, pathOf } from "../bugs/admin-shared.ts";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import { pageTitle } from "../meta.ts";
import type { Route } from "./+types/_app.admin.bugs.errors.$groupId";

/**
 * One kind of error from people's browsers: how often, for whom, and its
 * latest occurrences — each with its stack and what the person did just before.
 */
export function loader({ request, context, params }: Route.LoaderArgs) {
  requireAdmin(context, request);
  const group = getErrorGroup(Number(params.groupId));
  if (!group) throw new Response("That error is no longer listed.", { status: 404 });
  return { group };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Error");
}

const STATUSES: ErrorGroupStatus[] = ["new", "fixed", "ignored"];

export async function action({ request, context, params }: Route.ActionArgs) {
  const { user } = requireAdmin(context, request);
  return handleForm(request, {
    status: (form) => {
      const status = stringField(form, "status") as ErrorGroupStatus;
      if (!STATUSES.includes(status)) throw new UserInputError("Pick a status.");
      try {
        setErrorGroupStatus({ id: Number(params.groupId), status, actorUserId: user.id, now: Date.now() });
      } catch (err) {
        if (err instanceof OpError) throw new UserInputError(err.message);
        throw err;
      }
      return {
        ok: true,
        message:
          status === "fixed"
            ? "Marked fixed. If it happens again it opens again, and admins are told."
            : status === "ignored"
              ? "Ignored. It's still counted, but nobody is told about it."
              : "Reopened.",
      };
    },
  });
}

export default function ErrorGroupPage({ loaderData }: Route.ComponentProps) {
  const { group: g } = loaderData;
  const fetcher = useFetcher<typeof action>();
  useActionFeedback(fetcher.data);
  const set = (status: ErrorGroupStatus) => fetcher.submit({ intent: "status", status }, { method: "post" });

  return (
    <Stack gap="lg" maw={1100}>
      <Anchor component={Link} to="/admin/bugs" size="sm">
        ← All bug reports
      </Anchor>
      <Stack gap={6}>
        <Title order={2} ff="monospace" fz="h3" style={{ overflowWrap: "anywhere" }}>
          {g.message}
        </Title>
        <Group gap="xs">
          <Badge color={ERROR_STATUS[g.status]!.color} variant="light">
            {ERROR_STATUS[g.status]!.label}
          </Badge>
          {g.regressedAt && g.status === "new" && (
            <Badge color="orange" variant="light">
              Back after a fix, {at(g.regressedAt)}
            </Badge>
          )}
          <Text size="sm" c="dimmed">
            {g.count} time{g.count === 1 ? "" : "s"}, first {at(g.firstSeenAt)}, last {at(g.lastSeenAt)} ·{" "}
            {[...g.people, ...(g.signedOut ? ["someone signed out"] : [])].join(", ") || "—"}
          </Text>
        </Group>
        <Group>
          {g.status !== "fixed" && (
            <Button size="compact-sm" onClick={() => void set("fixed")} loading={fetcher.state !== "idle"}>
              Mark fixed
            </Button>
          )}
          {g.status !== "ignored" && (
            <Button size="compact-sm" variant="default" onClick={() => void set("ignored")}>
              Ignore
            </Button>
          )}
          {g.status !== "new" && (
            <Button size="compact-sm" variant="default" onClick={() => void set("new")}>
              Reopen
            </Button>
          )}
        </Group>
      </Stack>

      <Title order={4}>Latest occurrences</Title>
      {g.events.map((e) => (
        <Card key={e.id} withBorder>
          <Stack gap="xs">
            <Text size="sm">
              {at(e.clientTime)} · {e.userName ?? "signed out"} · {e.url ? pathOf(e.url) : "?"} · code{" "}
              {shortRevision(e.clientRevision ?? "?")} · {e.detail.source}
              {e.repeats > 1 ? ` · ×${e.repeats}` : ""}
            </Text>
            <Text size="xs" c="dimmed">
              {e.userAgent}
            </Text>
            {e.detail.stack && (
              <Code block style={{ maxHeight: 240, overflow: "auto" }}>
                {e.detail.stack}
              </Code>
            )}
            {e.detail.breadcrumbs.length > 0 && (
              <Table verticalSpacing={2} fz="xs">
                <Table.Tbody>
                  {e.detail.breadcrumbs.map((c, i) => (
                    <Table.Tr key={i}>
                      <Table.Td c="dimmed" style={{ whiteSpace: "nowrap" }}>
                        {new Date(c.at).toLocaleTimeString()}
                      </Table.Td>
                      <Table.Td>{c.kind}</Table.Td>
                      <Table.Td>{c.text}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}
