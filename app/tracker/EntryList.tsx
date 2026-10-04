import { Alert, Anchor, Badge, Button, Card, Group, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { type MouseEvent, useState } from "react";

import { isEditable, isOwnerReopenable } from "../../src/entry-status.ts";
import { jobLabel, jobPath } from "../../src/job-names.ts";
import { formatClock, formatDurationHuman } from "../../src/time.ts";
import appear from "../components/appear.module.css";
import { ClampedText } from "../components/clamped-text.tsx";
import { useNow, useTracker, useUndoToast } from "./context.tsx";
import { EntryEditor } from "./EntryEditor.tsx";
import { landingClass, useFlight } from "./flight.tsx";
import { type EntryView, liveSeconds } from "./model.ts";
import { useTrackerDraft } from "./tracker-draft.ts";

/**
 * The day's record: the hours it holds, and where they came from. Tap one to
 * edit; delete right from the row, with undo.
 */
export function EntryList() {
  const { model } = useTracker();
  const now = useNow(30_000);
  // Which editor is open — an entry's, or "add time" — kept on the device, so
  // an update or a crash reopens it with what was typed (EntryEditor keeps
  // the fields).
  const [open, setOpen] = useTrackerDraft<{ entryId: string | null } | null>("entry-editor-open", null);
  const editing = open?.entryId
    ? (model.entries.find((e) => e.id === open.entryId) ?? (model.open?.id === open.entryId ? model.open : null))
    : null;
  const adding = open != null && open.entryId == null;
  const setEditing = (e: EntryView | null) => setOpen(e ? { entryId: e.id } : null);
  const setAdding = (on: boolean) => setOpen(on ? { entryId: null } : null);
  const total = model.entries.reduce((sum, e) => sum + (now === undefined ? e.durationSeconds : liveSeconds(e, now)), 0);
  const duplicates = duplicateLines(model.entries);

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="baseline" wrap="nowrap">
        <Stack gap={0}>
          <Title order={3}>Time</Title>
          <Text size="xs" c="dimmed">
            {model.mode === "notes" ? "Hours made from the day's notes." : "Hours from the day's timers."}
          </Text>
        </Stack>
        <Text fw={600} style={{ whiteSpace: "nowrap" }}>
          {formatDurationHuman(total)}
        </Text>
      </Group>

      {model.entries.length === 0 ? (
        <Text c="dimmed">
          {model.partial
            ? "Time saved for this day isn't on this device."
            : "Nothing recorded for this day yet."}
        </Text>
      ) : (
        model.entries.map((e) => (
          <EntryRow key={e.id} entry={e} now={now} onEdit={() => setEditing(e)} duplicated={duplicates.some((g) => g.includes(e))} />
        ))
      )}

      {duplicates.map((group) => (
        <CombineLines key={group[0]!.id} lines={group} />
      ))}

      <Group>
        <Button variant="light" onClick={() => setAdding(true)}>
          Add time manually
        </Button>
      </Group>

      <EntryEditor
        entry={editing}
        opened={editing != null || adding}
        onClose={() => {
          setEditing(null);
          setAdding(false);
        }}
        defaultDate={model.workDate}
      />
    </Stack>
  );
}

/**
 * A job's lines on the day, where it has more than one — only possible for
 * days from before one line per job per day. First in the order the server
 * picks its line by.
 */
