import { Anchor, Badge, Card, Group, SegmentedControl, Stack, Table, Text, Title } from "@mantine/core";
import { useState } from "react";
import { Link } from "react-router";

import { listBugReports } from "../../src/bug-reports.ts";
import { shortRevision } from "../../src/build-info.ts";
import { serverBuild } from "../../src/build-info.server.ts";
import { listErrorGroups } from "../../src/client-errors.ts";
import { requireAdmin } from "../auth.server.ts";
import { ERROR_STATUS, REPORT_STATUS, pathOf, when } from "../bugs/admin-shared.ts";
import { useBugContext } from "../bugs/context.ts";
import { pageTitle } from "../meta.ts";
import type { Route } from "./+types/_app.admin.bugs";

/**
 * Problems people ran into: reports they filed with "Report a problem", and
 * errors their browsers sent on their own, grouped. Open ones first.
 */
export function loader({ request, context }: Route.LoaderArgs) {
  requireAdmin(context, request);
  return { reports: listBugReports(), groups: listErrorGroups(), server: serverBuild() };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Bug reports");
}

export default function BugReports({ loaderData }: Route.ComponentProps) {
  const { reports, groups, server } = loaderData;
  const [tab, setTab] = useState<"reports" | "errors">("reports");
  useBugContext("bugReportsPage", () => ({ tab, reports: reports.length, groups: groups.length }));
  const openReports = reports.filter((r) => r.status === "new").length;
  const openGroups = groups.filter((g) => g.status === "new").length;

  return (
    <Stack gap="lg" maw={1100}>
      <Stack gap={4}>
        <Title order={2}>Bug reports</Title>
        <Text size="sm" c="dimmed">
          What people reported with "Report a problem", and errors their browsers sent on their own. Each report downloads
          as one file an agent can work from. The server is running {shortRevision(server.revision)}.
        </Text>
      </Stack>
      <SegmentedControl
        value={tab}
        onChange={(v) => setTab(v as typeof tab)}
        data={[
          { value: "reports", label: `Reports${openReports ? ` (${openReports} new)` : ""}` },
          { value: "errors", label: `Errors${openGroups ? ` (${openGroups} open)` : ""}` },
        ]}
        w="fit-content"
      />

      {tab === "reports" ? (
        reports.length === 0 ? (
          <Text c="dimmed">No reports yet.</Text>
        ) : (
          <Card withBorder p={0}>
            <Table.ScrollContainer minWidth={640}>
              <Table verticalSpacing="sm" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>When</Table.Th>
                    <Table.Th>Who</Table.Th>
                    <Table.Th>What they were trying to do</Table.Th>
                    <Table.Th>Status</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {reports.map((r) => (
                    <Table.Tr key={r.id}>
                      <Table.Td style={{ whiteSpace: "nowrap" }}>{when(r.clientTime)}</Table.Td>
                      <Table.Td>{r.userName}</Table.Td>
                      <Table.Td>
                        <Anchor component={Link} to={`/admin/bugs/${r.id}`} lineClamp={2} size="sm">
                          {r.description}
                        </Anchor>
                        <Text size="xs" c="dimmed">
                          {pathOf(r.url)} · {shortRevision(r.clientRevision)}
                          {r.images > 0 ? ` · ${r.images} screenshot${r.images === 1 ? "" : "s"}` : ""}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge color={REPORT_STATUS[r.status]!.color} variant="light">
                          {REPORT_STATUS[r.status]!.label}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Card>
        )
      ) : groups.length === 0 ? (
        <Text c="dimmed">No errors reported.</Text>
      ) : (
        <Card withBorder p={0}>
          <Table.ScrollContainer minWidth={640}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Error</Table.Th>
                  <Table.Th>Times</Table.Th>
                  <Table.Th>Last seen</Table.Th>
                  <Table.Th>Status</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {groups.map((g) => (
                  <Table.Tr key={g.id}>
                    <Table.Td>
                      <Anchor component={Link} to={`/admin/bugs/errors/${g.id}`} lineClamp={2} size="sm" ff="monospace">
                        {g.message}
                      </Anchor>
                      <Text size="xs" c="dimmed">
                        {[...g.people, ...(g.signedOut ? ["someone signed out"] : [])].join(", ") || "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>{g.count}</Table.Td>
                    <Table.Td style={{ whiteSpace: "nowrap" }}>{when(g.lastSeenAt)}</Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        <Badge color={ERROR_STATUS[g.status]!.color} variant="light">
                          {ERROR_STATUS[g.status]!.label}
                        </Badge>
                        {g.regressedAt && g.status === "new" && (
                          <Badge color="orange" variant="light">
                            Back after a fix
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}
    </Stack>
  );
}
