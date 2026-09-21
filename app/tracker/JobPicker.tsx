import {
  Button,
  CheckIcon,
  type ComboboxItem,
  type ComboboxParsedItem,
  type ComboboxParsedItemGroup,
  Group,
  Modal,
  type OptionsFilter,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useEffect, useMemo, useState } from "react";

import { jobLabel, jobPath } from "../../src/job-names.ts";
import { JOB_NAME_MAX_LENGTH } from "../../src/limits.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { useTracker } from "./context.tsx";
import { groupJobs, jobRows, listCustomers } from "./job-groups.ts";
import classes from "./JobPicker.module.css";
import type { JobView } from "./model.ts";

/**
 * A job listed under "Recent" can't reuse its id as the option value (Mantine
 * refuses duplicate values), so those carry this prefix; `onChange` strips it.
 */
const RECENT = "recent:";

/** How far a sub-job sits in from the job above it, per layer of nesting. */
const INDENT_PX = 16;

/** What a row needs drawing that its option data doesn't carry. */
interface PickerRow {
  /** The job's own name; where it sits is drawn as nesting, not spelled out. */
  name: string;
  /** 0 for a job directly under its customer. */
  depth: number;
  /** Time can be booked here. If not, the row is only the way to its sub-jobs. */
  bookable: boolean;
  /** The ids of the jobs above it under the same customer. */
  ancestors: string[];
}

const isGroup = (item: ComboboxParsedItem): item is ComboboxParsedItemGroup => "group" in item;

