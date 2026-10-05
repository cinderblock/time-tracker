import { Anchor, Badge, Button, Card, Code, Group, Image, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useState } from "react";
import { Link, useFetcher, useNavigate } from "react-router";

import { type BugReportStatus, deleteBugReport, getBugReport, setBugReportStatus } from "../../src/bug-reports.ts";
import type { Breadcrumb, ClientError } from "../../src/bug-schema.ts";
import { shortRevision } from "../../src/build-info.ts";
import { OpError } from "../../src/op-error.ts";
import { UserInputError } from "../../src/users.ts";
import { handleForm, stringField } from "../actions.server.ts";
import { requireAdmin } from "../auth.server.ts";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import { pageTitle } from "../meta.ts";
import type { Route } from "./+types/_app.admin.bugs.$id";
import { REPORT_STATUS, at, pathOf } from "../bugs/admin-shared.ts";

/**
 * One bug report: what the person said, the screenshots, what they did just
 * before, what went wrong in the page, and everything else the page gathered.
 * "Download for an agent" is the whole thing as one zip.
 */
export function loader({ request, context, params }: Route.LoaderArgs) {
  requireAdmin(context, request);
  const report = getBugReport(params.id);
  if (!report) throw new Response("That report no longer exists.", { status: 404 });
  return { report };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Bug report");
}

const STATUSES: BugReportStatus[] = ["new", "fixed", "wont_fix"];

export async function action({ request, context, params }: Route.ActionArgs) {
  const { user } = requireAdmin(context, request);
  const asUserError = <T,>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof OpError) throw new UserInputError(err.message);
      throw err;
    }
  };
  return handleForm(request, {
    status: (form) => {
      const status = stringField(form, "status") as BugReportStatus;
      if (!STATUSES.includes(status)) throw new UserInputError("Pick a status.");
      asUserError(() => setBugReportStatus({ id: params.id, status, note: stringField(form, "note"), actorUserId: user.id, now: Date.now() }));
      return { ok: true, message: `Marked ${REPORT_STATUS[status]!.label.toLowerCase()}.` };
    },
    delete: () => {
      asUserError(() => deleteBugReport({ id: params.id, actorUserId: user.id, now: Date.now() }));
      return { ok: true, message: "Report deleted." };
    },
  });
}

