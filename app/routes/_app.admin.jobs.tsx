import { Anchor, Badge, Box, Button, Card, Group, Stack, Switch, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";

import { accountingBackendOrError } from "../../src/accounting/index.ts";
import { config } from "../../src/config.server.ts";
import { jobLabel } from "../../src/job-names.ts";
import { createJob, listJobs, updateJob } from "../../src/jobs.ts";
import { JOB_NAME_MAX_LENGTH } from "../../src/limits.ts";
import { OpError } from "../../src/op-error.ts";
import { requireNoteOnStop, setRequireNoteOnStop } from "../../src/settings.ts";
import { UserInputError } from "../../src/users.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { handleForm, stringField } from "../actions.server.ts";
import { requireAdmin } from "../auth.server.ts";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import { pageTitle } from "../meta.ts";
import { type JobNode, jobTree, nameWithin } from "../tracker/job-groups.ts";
import type { Route } from "./+types/_app.admin.jobs";

export async function loader({ request, context }: Route.LoaderArgs) {
  requireAdmin(context, request);

  // A backend missing its settings throws on construction by design
  // (src/accounting/index.ts); report that rather than failing the page.
  const resolved = accountingBackendOrError();
  const backend = resolved.backend
    ? { kind: resolved.backend.kind, ...(await resolved.backend.health()) }
    : { kind: config.accounting.kind, ok: false, detail: resolved.error };

  return {
    backend,
    timezone: config.timezone,
    requireNoteOnStop: requireNoteOnStop(),
    jobs: listJobs({ includeInactive: true }).map((j) => ({
      id: j.id,
      name: j.name,
      fullName: j.fullName,
      parentId: j.parentId,
      active: j.active,
      requiresNote: j.requiresNote,
      noteRequired: j.noteRequired,
      takesTime: j.takesTime,
      provisional: j.provisional,
      remote: j.remoteId != null,
      remoteActive: j.remoteActive,
    })),
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Jobs");
}

export async function action({ request, context }: Route.ActionArgs) {
  const { user } = requireAdmin(context, request);
  const flag = (form: FormData, name: string) => stringField(form, name) === "true";
  return handleForm(request, {
    // A customer when there's no parent, a job under one otherwise.
    create: (form) => {
      try {
        const job = createJob({
          id: uuidv7(),
          name: stringField(form, "name"),
          parentId: stringField(form, "parentId") || null,
          actorUserId: user.id,
        });
        return { ok: true, message: `Added “${jobLabel(job.fullName)}”.` };
      } catch (err) {
        // createJob speaks the op dialect; this is a form.
        if (err instanceof OpError) throw new UserInputError(err.message);
        throw err;
      }
    },
    rename: (form) => {
      const job = updateJob({ id: stringField(form, "jobId"), name: stringField(form, "name"), actorUserId: user.id });
      return { ok: true, message: `Renamed to “${jobLabel(job.fullName)}”.` };
    },
    active: (form) => {
      const job = updateJob({ id: stringField(form, "jobId"), active: flag(form, "value"), actorUserId: user.id });
      return {
        ok: true,
        message: job.active ? `“${jobLabel(job.fullName)}” is open again.` : `Closed “${jobLabel(job.fullName)}”.`,
      };
    },
    "requires-note": (form) => {
      updateJob({ id: stringField(form, "jobId"), requiresNote: flag(form, "value"), actorUserId: user.id });
      return { ok: true, message: "" };
    },
    // "default" clears the answer, so the job follows the rule again.
    "takes-time": (form) => {
      const value = stringField(form, "value");
      const job = updateJob({
        id: stringField(form, "jobId"),
        takesTime: value === "default" ? null : value === "true",
        actorUserId: user.id,
      });
      return {
        ok: true,
        message: job.bookable ? `Time can be booked to “${jobLabel(job.fullName)}”.` : `“${jobLabel(job.fullName)}” holds its sub-jobs; hours go on those.`,
      };
    },
    "global-note": (form) => {
      setRequireNoteOnStop(flag(form, "value"), user.id);
      return { ok: true, message: "" };
    },
  });
}

type JobItem = Route.ComponentProps["loaderData"]["jobs"][number];
type RowsFetcher = ReturnType<typeof useFetcher<typeof action>>;

export default function Jobs({ loaderData }: Route.ComponentProps) {
  const { backend, jobs, requireNoteOnStop, timezone } = loaderData;
  const settings = useFetcher();
  useActionFeedback(settings.data);
  // Shared by the rows: opening or closing moves things between the lists.
  const rows = useFetcher<typeof action>();
  useActionFeedback(rows.data);

  // Customers with their jobs, a job's sub-jobs nested under it.
  const customers = jobTree(jobs);
  const isOpen = (c: JobItem) => c.active && c.remoteActive;
  const open = customers.filter((c) => isOpen(c.customer));
  const closed = customers.filter((c) => !isOpen(c.customer));

  return (
    <Stack gap="xl" maw={760}>
      <Title order={2}>Jobs</Title>

      <Card withBorder>
        <Stack gap="xs">
          <Group justify="space-between">
            <Text fw={500}>Accounting backend</Text>
            <Badge color={backend.ok ? "green" : "yellow"}>{backend.kind}</Badge>
          </Group>
          <Text size="sm">
            Time is booked to jobs, and every job belongs to a customer. A customer groups its jobs and can't take time
            itself.
          </Text>
          {backend.kind !== "none" && (
            <Text size="sm">
              Customers and jobs come from QuickBooks and keep their QuickBooks names. Ones made here are linked or
              created there on the{" "}
              <Anchor component={Link} to="/admin/accounting#jobs">
                Accounting page
              </Anchor>
              .
            </Text>
          )}
          <Text size="sm" c="dimmed">
            {backend.detail}
          </Text>
          <Text size="sm" c="dimmed">
            Work days are counted in {timezone}.
          </Text>
        </Stack>
      </Card>

      <Card withBorder>
        <Stack gap={4}>
          <Switch
            label="Every timer needs a note before it stops"
            checked={requireNoteOnStop}
            disabled={settings.state !== "idle"}
            onChange={(e) =>
              settings.submit({ intent: "global-note", value: String(e.currentTarget.checked) }, { method: "post" })
            }
          />
          <Text size="xs" c="dimmed">
            You can also require notes for a customer's jobs, or for single jobs, below.
          </Text>
        </Stack>
      </Card>

      <NewCustomerForm />

      <Stack gap="sm">
        <Title order={3}>Customers</Title>
        {open.length === 0 ? (
          <Text c="dimmed">
            No customers yet. Add one above and its jobs under it — or people can make them as they track time.
          </Text>
        ) : (
          open.map((c) => <CustomerCard key={c.customer.id} customer={c.customer} jobs={c.jobs} fetcher={rows} />)
        )}
      </Stack>

      {closed.length > 0 && (
        <Stack gap="sm">
          <Title order={3}>Closed customers</Title>
          <Text size="sm" c="dimmed">
            A closed customer's jobs keep their history but can't take new time.
          </Text>
          {closed.map((c) => (
            <CustomerCard key={c.customer.id} customer={c.customer} jobs={c.jobs} fetcher={rows} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function NewCustomerForm() {
  const fetcher = useFetcher<typeof action>();
  useActionFeedback(fetcher.data);
  const form = useRef<HTMLFormElement>(null);
  // Clear the field once the customer exists, ready for the next one.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) form.current?.reset();
  }, [fetcher.state, fetcher.data]);
  return (
    <Card withBorder>
      <fetcher.Form method="post" ref={form}>
        <input type="hidden" name="intent" value="create" />
        <Group align="end" gap="xs">
          <TextInput name="name" label="New customer" maxLength={JOB_NAME_MAX_LENGTH} required style={{ flex: 1 }} />
          <Button type="submit" loading={fetcher.state !== "idle"}>
            Add customer
          </Button>
        </Group>
      </fetcher.Form>
      <Text size="xs" c="dimmed" mt="xs">
        Jobs are added under their customer, below.
      </Text>
    </Card>
  );
}

function CustomerCard({ customer, jobs, fetcher }: { customer: JobItem; jobs: JobNode<JobItem>[]; fetcher: RowsFetcher }) {
  const busy = fetcher.state !== "idle";
  const submit = (intent: string, value: string) =>
    fetcher.submit({ intent, jobId: customer.id, value }, { method: "post" });
  const open = customer.active && customer.remoteActive;

  return (
    <Card withBorder padding="sm" opacity={open ? 1 : 0.7} role="group" aria-label={jobLabel(customer.fullName)}>
      <Stack gap="sm">
        <NameLine job={customer} label={customer.fullName} fetcher={fetcher} />
        <Group gap="lg">
          <Switch
            size="sm"
            label="Open"
            checked={customer.active}
            disabled={busy}
            onChange={(e) => submit("active", String(e.currentTarget.checked))}
          />
          <Switch
            size="sm"
            label="Its jobs need a note"
            checked={customer.requiresNote}
            disabled={busy}
            onChange={(e) => submit("requires-note", String(e.currentTarget.checked))}
          />
        </Group>
        <Nested>
          {jobs.length === 0 && (
            <Text size="sm" c="dimmed">
              No jobs yet. Time can't be booked to a customer itself.
            </Text>
          )}
          {jobs.map((node) => (
            <JobRow
              key={node.job.id}
              node={node}
              parent={customer}
              ruleFrom={customer.requiresNote ? customer : null}
              fetcher={fetcher}
            />
          ))}
          <AddJobForm customer={customer} />
        </Nested>
      </Stack>
    </Card>
  );
}

/** A job, named within the row above it, with its own sub-jobs nested under it. */
function JobRow({
  node,
  parent,
  ruleFrom,
  fetcher,
}: {
  node: JobNode<JobItem>;
  parent: JobItem;
  /** The nearest row above that asks for a note, if one does. */
  ruleFrom: JobItem | null;
  fetcher: RowsFetcher;
}) {
  const job = node.job;
  const busy = fetcher.state !== "idle";
  const submit = (intent: string, value: string) => fetcher.submit({ intent, jobId: job.id, value }, { method: "post" });
  // A job holding sub-jobs takes no hours itself unless an admin says so.
  const hasSubJobs = node.children.length > 0;
  const takesHours = job.takesTime ?? !hasSubJobs;
  // The rule comes from a row above — its customer, or a job it sits under —
  // and the job's own switch can't turn it off.
  const inherited = job.noteRequired && !job.requiresNote;

  return (
    <Box role="group" aria-label={jobLabel(job.fullName)} opacity={job.active ? 1 : 0.6}>
      <Stack gap={4}>
        <NameLine job={job} label={nameWithin(job, parent)} fetcher={fetcher} />
        <Group gap="lg">
          <Switch
            size="sm"
            label="Open"
            checked={job.active}
            disabled={busy}
            onChange={(e) => submit("active", String(e.currentTarget.checked))}
          />
          <Switch
            size="sm"
            label={inherited && ruleFrom ? `Needs a note (${ruleFrom.name}'s rule)` : "Needs a note"}
            checked={job.noteRequired}
            disabled={busy || inherited}
            onChange={(e) => submit("requires-note", String(e.currentTarget.checked))}
          />
          <Switch
            size="sm"
            label="Takes hours"
            checked={takesHours}
            disabled={busy}
            onChange={(e) => submit("takes-time", String(e.currentTarget.checked))}
          />
        </Group>
        {/* Only worth a word when it isn't the ordinary case of a job taking its own hours. */}
        {(job.takesTime != null || hasSubJobs) && (
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              {job.takesTime == null
                ? "It holds sub-jobs, so hours go on those."
                : takesHours
                  ? "Set here: hours go on this job."
                  : "Set here: hours don't go on this job."}
            </Text>
            {job.takesTime != null && (
              <Button size="compact-xs" variant="subtle" disabled={busy} onClick={() => submit("takes-time", "default")}>
                Use the default
              </Button>
            )}
          </Group>
        )}
        {node.children.length > 0 && (
          <Nested>
            {node.children.map((child) => (
              <JobRow
                key={child.job.id}
                node={child}
                parent={job}
                ruleFrom={job.requiresNote ? job : ruleFrom}
                fetcher={fetcher}
              />
            ))}
          </Nested>
        )}
      </Stack>
    </Box>
  );
}

/** What sits under a customer or a job: set in from it, with a line down the side. */
function Nested({ children }: { children: React.ReactNode }) {
  return (
    <Stack gap="sm" pl="md" style={{ borderLeft: "2px solid var(--mantine-color-default-border)" }}>
      {children}
    </Stack>
  );
}

/** The name, what's known about it in the accounting system, and Rename for names made here. */
function NameLine({ job, label, fetcher }: { job: JobItem; label: string; fetcher: RowsFetcher }) {
  const [renaming, setRenaming] = useState(false);

  if (renaming) {
    return (
      <fetcher.Form method="post" onSubmit={() => setRenaming(false)}>
        <input type="hidden" name="intent" value="rename" />
        <input type="hidden" name="jobId" value={job.id} />
        <Group align="end" gap="xs">
          <TextInput
            name="name"
            label="Name"
            defaultValue={job.name}
            maxLength={JOB_NAME_MAX_LENGTH}
            required
            style={{ flex: 1 }}
          />
          <Button type="submit" size="sm">
            Save
          </Button>
          <Button variant="subtle" size="sm" onClick={() => setRenaming(false)}>
            Cancel
          </Button>
        </Group>
      </fetcher.Form>
    );
  }

  return (
    <Group justify="space-between" wrap="nowrap">
      <Group gap="xs">
        <Text fw={500}>{label}</Text>
        {job.provisional && !job.remote && (
          <Badge
            size="sm"
            color="yellow"
            variant="light"
            component={Link}
            to="/admin/accounting#jobs"
            style={{ cursor: "pointer" }}
          >
            not in QuickBooks yet
          </Badge>
        )}
        {job.remote && !job.remoteActive && (
          <Badge size="sm" color="gray" variant="light">
            inactive in QuickBooks
          </Badge>
        )}
      </Group>
      {!job.remote && (
        <Button size="compact-xs" variant="subtle" onClick={() => setRenaming(true)}>
          Rename
        </Button>
      )}
    </Group>
  );
}

/** "Add a job" inside a customer: a name, and the customer is implied. */
function AddJobForm({ customer }: { customer: JobItem }) {
  const fetcher = useFetcher<typeof action>();
  useActionFeedback(fetcher.data);
  const [open, setOpen] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      form.current?.reset();
      setOpen(false);
    }
  }, [fetcher.state, fetcher.data]);

  if (!open) {
    return (
      <Group>
        <Button size="compact-sm" variant="subtle" onClick={() => setOpen(true)}>
          Add a job
        </Button>
      </Group>
    );
  }
  return (
    <fetcher.Form method="post" ref={form}>
      <input type="hidden" name="intent" value="create" />
      <input type="hidden" name="parentId" value={customer.id} />
      <Group align="end" gap="xs">
        <TextInput
          name="name"
          label={`New job for ${jobLabel(customer.fullName)}`}
          maxLength={JOB_NAME_MAX_LENGTH}
          required
          autoFocus
          style={{ flex: 1 }}
        />
        <Button type="submit" size="sm" loading={fetcher.state !== "idle"}>
          Add job
        </Button>
        <Button variant="subtle" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </Group>
    </fetcher.Form>
  );
}
