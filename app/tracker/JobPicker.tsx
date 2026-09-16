import { Button, Group, Modal, Select, Stack, Text, TextInput } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useState } from "react";

import { JOB_NAME_MAX_LENGTH } from "../../src/limits.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { useTracker } from "./context.tsx";
import type { JobView } from "./model.ts";

/** Searchable list of every active job, plus "New job…". */
export function JobSelect({
  value,
  onChange,
  label,
  placeholder = "Search jobs",
  required,
  error,
  allowCreate = true,
}: {
  value: string | null;
  onChange: (jobId: string | null) => void;
  label?: string;
  placeholder?: string;
  required?: boolean;
  error?: string | null;
  allowCreate?: boolean;
}) {
  const { model } = useTracker();
  const [creating, setCreating] = useState(false);
  const data = model.jobs.map((j) => ({ value: j.id, label: j.fullName }));

  return (
    <Stack gap={4}>
      <Select
        label={label}
        placeholder={placeholder}
        data={data}
        value={value}
        onChange={onChange}
        searchable
        clearable={!required}
        // Tapping the job that's already chosen must not un-choose a required one.
        allowDeselect={!required}
        required={required}
        error={error}
        nothingFoundMessage="No job by that name"
        comboboxProps={{ withinPortal: true }}
      />
      {allowCreate && (
        <Group justify="flex-end">
          <Button variant="subtle" size="compact-sm" onClick={() => setCreating(true)}>
            New job…
          </Button>
        </Group>
      )}
      <NewJobModal
        opened={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          onChange(id);
        }}
      />
    </Stack>
  );
}

export function NewJobModal({
  opened,
  onClose,
  onCreated,
}: {
  opened: boolean;
  onClose: () => void;
  onCreated: (jobId: string) => void;
}) {
  const { dispatch } = useTracker();
  const narrow = useMediaQuery("(max-width: 36em)");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const jobId = uuidv7();
    const result = await dispatch("job.create", { jobId, name }, { quiet: true });
    setBusy(false);
    if (result.ok) {
      setName("");
      onCreated(jobId);
    } else {
      setError(result.error);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="New job" centered fullScreen={narrow}>
      <form onSubmit={create}>
        <Stack>
          <TextInput
            label="Job name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            maxLength={JOB_NAME_MAX_LENGTH}
            error={error}
            required
            data-autofocus
          />
          <Text size="sm" c="dimmed">
            For work that can't wait for the job to be set up properly. An admin can tidy it up later, and time you
            book now stays with it.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!name.trim()}>
              Create job
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** Up to six recent jobs as large buttons — the one-tap way to start or switch. */
export function RecentJobButtons({
  onPick,
  exclude,
  disabled,
}: {
  onPick: (job: JobView) => void;
  exclude?: string | null;
  disabled?: boolean;
}) {
  const { model } = useTracker();
  const byId = new Map(model.jobs.map((j) => [j.id, j]));
  const recent = model.recentJobIds
    .map((id) => byId.get(id))
    .filter((j): j is JobView => j != null && j.id !== exclude);
  if (recent.length === 0) return null;
  return (
    <Group gap="xs" grow preventGrowOverflow={false} wrap="wrap">
      {recent.map((job) => (
        <Button
          key={job.id}
          variant="light"
          size="md"
          onClick={() => onPick(job)}
          disabled={disabled}
          styles={{ root: { minWidth: "40%" }, label: { whiteSpace: "normal", lineHeight: 1.2 } }}
          h="auto"
          py="xs"
        >
          {job.fullName}
        </Button>
      ))}
    </Group>
  );
}
