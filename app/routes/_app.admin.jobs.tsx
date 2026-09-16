import { Badge, Button, Card, Group, Stack, Switch, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

import { accountingBackend } from "../../src/accounting/index.ts";
import { BackendUnavailableError } from "../../src/accounting/types.ts";
import { config } from "../../src/config.server.ts";
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
import type { Route } from "./+types/_app.admin.jobs";

export async function loader({ request, context }: Route.LoaderArgs) {
  requireAdmin(context, request);

  let backend: { kind: string; ok: boolean; detail: string };
  try {
    const b = accountingBackend();
    backend = { kind: b.kind, ...(await b.health()) };
  } catch (err) {
    // A selected-but-unimplemented backend throws on construction by design
    // (src/accounting/index.ts). Report it rather than failing the page.
    backend = {
      kind: config.accounting.kind,
      ok: false,
      detail: err instanceof BackendUnavailableError ? err.message : String(err),
    };
  }

  return {
    backend,
    timezone: config.timezone,
    requireNoteOnStop: requireNoteOnStop(),
    jobs: listJobs({ includeInactive: true }).map((j) => ({
      id: j.id,
      name: j.name,
      fullName: j.fullName,
      active: j.active,
      requiresNote: j.requiresNote,
      provisional: j.provisional,
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
    create: (form) => {
      try {
        const job = createJob({ id: uuidv7(), name: stringField(form, "name"), actorUserId: user.id });
        return { ok: true, message: `Added “${job.fullName}”.` };
      } catch (err) {
        // createJob speaks the op dialect; this is a form.
        if (err instanceof OpError) throw new UserInputError(err.message);
        throw err;
      }
    },
    rename: (form) => {
      const job = updateJob({ id: stringField(form, "jobId"), name: stringField(form, "name"), actorUserId: user.id });
      return { ok: true, message: `Renamed to “${job.fullName}”.` };
    },
    active: (form) => {
      const job = updateJob({ id: stringField(form, "jobId"), active: flag(form, "value"), actorUserId: user.id });
      return { ok: true, message: job.active ? `“${job.fullName}” is open again.` : `Closed “${job.fullName}”.` };
    },
    "requires-note": (form) => {
      updateJob({ id: stringField(form, "jobId"), requiresNote: flag(form, "value"), actorUserId: user.id });
      return { ok: true, message: "" };
    },
    "global-note": (form) => {
      setRequireNoteOnStop(flag(form, "value"), user.id);
      return { ok: true, message: "" };
    },
  });
}

export default function Jobs({ loaderData }: Route.ComponentProps) {
  const { backend, jobs, requireNoteOnStop, timezone } = loaderData;
  const settings = useFetcher();
  useActionFeedback(settings.data);
  const open = jobs.filter((j) => j.active);
  const closed = jobs.filter((j) => !j.active);

  return (
    <Stack gap="xl" maw={760}>
      <Title order={2}>Jobs</Title>

      <Card withBorder>
        <Stack gap="xs">
          <Group justify="space-between">
            <Text fw={500}>Accounting backend</Text>
            <Badge color={backend.ok ? "green" : "yellow"}>{backend.kind}</Badge>
          </Group>
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
            You can also require notes for individual jobs below.
          </Text>
        </Stack>
      </Card>

      <NewJobForm />

      <Stack gap="sm">
        <Title order={3}>Open jobs</Title>
        {open.length === 0 ? (
          <Text c="dimmed">No jobs yet. Add one above, or people can create them as they track time.</Text>
        ) : (
          open.map((j) => <JobRow key={j.id} job={j} />)
        )}
      </Stack>

      {closed.length > 0 && (
        <Stack gap="sm">
          <Title order={3}>Closed jobs</Title>
          <Text size="sm" c="dimmed">
            Closed jobs keep their history but can't take new time.
          </Text>
          {closed.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function NewJobForm() {
  const fetcher = useFetcher<typeof action>();
  useActionFeedback(fetcher.data);
  const form = useRef<HTMLFormElement>(null);
  // Clear the field once the job exists, ready for the next one.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) form.current?.reset();
  }, [fetcher.state, fetcher.data]);
  return (
    <Card withBorder>
      <fetcher.Form method="post" ref={form}>
        <input type="hidden" name="intent" value="create" />
        <Group align="end" gap="xs">
          <TextInput name="name" label="New job" maxLength={JOB_NAME_MAX_LENGTH} required style={{ flex: 1 }} />
          <Button type="submit" loading={fetcher.state !== "idle"}>
            Add job
          </Button>
        </Group>
      </fetcher.Form>
    </Card>
  );
}

type JobItem = Route.ComponentProps["loaderData"]["jobs"][number];

function JobRow({ job }: { job: JobItem }) {
  const fetcher = useFetcher();
  useActionFeedback(fetcher.data);
  const [renaming, setRenaming] = useState(false);
  const busy = fetcher.state !== "idle";
  const submit = (intent: string, value: string) =>
    fetcher.submit({ intent, jobId: job.id, value }, { method: "post" });

  return (
    <Card withBorder padding="sm" opacity={job.active ? 1 : 0.7}>
      <Stack gap="xs">
        {renaming ? (
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
        ) : (
          <Group justify="space-between" wrap="nowrap">
            <Group gap="xs">
              <Text fw={500}>{job.fullName}</Text>
              {job.provisional && (
                <Badge size="sm" color="yellow" variant="light">
                  not yet linked
                </Badge>
              )}
            </Group>
            <Button size="compact-xs" variant="subtle" onClick={() => setRenaming(true)}>
              Rename
            </Button>
          </Group>
        )}
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
            label="Needs a note"
            checked={job.requiresNote}
            disabled={busy}
            onChange={(e) => submit("requires-note", String(e.currentTarget.checked))}
          />
        </Group>
      </Stack>
    </Card>
  );
}