function duplicateLines(entries: readonly EntryView[]): EntryView[][] {
  const byJob = new Map<string, EntryView[]>();
  for (const e of entries) {
    if (!e.jobId) continue;
    byJob.set(e.jobId, [...(byJob.get(e.jobId) ?? []), e]);
  }
  return [...byJob.values()]
    .filter((g) => g.length > 1)
    .map((g) => [...g].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}

/**
 * Hours for one job and day go on one line. Days from before that rule may
 * have several; they're shown here for the person to fold together — their
 * choice, one tap, not done behind their back.
 */
function CombineLines({ lines }: { lines: EntryView[] }) {
  const { dispatch, pending } = useTracker();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = lines[0]!;
  const running = lines.some((e) => e.status === "open");
  const locked = lines.find((e) => !isEditable(e.status));
  const blocked = running
    ? "Stop the timer first."
    : locked
      ? isOwnerReopenable(locked.status, locked.adminApproved)
        ? "Some of them are submitted: take the day back first."
        : "Some of them are approved: an admin can reopen them."
      : null;

  async function combine() {
    setBusy(true);
    setError(null);
    const result = await dispatch(
      "entry.combine",
      { intoEntryId: first.id, entryIds: lines.slice(1).map((e) => e.id) },
      { quiet: true },
    );
    setBusy(false);
    if (!result.ok) setError(result.error);
  }

  return (
    <Alert color="yellow" title={`${jobLabel(first.jobName)} has ${lines.length} lines on this day`}>
      <Stack gap="xs">
        <Text size="sm">
          Hours for one job and day go on one line now; these were made before that. Combining adds them up and joins
          their notes. It can't be undone.
        </Text>
        <Group gap="xs">
          <Button size="sm" variant="light" color="yellow" onClick={() => void combine()} loading={busy} disabled={!!blocked || pending}>
            Combine into one line
          </Button>
          {blocked && (
            <Text size="sm" c="dimmed">
              {blocked}
            </Text>
          )}
        </Group>
        {error && (
          <Text size="sm" c="red" role="alert">
            {error}
          </Text>
        )}
      </Stack>
    </Alert>
  );
}

function EntryRow({
  entry,
  now,
  onEdit,
  duplicated,
}: {
  entry: EntryView;
  now: number | undefined;
  onEdit: () => void;
  /** Another line on the same job and day (from before one line per job). */
  duplicated: boolean;
}) {
  const { model, dispatch, pending } = useTracker();
  const { landed } = useFlight();
  const undoToast = useUndoToast();
  const tz = model.timezone;
  const running = entry.status === "open";
  const locked = !isEditable(entry.status);
  // Signed off, but QuickBooks already has time for this job that day: waiting on the person (HeldEntries).
  const held = locked && entry.heldBy != null && entry.heldBy.length > 0;
  const seconds = now === undefined ? entry.durationSeconds : liveSeconds(entry, now);

  const untimed = entry.untimedSeconds ?? 0;
  const times =
    entry.startedAt == null
      ? null
      : running
        ? `${formatClock(entry.startedAt, tz)} – now`
        : `${formatClock(entry.startedAt, tz)} – ${entry.endedAt != null ? formatClock(entry.endedAt, tz) : "?"}`;
  // A line can hold timed time and time with no start and end (typed in, or
  // notes turned into hours) together.
  const span = times == null ? "Duration only" : untimed > 0 ? `${times}, plus ${formatDurationHuman(untimed)} without times` : times;

  async function remove() {
    const result = await dispatch("entry.delete", { entryId: entry.id, at: Date.now() });
    if (result.ok) {
      undoToast(`Deleted ${jobLabel(entry.jobName)}.`);
    }
  }

  /** A tap on the note's words edits; one on its "Show all" only shows. */
  function editFromNote(e: MouseEvent) {
    if (!(e.target as Element).closest("button")) onEdit();
  }

  // The job's own name is the line to read; where it sits goes under it.
  const { name: jobTitle, above: jobPlace } = jobPath(entry.jobName);
  const heading = (
    <Stack gap={2}>
      <Group gap="xs" wrap="wrap">
        <Text fw={500}>{jobTitle}</Text>
        {running && (
          <Badge size="sm" color={entry.runningSince != null ? "green" : "yellow"} variant="light">
            {entry.runningSince != null ? "running" : "paused"}
          </Badge>
        )}
        {entry.source === "note_rollup" && (
          <Badge size="sm" variant="light" color="gray">
            from notes
          </Badge>
        )}
        {locked && !held && (
          <Badge size="sm" variant="light" color="teal">
            {entry.status === "synced" ? "in accounting" : entry.status === "submitted" ? "submitted" : "approved"}
          </Badge>
        )}
        {held && (
          <Badge size="sm" variant="light" color="orange">
            already in QuickBooks
          </Badge>
        )}
        {duplicated && (
          <Badge size="sm" variant="light" color="yellow">
            another line for this job
          </Badge>
        )}
      </Group>
      {jobPlace && (
        <Text size="xs" c="dimmed">
          {jobPlace}
        </Text>
      )}
      <Text size="sm" c="dimmed">
        {span}
      </Text>
    </Stack>
  );

  return (
    // `data-entry-id` is how a flight finds the row it is flying to.
    <Card
      withBorder
      padding="sm"
      data-entry-id={entry.id}
      className={[appear.appear, landingClass(landed, entry.id)].filter(Boolean).join(" ")}
    >
      <Stack gap={2}>
        <Group justify="space-between" wrap="nowrap" align="start" gap="sm">
          {locked ? (
            <div style={{ flex: 1, minWidth: 0 }}>{heading}</div>
          ) : (
            <UnstyledButton onClick={onEdit} style={{ flex: 1, minWidth: 0 }} aria-label={`Edit ${jobLabel(entry.jobName)}`}>
              {heading}
            </UnstyledButton>
          )}
          <Stack gap={4} align="end">
            <Text fw={600} style={{ fontVariantNumeric: "tabular-nums" }}>
              {formatDurationHuman(seconds)}
            </Text>
            {!locked && (
              <Button size="compact-xs" variant="subtle" color="red" onClick={() => void remove()} disabled={pending}>
                Delete
              </Button>
            )}
          </Stack>
        </Group>
        {/* The note sits outside the edit button so it can carry its own "Show
            all" (a button can't hold a button), and so submitted time, which
            can't be opened, can still be read in full. It takes the card's
            whole width. A tap on its words still edits an open entry, as it
            did when they were inside the button; the keyboard has the button. */}
        {entry.note && (
          <div onClick={locked ? undefined : editFromNote} style={locked ? undefined : { cursor: "pointer" }}>
            <ClampedText size="sm" lines={2}>
              {entry.note}
            </ClampedText>
          </div>
        )}
        {held ? (
          <Text size="xs" c="orange">
            QuickBooks already has time for this —{" "}
            <Anchor href="#held" size="xs" c="orange" underline="always">
              compare and choose
            </Anchor>{" "}
            below.
          </Text>
        ) : (
          locked && (
            <Text size="xs" c="dimmed">
              {isOwnerReopenable(entry.status, entry.adminApproved)
                ? "Locked — take the day back to change it."
                : "Locked — an admin can reopen it for changes."}
            </Text>
          )
        )}
      </Stack>
    </Card>
  );
}