export default function BugReportPage({ loaderData }: Route.ComponentProps) {
  const { report: r } = loaderData;
  const fetcher = useFetcher<typeof action>();
  useActionFeedback(fetcher.data);
  const navigate = useNavigate();
  const [status, setStatus] = useState<string>(r.status);
  const [note, setNote] = useState(r.statusNote ?? "");
  const context = r.context as {
    breadcrumbs?: Breadcrumb[];
    errors?: ClientError[];
    device?: Record<string, unknown>;
    sync?: { outbox?: unknown[]; status?: unknown };
    tabs?: { otherTabs?: { url: string; revision: string; visibility: string }[] };
    screenshotFailed?: string;
  };
  const crumbs = context.breadcrumbs ?? [];
  const errors = context.errors ?? [];
  const stale = r.clientRevision !== r.serverRevision;

  return (
    <Stack gap="lg" maw={1100}>
      <Anchor component={Link} to="/admin/bugs" size="sm">
        ← All bug reports
      </Anchor>
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Title order={2}>Report from {r.userName}</Title>
          <Text size="sm" c="dimmed">
            {at(r.clientTime)} on {pathOf(r.url)}
            {r.receivedAt - r.clientTime > 5 * 60_000 ? ` · arrived ${at(r.receivedAt)} (waited offline)` : ""}
          </Text>
        </Stack>
        <Group>
          <Badge color={REPORT_STATUS[r.status]!.color} variant="light" size="lg">
            {REPORT_STATUS[r.status]!.label}
          </Badge>
          <Button component="a" href={`/admin/bugs/${r.id}/bundle.zip`} download>
            Download for an agent
          </Button>
        </Group>
      </Group>

      <Card withBorder>
        <Stack gap="sm">
          <div>
            <Text size="sm" fw={600}>
              What they were trying to do
            </Text>
            <Text style={{ whiteSpace: "pre-wrap" }}>{r.description}</Text>
          </div>
          {r.expected && (
            <div>
              <Text size="sm" fw={600}>
                What happened instead
              </Text>
              <Text style={{ whiteSpace: "pre-wrap" }}>{r.expected}</Text>
            </div>
          )}
        </Stack>
      </Card>

      {r.imageList.length > 0 ? (
        <SimpleGrid cols={{ base: 1, md: Math.min(r.imageList.length, 2) }}>
          {r.imageList.map((img) => (
            <Stack key={img.id} gap={4}>
              <Anchor href={`/admin/bugs/${r.id}/images/${img.id}`} target="_blank">
                <Image src={`/admin/bugs/${r.id}/images/${img.id}`} alt={img.kind === "drawn" ? "The page as drawn by the app" : "Screen capture"} radius="sm" bd="1px solid var(--mantine-color-default-border)" />
              </Anchor>
              <Text size="xs" c="dimmed">
                {img.kind === "drawn" ? "The page, drawn by the app when the button was pressed" : "The person's screen capture"} · {img.width}×{img.height} ·{" "}
                {Math.round(img.bytes / 1024)} KB
              </Text>
            </Stack>
          ))}
        </SimpleGrid>
      ) : (
        <Text size="sm" c="dimmed">
          No screenshot{context.screenshotFailed ? ` — drawing the page failed: ${context.screenshotFailed}` : "."}
        </Text>
      )}

      <Card withBorder>
        <Stack gap={6}>
          <Text size="sm" fw={600}>
            Where
          </Text>
          <Text size="sm">
            Page code {shortRevision(r.clientRevision)}, server {shortRevision(r.serverRevision)} (build {r.serverBuildId})
            {stale && (
              <Badge ml="xs" color="orange" variant="light">
                Tab was on an older build
              </Badge>
            )}
          </Text>
          <Text size="sm" c="dimmed">
            {r.userAgent ?? "Unknown device"}
          </Text>
          {(context.tabs?.otherTabs?.length ?? 0) > 0 && (
            <Text size="sm">
              Other tabs open:{" "}
              {context.tabs!.otherTabs!.map((t) => `${pathOf(t.url)} (${shortRevision(t.revision)}, ${t.visibility})`).join("; ")}
            </Text>
          )}
          {(context.sync?.outbox?.length ?? 0) > 0 && (
            <Text size="sm" c="orange">
              {context.sync!.outbox!.length} change{context.sync!.outbox!.length === 1 ? "" : "s"} waiting to sync on the device.
            </Text>
          )}
        </Stack>
      </Card>

      {errors.length > 0 && (
        <Stack gap="xs">
          <Title order={4}>Errors on the page</Title>
          {errors.map((e, i) => (
            <Card key={i} withBorder p="sm">
              <Text size="sm" ff="monospace" fw={600}>
                {e.message}
                {e.repeats > 1 ? ` (×${e.repeats})` : ""}
              </Text>
              <Text size="xs" c="dimmed">
                {at(e.at)} · {e.source}
              </Text>
              {e.stack && (
                <Code block mt="xs" style={{ maxHeight: 200, overflow: "auto" }}>
                  {e.stack}
                </Code>
              )}
            </Card>
          ))}
        </Stack>
      )}

      <Stack gap="xs">
        <Title order={4}>What they did, leading up to it</Title>
        {crumbs.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing recorded.
          </Text>
        ) : (
          <Card withBorder p={0}>
            <Table.ScrollContainer minWidth={560}>
              <Table verticalSpacing={4} fz="sm">
                <Table.Tbody>
                  {crumbs.map((c, i) => (
                    <Table.Tr key={i}>
                      <Table.Td style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }} c="dimmed">
                        {new Date(c.at).toLocaleTimeString()}
                      </Table.Td>
                      <Table.Td>
                        <Badge size="xs" variant="light" color={c.kind === "error" ? "red" : c.kind === "op" ? "blue" : "gray"}>
                          {c.kind}
                        </Badge>
                      </Table.Td>
                      <Table.Td>{c.text}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Card>
        )}
      </Stack>

      <Stack gap="xs">
        <Title order={4}>Everything the page sent</Title>
        <Code block style={{ maxHeight: 480, overflow: "auto" }}>
          {JSON.stringify(r.context, null, 2)}
        </Code>
      </Stack>

      <Card withBorder>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="status" />
          <Group align="flex-end">
            <Select
              label="Status"
              name="status"
              value={status}
              onChange={(v) => setStatus(v ?? "new")}
              data={STATUSES.map((s) => ({ value: s, label: REPORT_STATUS[s]!.label }))}
              allowDeselect={false}
              w={160}
            />
            <TextInput label="Note" name="note" value={note} onChange={(e) => setNote(e.currentTarget.value)} placeholder="Fixed in …, or why not" style={{ flex: 1 }} />
            <Button type="submit" loading={fetcher.state !== "idle"}>
              Save
            </Button>
          </Group>
          {r.statusAt && (
            <Text size="xs" c="dimmed" mt={4}>
              Last changed {at(r.statusAt)}
              {r.statusByName ? ` by ${r.statusByName}` : ""}.
            </Text>
          )}
        </fetcher.Form>
      </Card>

      <Group>
        <Button
          variant="subtle"
          color="red"
          onClick={async () => {
            await fetcher.submit({ intent: "delete" }, { method: "post" });
            void navigate("/admin/bugs");
          }}
        >
          Delete this report
        </Button>
      </Group>
    </Stack>
  );
}
