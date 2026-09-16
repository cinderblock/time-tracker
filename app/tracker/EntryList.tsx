import { Badge, Button, Card, Group, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { useState } from "react";

import { formatClock, formatDurationHuman } from "../../src/time.ts";
import { useNow, useTracker, useUndoToast } from "./context.tsx";
import { EntryEditor } from "./EntryEditor.tsx";
import { type EntryView, liveSeconds } from "./model.ts";

/** The day's entries. Tap one to edit; delete right from the row, with undo. */
export function EntryList() {
  const { model } = useTracker();
  const now = useNow(30_000);
  const [editing, setEditing] = useState<EntryView | null>(null);
  const [adding, setAdding] = useState(false);
  const total = model.entries.reduce((sum, e) => sum + (now === undefined ? e.durationSeconds : liveSeconds(e, now)), 0);

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="baseline">
        <Title order={3}>Time</Title>
        <Text fw={600}>{formatDurationHuman(total)}</Text>
      </Group>

      {model.entries.length === 0 ? (
        <Text c="dimmed">
          {model.partial
            ? "Time saved for this day isn't on this device."
            : "Nothing recorded for this day yet."}
        </Text>
      ) : (
        model.entries.map((e) => <EntryRow key={e.id} entry={e} now={now} onEdit={() => setEditing(e)} />)
      )}

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

function EntryRow({ entry, now, onEdit }: { entry: EntryView; now: number | undefined; onEdit: () => void }) {
  const { model, dispatch, pending } = useTracker();
  const undoToast = useUndoToast();
  const tz = model.timezone;
  const running = entry.status === "open";
  const seconds = now === undefined ? entry.durationSeconds : liveSeconds(entry, now);

  const span =
    entry.startedAt == null
      ? "Duration only"
      : running
        ? `${formatClock(entry.startedAt, tz)} – now`
        : `${formatClock(entry.startedAt, tz)} – ${entry.endedAt != null ? formatClock(entry.endedAt, tz) : "?"}`;

  async function remove() {
    const result = await dispatch("entry.delete", { entryId: entry.id, at: Date.now() });
    if (result.ok) {
      undoToast(`Deleted ${entry.jobName}.`, () => dispatch("entry.restore", { entryId: entry.id, at: Date.now() }));
    }
  }

  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" wrap="nowrap" align="start" gap="sm">
        <UnstyledButton onClick={onEdit} style={{ flex: 1, minWidth: 0 }} aria-label={`Edit ${entry.jobName}`}>
          <Stack gap={2}>
            <Group gap="xs" wrap="wrap">
              <Text fw={500}>{entry.jobName}</Text>
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
            </Group>
            <Text size="sm" c="dimmed">
              {span}
            </Text>
            {entry.note && (
              <Text size="sm" lineClamp={2}>
                {entry.note}
              </Text>
            )}
          </Stack>
        </UnstyledButton>
        <Stack gap={4} align="end">
          <Text fw={600} style={{ fontVariantNumeric: "tabular-nums" }}>
            {formatDurationHuman(seconds)}
          </Text>
          <Button size="compact-xs" variant="subtle" color="red" onClick={() => void remove()} disabled={pending}>
            Delete
          </Button>
        </Stack>
      </Group>
    </Card>
  );
}
