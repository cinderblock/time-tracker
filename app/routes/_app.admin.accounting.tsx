import { Alert, Anchor, Badge, Button, Card, Group, List, Select, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import { Link, useFetcher } from "react-router";

import { accountingBackendOrError } from "../../src/accounting/index.ts";
import { listCategories } from "../../src/categories.ts";
import { config } from "../../src/config.server.ts";
import { formatDateTime, formatRelative } from "../../src/format.ts";
import { listJobs } from "../../src/jobs.ts";
import {
  categoryPayrollItems,
  linkJob,
  linkPerson,
  listRemoteItems,
  listRemotePeople,
  personLinks,
  requestJobCreation,
  requestPull,
  setCategoryPayrollItem,
  setDefaultItems,
  setJobServiceItem,
  setPersonPayrollItem,
} from "../../src/remote-lists.ts";
import { defaultPayrollItemId, defaultServiceItemId, syncState } from "../../src/settings.ts";
import { retryFailedNow, syncOverview } from "../../src/sync.ts";
import { runSync } from "../../src/sync-worker.ts";
import { formatDurationHuman, formatWorkDate } from "../../src/time.ts";
import { listUsers } from "../../src/users.ts";
import { type ActionResult, handleForm, intField, stringField } from "../actions.server.ts";
import { requireAdmin } from "../auth.server.ts";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import { pageTitle } from "../meta.ts";
import type { Route } from "./+types/_app.admin.accounting";

/**
 * Where approved time goes: the accounting connection's state, what's
 * waiting and why, and the links between this app's people and jobs and the
 * accounting system's.
 */

const KIND_LABELS = {
  none: "Not connected",
  "qb-bridge": "QuickBooks, through the QB Bridge",
  "qb-webconnector": "QuickBooks, through the Web Connector",
} as const;

export async function loader({ request, context }: Route.LoaderArgs) {
  requireAdmin(context, request);
  const { backend, error } = accountingBackendOrError();
  const kind = backend?.kind ?? config.accounting.kind;
  const health = backend ? await backend.health() : { ok: false, detail: error ?? "" };
  const connected = backend != null && backend.kind !== "none";
  const state = syncState();

  if (!connected) {
    return { kind, label: KIND_LABELS[kind], connected: false as const, health };
  }

  const people = listRemotePeople();
  const items = listRemoteItems();
  const links = new Map(personLinks().map((l) => [l.userId, l]));
  const jobs = listJobs({ includeInactive: true });
  const itemOption = (i: (typeof items)[number]) => ({ value: i.remoteId, label: i.active ? i.fullName : `${i.fullName} (inactive)` });
  const peopleGroups = (["employee", "vendor", "other"] as const)
    .map((k) => ({
      group: { employee: "Employees", vendor: "Vendors", other: "Other names" }[k],
      items: people
        .filter((p) => p.kind === k)
        .map((p) => ({ value: p.remoteId, label: p.active ? p.name : `${p.name} (inactive)` })),
    }))
    .filter((g) => g.items.length > 0);
  const remoteJobs = jobs.filter((j) => j.remoteId);
  const byName = new Map(remoteJobs.map((j) => [j.fullName.toLowerCase(), j]));
  const categoryItems = categoryPayrollItems();
  const overview = syncOverview();

  return {
    kind,
    label: KIND_LABELS[kind],
    connected: true as const,
    delivery: backend.delivery,
    syncEverySeconds: config.accounting.syncEverySeconds,
    health,
    lastPull: state.lastPullAt ? formatRelative(state.lastPullAt) : null,
    lastContact: state.lastContactAt ? `${formatDateTime(state.lastContactAt)} — ${state.lastContactDetail}` : null,
    // Times are formatted here: the browser has neither the server's clock nor its timezone.
    overview: {
      ...overview,
      failed: overview.failed.map((f) => ({ ...f, retry: f.retryAt ? formatRelative(f.retryAt) : null })),
      recent: overview.recent.map((r) => ({ ...r, when: formatRelative(r.at) })),
    },
    peopleGroups,
    serviceItems: items.filter((i) => i.kind === "service").map(itemOption),
    payrollItems: items.filter((i) => i.kind === "payroll_wage").map(itemOption),
    defaults: { service: defaultServiceItemId(), payroll: defaultPayrollItemId() },
    users: listUsers()
      .filter((u) => u.active || links.get(u.id)?.remotePersonId)
      .map((u) => {
        const link = links.get(u.id);
        const remote = people.find((p) => p.remoteId === link?.remotePersonId);
        return {
          id: u.id,
          name: u.name,
          remotePersonId: link?.remotePersonId ?? null,
          isEmployee: remote?.kind === "employee",
          payrollItemId: link?.payrollItemId ?? null,
          suggestion: remote ? null : (people.find((p) => p.active && p.name.toLowerCase() === u.name.toLowerCase())?.remoteId ?? null),
        };
      }),
    categories: listCategories().map((c) => ({ id: c.id, name: c.name, payrollItemId: categoryItems.get(c.id) ?? null })),
    provisional: jobs
      .filter((j) => !j.remoteId)
      .map((j) => {
        // A job's time has to land on a job there, never on a customer.
        const isJob = j.parentId != null;
        const sameName = byName.get(j.fullName.toLowerCase());
        return {
          id: j.id,
          fullName: j.fullName,
          isJob,
          active: j.active,
          createRequested: j.createRequestedAt != null,
          error: j.syncError,
          suggestion: sameName && !(isJob && !sameName.parentId) ? sameName.id : null,
        };
      }),
    remoteJobs: remoteJobs.map((j) => ({
      value: j.id,
      label: j.remoteActive ? j.fullName : `${j.fullName} (inactive)`,
      customer: j.parentId == null,
    })),
    jobServiceItems: remoteJobs
      .filter((j) => j.defaultServiceItemId)
      .map((j) => ({ id: j.id, fullName: j.fullName, itemId: j.defaultServiceItemId! })),
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Accounting");
}

export async function action({ request, context }: Route.ActionArgs) {
  const { user } = requireAdmin(context, request);
  const actorUserId = user.id;
  const item = (form: FormData) => stringField(form, "itemId") || null;
  // After a change that creates work, try to send it straight away (push backends).
  const summary = async (lead: string): Promise<ActionResult> => {
    const run = await runSync();
    return { ok: true, message: `${lead} ${run.detail}`.trim() };
  };
  return handleForm(request, {
    "sync-now": () => summary(""),
    pull: () => {
      requestPull();
      return summary("Lists will refresh at the next contact.");
    },
    retry: () => {
      const n = retryFailedNow();
      return summary(`Retrying ${n} ${n === 1 ? "entry" : "entries"}.`);
    },
    "link-person": (form) => {
      linkPerson({ userId: intField(form, "userId"), remoteId: stringField(form, "remoteId") || null, actorUserId });
      return { ok: true, message: "Link saved." };
    },
    "person-payroll": (form) => {
      setPersonPayrollItem({ userId: intField(form, "userId"), itemId: item(form), actorUserId });
      return { ok: true, message: "Payroll item saved." };
    },
    "category-payroll": (form) => {
      setCategoryPayrollItem({ categoryId: intField(form, "categoryId"), itemId: item(form), actorUserId });
      return { ok: true, message: "Payroll item saved." };
    },
    "default-service": (form) => {
      setDefaultItems({ service: item(form) }, actorUserId);
      return { ok: true, message: "Default service item saved." };
    },
    "default-payroll": (form) => {
      setDefaultItems({ payroll: item(form) }, actorUserId);
      return { ok: true, message: "Default payroll item saved." };
    },
    "job-service": (form) => {
      setJobServiceItem({ jobId: stringField(form, "jobId"), itemId: item(form), actorUserId });
      return { ok: true, message: "Service item saved." };
    },
    "link-job": (form) => {
      linkJob({ jobId: stringField(form, "jobId"), targetId: stringField(form, "targetId"), actorUserId });
      return { ok: true, message: "Linked. Its time now belongs to that job." };
    },
    "create-job": (form) => {
      const create = stringField(form, "create") === "true";
      requestJobCreation({ jobId: stringField(form, "jobId"), create, actorUserId });
      return create ? summary("It will be created at the next contact.") : { ok: true, message: "Won't create it." };
    },
  });
}

type Data = Extract<Route.ComponentProps["loaderData"], { connected: true }>;

export default function Accounting({ loaderData }: Route.ComponentProps) {
  if (!loaderData.connected) {
    return (
      <Stack gap="lg" maw={760}>
        <Title order={2}>Accounting</Title>
        <Card withBorder>
          <Stack gap="xs">
            <Group justify="space-between">
              <Text fw={500}>{loaderData.label}</Text>
              <Badge color={loaderData.kind === "none" ? "gray" : "red"}>{loaderData.kind}</Badge>
            </Group>
            <Text size="sm">{loaderData.health.detail}</Text>
            <Text size="sm" c="dimmed">
              To send approved time to QuickBooks Desktop, set <code>ACCOUNTING_BACKEND</code> to <code>qb-bridge</code>{" "}
              (with <code>QB_BRIDGE_URL</code> and <code>QB_BRIDGE_API_KEY</code>) or <code>qb-webconnector</code> (with{" "}
              <code>QBWC_PASSWORD</code>) in the server's configuration.
            </Text>
          </Stack>
        </Card>
      </Stack>
    );
  }
  const data = loaderData;
  return (
    <Stack gap="xl" maw={960}>
      <Title order={2}>Accounting</Title>
      <ConnectionCard data={data} />
      <Queue data={data} />
      <PeopleSection data={data} />
      <JobsSection data={data} />
      <ItemsSection data={data} />
      <Activity data={data} />
    </Stack>
  );
}

function ConnectionCard({ data }: { data: Data }) {
  const fetcher = useFetcher<typeof action>();
  useActionFeedback(fetcher.data);
  const busy = fetcher.state !== "idle";
  const post = (intent: string) => fetcher.submit({ intent }, { method: "post" });
  return (
    <Card withBorder>
      <Stack gap="sm">
        <Group justify="space-between" gap="xs">
          <Text fw={500}>{data.label}</Text>
          <Badge color={data.health.ok ? "green" : "yellow"}>{data.health.ok ? "connected" : "not connected now"}</Badge>
        </Group>
        <Text size="sm">{data.health.detail}</Text>
        <Text size="sm" c="dimmed">
          {data.lastPull ? `Lists last refreshed ${data.lastPull}.` : "The lists haven't been fetched yet."}
          {data.lastContact ? ` Last contact: ${data.lastContact}` : ""}
        </Text>
        {data.delivery === "push" && (
          <Text size="sm" c="dimmed">
            {data.syncEverySeconds
              ? `Approved time is sent ${everyLabel(data.syncEverySeconds)} while QuickBooks is open on its computer. Nothing is lost while it isn't.`
              : "Approved time is sent when you press Send now. Nothing is lost in between."}
          </Text>
        )}
        {data.delivery === "poll" && <WebConnectorSetup />}
        <Group gap="sm">
          {data.delivery === "push" && (
            <Button onClick={() => post("sync-now")} loading={busy}>
              Send now
            </Button>
          )}
          <Button variant="light" onClick={() => post("pull")} disabled={busy}>
            Refresh lists
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

/** "every minute", "every 5 minutes", "every 30 seconds" */
function everyLabel(seconds: number): string {
  if (seconds % 60 !== 0) return `every ${seconds} seconds`;
  const minutes = seconds / 60;
  return minutes === 1 ? "every minute" : `every ${minutes} minutes`;
}

function WebConnectorSetup() {
  return (
    <Stack gap={4}>
      <Text size="sm">
        The QuickBooks Web Connector on the QuickBooks computer collects work every 15 minutes. To set it up:
      </Text>
      <List size="sm" type="ordered">
        <List.Item>
          <Anchor href="/admin/accounting.qwc" download>
            Download the connection file
          </Anchor>{" "}
          and open it on the QuickBooks computer (Web Connector → Add an application), with the company file open.
        </List.Item>
        <List.Item>Allow access when QuickBooks asks, even when QuickBooks isn't running if you want unattended runs.</List.Item>
        <List.Item>Enter the Web Connector password from the server's configuration, and tick Auto-Run.</List.Item>
      </List>
    </Stack>
  );
}

function Queue({ data }: { data: Data }) {
  const { overview } = data;
  const retry = useFetcher<typeof action>();
  useActionFeedback(retry.data);
  const blockedByReason = new Map<string, { fix: string; count: number; minutes: number; example: (typeof overview.blocked)[number] }>();
  for (const b of overview.blocked) {
    const g = blockedByReason.get(b.reason) ?? { fix: b.fix, count: 0, minutes: 0, example: b };
    g.count++;
    g.minutes += b.minutes;
    blockedByReason.set(b.reason, g);
  }
  const fixLink = (fix: string, example: (typeof overview.blocked)[number]) =>
    fix === "person" ? (
      <Anchor href="#people" size="sm">
        Link people
      </Anchor>
    ) : fix === "job" ? (
      <Anchor href="#jobs" size="sm">
        Link jobs
      </Anchor>
    ) : fix === "item" ? (
      <Anchor href="#items" size="sm">
        Check items
      </Anchor>
    ) : (
      <Anchor component={Link} to={`/admin/people/${example.userId}/time/${example.workDate}`} size="sm">
        Open the day
      </Anchor>
    );

  return (
    <Stack gap="sm">
      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
        <Stat label="Ready to send" value={overview.ready} />
        <Stat label="Waiting on a fix" value={overview.blocked.length} warn={overview.blocked.length > 0} />
        <Stat label="Refused" value={overview.failed.length} warn={overview.failed.length > 0} />
        <Stat label="Sent" value={overview.sent} />
      </SimpleGrid>

      {blockedByReason.size > 0 && (
        <Alert color="yellow" title="Approved time that can't be sent yet">
          <Stack gap="xs">
            {[...blockedByReason].map(([reason, g]) => (
              <Group key={reason} justify="space-between" wrap="nowrap" align="start">
                <Text size="sm">
                  {reason}{" "}
                  <Text span c="dimmed" size="sm">
                    ({g.count} {g.count === 1 ? "entry" : "entries"}, {formatDurationHuman(g.minutes * 60)})
                  </Text>
                </Text>
                {fixLink(g.fix, g.example)}
              </Group>
            ))}
          </Stack>
        </Alert>
      )}

      {overview.failed.length > 0 && (
        <Alert color="red" title="Refused by QuickBooks">
          <Stack gap="xs">
            {overview.failed.map((f) => (
              <Text key={f.entryId} size="sm">
                {f.person}, {formatWorkDate(f.workDate)} ({formatDurationHuman(f.minutes * 60)}): {f.error}
                {f.retry ? ` — tries again ${f.retry}.` : ""}
              </Text>
            ))}
            <Group>
              <Button
                size="compact-sm"
                variant="light"
                color="red"
                loading={retry.state !== "idle"}
                onClick={() => retry.submit({ intent: "retry" }, { method: "post" })}
              >
                Try again now
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}

      {overview.reopened.length > 0 && (
        <Alert color="blue" title="Reopened after being sent">
          <Text size="sm">
            QuickBooks still has the old version of {overview.reopened.length === 1 ? "this entry" : "these entries"} until{" "}
            {overview.reopened.length === 1 ? "it's" : "they're"} approved again:{" "}
            {overview.reopened.map((r) => `${r.person} (${formatWorkDate(r.workDate)})`).join(", ")}.
          </Text>
        </Alert>
      )}

      {overview.jobsToCreate.length > 0 && (
        <Alert color={overview.jobsToCreate.some((j) => j.error) ? "red" : "blue"} title="Jobs to create in QuickBooks">
          <Stack gap={4}>
            {overview.jobsToCreate.map((j) => (
              <Text key={j.jobId} size="sm">
                {j.name}: {j.error ?? "waiting for the next contact."}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
    </Stack>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <Card withBorder padding="sm">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="xl" fw={700} c={warn ? "orange" : undefined}>
        {value}
      </Text>
    </Card>
  );
}

function PeopleSection({ data }: { data: Data }) {
  const noLists = data.peopleGroups.length === 0;
  return (
    <Stack gap="sm" id="people">
      <Title order={3}>People</Title>
      <Text size="sm" c="dimmed">
        Each person's time goes to QuickBooks under the name linked here. Employees can also have a payroll item; without
        one, their category's or the default below is used.
      </Text>
      {noLists && <Text size="sm">Fetch the lists from QuickBooks first.</Text>}
      <Stack gap="xs">
        {data.users.map((u) => (
          <PersonRow key={u.id} user={u} data={data} disabled={noLists} />
        ))}
      </Stack>
    </Stack>
  );
}

function PersonRow({ user, data, disabled }: { user: Data["users"][number]; data: Data; disabled: boolean }) {
  const link = useFetcher<typeof action>();
  const payroll = useFetcher<typeof action>();
  useActionFeedback(link.data);
  useActionFeedback(payroll.data);
  const suggested = user.suggestion
    ? data.peopleGroups.flatMap((g) => g.items).find((i) => i.value === user.suggestion)?.label
    : null;
  return (
    <Card withBorder padding="sm">
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm" verticalSpacing="xs">
        <Stack gap={0} justify="center">
          <Text fw={500}>{user.name}</Text>
          {suggested && (
            <Anchor
              component="button"
              type="button"
              size="xs"
              ta="left"
              onClick={() => link.submit({ intent: "link-person", userId: String(user.id), remoteId: user.suggestion! }, { method: "post" })}
            >
              Link to “{suggested}”?
            </Anchor>
          )}
        </Stack>
        <Select
          aria-label={`QuickBooks name for ${user.name}`}
          placeholder="Not linked"
          data={data.peopleGroups}
          value={user.remotePersonId}
          searchable
          clearable
          disabled={disabled || link.state !== "idle"}
          onChange={(v) => link.submit({ intent: "link-person", userId: String(user.id), remoteId: v ?? "" }, { method: "post" })}
        />
        {user.isEmployee ? (
          <Select
            aria-label={`Payroll item for ${user.name}`}
            placeholder="Category's or default"
            data={data.payrollItems}
            value={user.payrollItemId}
            clearable
            disabled={payroll.state !== "idle"}
            onChange={(v) => payroll.submit({ intent: "person-payroll", userId: String(user.id), itemId: v ?? "" }, { method: "post" })}
          />
        ) : (
          <Text size="xs" c="dimmed" style={{ alignSelf: "center" }}>
            {user.remotePersonId ? "Not an employee: no payroll item." : ""}
          </Text>
        )}
      </SimpleGrid>
    </Card>
  );
}

type Fetcher = ReturnType<typeof useFetcher<typeof action>>;

function JobsSection({ data }: { data: Data }) {
  // Shared by the rows, which disappear once linked or created.
  const fetcher = useFetcher<typeof action>();
  useActionFeedback(fetcher.data);
  return (
    <Stack gap="sm" id="jobs">
      <Title order={3}>Jobs made here</Title>
      <Text size="sm" c="dimmed">
        Customers and jobs people created while tracking aren't in QuickBooks. Link each to what it really is there —
        its time moves along — or have it created in QuickBooks as it is. A job can only be linked to a QuickBooks job,
        since time is never booked to a customer.
      </Text>
      {data.provisional.length === 0 ? (
        <Text size="sm">None. Every job is in QuickBooks.</Text>
      ) : (
        data.provisional.map((j) => <ProvisionalJob key={j.id} job={j} data={data} fetcher={fetcher} />)
      )}
    </Stack>
  );
}

function ProvisionalJob({ job, data, fetcher }: { job: Data["provisional"][number]; data: Data; fetcher: Fetcher }) {
  const busy = fetcher.state !== "idle";
  const suggestion = job.suggestion ? data.remoteJobs.find((r) => r.value === job.suggestion) : null;
  const targets = job.isJob ? data.remoteJobs.filter((r) => !r.customer) : data.remoteJobs;
  return (
    <Card withBorder padding="sm">
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs">
            <Text fw={500}>{job.fullName}</Text>
            {!job.active && (
              <Badge size="sm" color="gray" variant="light">
                closed
              </Badge>
            )}
            {job.createRequested && (
              <Badge size="sm" color="blue" variant="light">
                to be created
              </Badge>
            )}
          </Group>
          <Button
            size="compact-sm"
            variant="light"
            disabled={busy}
            onClick={() =>
              fetcher.submit({ intent: "create-job", jobId: job.id, create: String(!job.createRequested) }, { method: "post" })
            }
          >
            {job.createRequested ? "Don't create" : "Create in QuickBooks"}
          </Button>
        </Group>
        {job.error && (
          <Text size="sm" c="red">
            {job.error}
          </Text>
        )}
        <Group gap="xs" align="end">
          <Select
            aria-label={`Link ${job.fullName} to`}
            placeholder={job.isJob ? "Link to a QuickBooks job…" : "Link to a QuickBooks customer or job…"}
            data={targets}
            searchable
            disabled={busy || targets.length === 0}
            onChange={(v) => v && fetcher.submit({ intent: "link-job", jobId: job.id, targetId: v }, { method: "post" })}
            style={{ flex: 1 }}
          />
          {suggestion && (
            <Button
              size="sm"
              variant="subtle"
              disabled={busy}
              onClick={() => fetcher.submit({ intent: "link-job", jobId: job.id, targetId: suggestion.value }, { method: "post" })}
            >
              Link to “{suggestion.label}”
            </Button>
          )}
        </Group>
      </Stack>
    </Card>
  );
}

function ItemSelect({
  label,
  intent,
  items,
  value,
  extra,
  placeholder = "None",
}: {
  label: string;
  intent: string;
  items: { value: string; label: string }[];
  value: string | null;
  extra?: Record<string, string>;
  placeholder?: string;
}) {
  const fetcher = useFetcher<typeof action>();
  useActionFeedback(fetcher.data);
  return (
    <Select
      label={label}
      placeholder={placeholder}
      data={items}
      value={value}
      clearable
      searchable
      disabled={fetcher.state !== "idle" || items.length === 0}
      onChange={(v) => fetcher.submit({ intent, itemId: v ?? "", ...extra }, { method: "post" })}
    />
  );
}

function ItemsSection({ data }: { data: Data }) {
  const addJob = useFetcher<typeof action>();
  useActionFeedback(addJob.data);
  return (
    <Stack gap="sm" id="items">
      <Title order={3}>Items</Title>
      <Text size="sm" c="dimmed">
        A service item says what the work was, and makes the time billable to the job. A job's own service item is used
        for it and its sub-jobs; otherwise the default. Payroll items apply to employees only.
      </Text>
      <Card withBorder>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <ItemSelect label="Default service item" intent="default-service" items={data.serviceItems} value={data.defaults.service} />
          <ItemSelect label="Default payroll item" intent="default-payroll" items={data.payrollItems} value={data.defaults.payroll} />
          {data.categories.map((c) => (
            <ItemSelect
              key={c.id}
              label={`Payroll item for ${c.name}`}
              intent="category-payroll"
              items={data.payrollItems}
              value={c.payrollItemId}
              extra={{ categoryId: String(c.id) }}
              placeholder="The default"
            />
          ))}
        </SimpleGrid>
      </Card>

      <Title order={4}>Service items for particular jobs</Title>
      {data.jobServiceItems.length > 0 && (
        <Table verticalSpacing="xs">
          <Table.Tbody>
            {data.jobServiceItems.map((j) => (
              <Table.Tr key={j.id}>
                <Table.Td>{j.fullName}</Table.Td>
                <Table.Td>{data.serviceItems.find((i) => i.value === j.itemId)?.label ?? "Unknown item"}</Table.Td>
                <Table.Td ta="right">
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    onClick={() => addJob.submit({ intent: "job-service", jobId: j.id, itemId: "" }, { method: "post" })}
                  >
                    Remove
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      <addJob.Form method="post">
        <input type="hidden" name="intent" value="job-service" />
        <Group align="end" gap="sm">
          <Select name="jobId" label="Job" data={data.remoteJobs} searchable required w={260} />
          <Select name="itemId" label="Service item" data={data.serviceItems} searchable required w={220} />
          <Button type="submit" variant="light" loading={addJob.state !== "idle"}>
            Set
          </Button>
        </Group>
      </addJob.Form>
    </Stack>
  );
}

function Activity({ data }: { data: Data }) {
  const recent = data.overview.recent;
  if (recent.length === 0) return null;
  const labels: Record<string, string> = {
    pull: "Refreshed lists",
    "job.add": "Created a job",
    "entry.add": "Sent time",
    "entry.mod": "Updated time",
    "entry.find": "Looked for time",
    "entry.delete": "Removed time",
  };
  return (
    <Stack gap="sm">
      <Title order={3}>Recent activity</Title>
      <Stack gap={4}>
        {recent.map((r, i) => (
          <Group key={i} gap="xs" wrap="nowrap" align="start">
            <Badge size="xs" color={r.ok ? "green" : "red"} variant="light" style={{ flexShrink: 0 }}>
              {r.ok ? "ok" : "failed"}
            </Badge>
            <Text size="sm">
              {labels[r.work] ?? r.work} · {r.when}
              {r.error ? ` — ${r.error}` : ""}
            </Text>
          </Group>
        ))}
      </Stack>
    </Stack>
  );
}