/**
 * Searchable list of every bookable job: the recently used ones first, then
 * each customer's jobs, a job's sub-jobs nested under it. Plus "New job…".
 */
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

  // An option's label is the whole path on one line ("Riverside › Phase 1 ›
  // Deck"): it's what the input shows once a job is chosen, and what typing
  // matches against. In the list itself a job draws its own name, indented to
  // its depth, so a sub-job reads as one instead of repeating what it's under.
  const { data, rows, anyJobs } = useMemo(() => {
    const groups = groupJobs(model.jobs, model.recentJobIds);
    const rows = new Map<string, PickerRow>();
    const data: { group: string; items: ComboboxItem[] }[] = [];
    if (groups.recent.length > 0) {
      const items = groups.recent.map((j) => ({ value: RECENT + j.id, label: jobLabel(j.fullName) }));
      data.push({ group: "Recent", items });
    }
    for (const { customer, jobs } of groups.customers) {
      const items: ComboboxItem[] = [];
      // The ids on the way down to the row being added: its ancestors.
      const path: string[] = [];
      for (const { job, depth } of jobRows(jobs)) {
        path.length = depth;
        rows.set(job.id, { name: job.name, depth, bookable: job.bookable, ancestors: [...path] });
        path.push(job.id);
        // A job that takes no time of its own is the way to its sub-jobs, not a choice.
        items.push({ value: job.id, label: jobLabel(job.fullName), disabled: !job.bookable });
      }
      data.push({ group: customer.fullName, items });
    }
    return { data, rows, anyJobs: groups.customers.length > 0 };
  }, [model.jobs, model.recentJobIds]);

  // Typing matches the full path, which on its own would leave a sub-job
  // under nothing: keep the jobs above a match too, and drop a customer with
  // nothing left under it (Mantine's own filter leaves the bare heading).
  const filter: OptionsFilter = ({ options, search, limit }) => {
    const query = search.trim().toLowerCase();
    const hit = (option: ComboboxItem) => option.label.toLowerCase().includes(query);
    const kept: ComboboxParsedItem[] = [];
    let room = limit;
    for (const item of options) {
      if (room <= 0) break;
      if (!isGroup(item)) {
        if (hit(item)) {
          kept.push(item);
          room -= 1;
        }
        continue;
      }
      const shown = new Set(item.items.filter(hit).map((o) => o.value));
      for (const value of [...shown]) for (const id of rows.get(value)?.ancestors ?? []) shown.add(id);
      const items = item.items.filter((o) => shown.has(o.value)).slice(0, room);
      if (items.length === 0) continue;
      kept.push({ group: item.group, items });
      room -= items.length;
    }
    return kept;
  };

  return (
    <Stack gap={4}>
      <Select
        label={label}
        placeholder={placeholder}
        data={data}
        filter={filter}
        value={value}
        onChange={(v) => onChange(v == null ? null : v.startsWith(RECENT) ? v.slice(RECENT.length) : v)}
        classNames={{ option: classes.option }}
        renderOption={({ option, checked }) => {
          const row = rows.get(option.value);
          return (
            <Group
              gap="xs"
              wrap="nowrap"
              justify="space-between"
              style={{ flex: 1, marginInlineStart: (row?.depth ?? 0) * INDENT_PX }}
            >
              <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                <span>{row?.name ?? option.label}</span>
                {row && !row.bookable && (
                  <Text span size="xs" c="dimmed">
                    sub-jobs only
                  </Text>
                )}
              </Group>
              {checked && <CheckIcon size={12} />}
            </Group>
          );
        }}
        searchable
        clearable={!required}
        // Tapping the job that's already chosen must not un-choose a required one.
        allowDeselect={!required}
        required={required}
        error={error}
        nothingFoundMessage={anyJobs ? "No job by that name" : "No jobs yet. Add one under a customer."}
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

/**
 * A new job under a customer — an existing one, or a new customer named
 * here. Both are provisional until an admin links or creates them in the
 * accounting system.
 */
export function NewJobModal({
  opened,
  onClose,
  onCreated,
}: {
  opened: boolean;
  onClose: () => void;
  onCreated: (jobId: string) => void;
}) {
  const { model, dispatch } = useTracker();
  const narrow = useMediaQuery("(max-width: 36em)");
  const customers = useMemo(() => listCustomers(model.jobs), [model.jobs]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [newCustomer, setNewCustomer] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [customerError, setCustomerError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // With no customers to choose from, naming one is the only way.
  const naming = newCustomer || customers.length === 0;

  useEffect(() => {
    if (!opened) return;
    setCustomerId(null);
    setNewCustomer(false);
    setCustomerName("");
    setName("");
    setCustomerError(null);
    setError(null);
    setBusy(false);
  }, [opened]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    // This dialog is opened from inside another form (the entry editor's).
    // React events bubble up the component tree, not the DOM, so a portal is
    // no escape: without this, making a job here also submits that form —
    // which answers "Pick a job." to a job being made.
    event.stopPropagation();
    setBusy(true);
    setCustomerError(null);
    setError(null);
    let parentId = customerId;
    if (naming) {
      const id = uuidv7();
      const made = await dispatch("job.create", { jobId: id, name: customerName }, { quiet: true });
      if (!made.ok) {
        setBusy(false);
        setCustomerError(made.error);
        return;
      }
      // Keep the new customer chosen: if the job's name is refused, trying
      // again must not make a second customer.
      parentId = id;
      setCustomerId(id);
      setNewCustomer(false);
    }
    if (!parentId) {
      setBusy(false);
      setCustomerError("Pick a customer.");
      return;
    }
    const jobId = uuidv7();
    const result = await dispatch("job.create", { jobId, name, parentId }, { quiet: true });
    setBusy(false);
    if (result.ok) onCreated(jobId);
    else setError(result.error);
  }

  const ready = name.trim() !== "" && (naming ? customerName.trim() !== "" : customerId != null);

  return (
    <Modal opened={opened} onClose={onClose} title="New job" centered fullScreen={narrow}>
      <form onSubmit={create}>
        <Stack>
          {/* The choice sits above the field: the customer list drops down over whatever is below it. */}
          {customers.length > 0 && (
            <SegmentedControl
              fullWidth
              value={newCustomer ? "new" : "existing"}
              onChange={(value) => {
                setNewCustomer(value === "new");
                setCustomerError(null);
              }}
              data={[
                { value: "existing", label: "Existing customer" },
                { value: "new", label: "New customer" },
              ]}
            />
          )}
          {naming ? (
            <TextInput
              label="Customer name"
              value={customerName}
              onChange={(e) => setCustomerName(e.currentTarget.value)}
              maxLength={JOB_NAME_MAX_LENGTH}
              error={customerError}
              required
              data-autofocus
            />
          ) : (
            <Select
              label="Customer"
              placeholder="Pick a customer"
              data={customers.map((c) => ({ value: c.id, label: c.fullName }))}
              value={customerId}
              onChange={setCustomerId}
              searchable
              allowDeselect={false}
              required
              error={customerError}
              nothingFoundMessage="No customer by that name"
              comboboxProps={{ withinPortal: true }}
            />
          )}
          <TextInput
            label="Job name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            maxLength={JOB_NAME_MAX_LENGTH}
            error={error}
            required
          />
          <Text size="sm" c="dimmed">
            For work that can't wait for the job to be set up properly. An admin can tidy it up later, and time you
            book now stays with it.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!ready}>
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
    .filter((j): j is JobView => j != null && j.bookable && j.id !== exclude);
  if (recent.length === 0) return null;
  return (
    <Group gap="xs" grow preventGrowOverflow={false} wrap="wrap">
      {recent.map((job) => {
        const { name, above } = jobPath(job.fullName);
        return (
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
            <Stack gap={0} align="center">
              <Text span size="sm" fw={600} lh={1.2}>
                {name}
              </Text>
              {above && (
                <Text span size="xs" c="dimmed" lh={1.2}>
                  {above}
                </Text>
              )}
            </Stack>
          </Button>
        );
      })}
    </Group>
  );
}
