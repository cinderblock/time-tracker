import {
  Alert,
  Badge,
  Button,
  Card,
  CloseButton,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { TimeInput } from "@mantine/dates";
import { useMediaQuery } from "@mantine/hooks";
import { useEffect, useMemo, useRef, useState } from "react";

import { NOTE_MAX_LENGTH } from "../../src/limits.ts";
import { type RollupLine, proposeRollup, rollupProblems } from "../../src/rollup.ts";
import { addDays, formatClock, formatDurationHuman, zonedTimeInput, zonedTimeToInstant } from "../../src/time.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { useTracker, useUndoToast } from "./context.tsx";
import { JobSelect } from "./JobPicker.tsx";
import { recentFix } from "./location.ts";
import type { NoteView } from "./model.ts";

/**
 * Sporadic notes: jot what you're doing as you go, then turn the day's notes
 * into time entries at the end of the day (or the next morning).
 */
export function NotesPanel() {
  const { model } = useTracker();
  const [reviewing, setReviewing] = useState(false);
  const pendingNotes = model.notes.filter((n) => !n.rolledIntoEntryId);
  const isToday = model.workDate === model.today;

  return (
    <Stack gap="sm">
      <Title order={3}>Notes</Title>
      {isToday && <QuickNote />}
      {model.notes.length === 0 ? (
        <Text c="dimmed" size="sm">
          {isToday
            ? "Jot what you're working on as you switch tasks. At the end of the day, turn the notes into time."
            : "No notes on this day."}
        </Text>
      ) : (
        model.notes.map((n) => <NoteRow key={n.id} note={n} />)
      )}
      {pendingNotes.length > 0 && (
        <Group>
          <Button onClick={() => setReviewing(true)}>
            Turn {pendingNotes.length} note{pendingNotes.length === 1 ? "" : "s"} into time
          </Button>
        </Group>
      )}
      <RollupReview opened={reviewing} onClose={() => setReviewing(false)} notes={pendingNotes} />
    </Stack>
  );
}

function QuickNote() {
  const { model, dispatch } = useTracker();
  const [text, setText] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Default the job to whatever the last note (or running timer) was about.
  const lastJob = model.notes.at(-1)?.jobId ?? model.open?.jobId ?? null;
  useEffect(() => setJobId((current) => current ?? lastJob), [lastJob]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    const result = await dispatch("note.create", {
      noteId: uuidv7(),
      at: Date.now(),
      text: text.trim(),
      jobId,
      location: recentFix(),
    });
    setBusy(false);
    if (result.ok) setText("");
  }

  return (
    <Card withBorder padding="sm">
      <form onSubmit={add}>
        <Stack gap="xs">
          <TextInput
            placeholder="What are you working on now?"
            aria-label="Note"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            maxLength={NOTE_MAX_LENGTH}
            size="md"
          />
          <JobSelect value={jobId} onChange={setJobId} placeholder="Job (optional)" />
          <Group justify="flex-end">
            <Button type="submit" loading={busy} disabled={!text.trim()}>
              Add note
            </Button>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}

function NoteRow({ note }: { note: NoteView }) {
  const { model, dispatch, pending } = useTracker();
  const undoToast = useUndoToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const [jobId, setJobId] = useState(note.jobId);
  const rolled = note.rolledIntoEntryId != null;

  async function save() {
    const result = await dispatch("note.update", {
      noteId: note.id,
      text: text.trim() !== note.text ? text.trim() : undefined,
      jobId: jobId !== note.jobId ? jobId : undefined,
    });
    if (result.ok) setEditing(false);
  }

  async function remove() {
    const result = await dispatch("note.delete", { noteId: note.id, at: Date.now() });
    if (result.ok) undoToast("Note deleted.", () => dispatch("note.restore", { noteId: note.id, at: Date.now() }));
  }

  if (editing) {
    return (
      <Card withBorder padding="sm">
        <Stack gap="xs">
          <Textarea
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            maxLength={NOTE_MAX_LENGTH}
            autosize
            aria-label="Note text"
          />
          <JobSelect value={jobId} onChange={setJobId} placeholder="Job (optional)" />
          <Group justify="space-between">
            <Button variant="subtle" color="red" size="xs" onClick={() => void remove()} disabled={pending}>
              Delete
            </Button>
            <Group gap="xs">
              <Button variant="default" size="xs" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button size="xs" onClick={() => void save()} disabled={!text.trim() || pending}>
                Save
              </Button>
            </Group>
          </Group>
        </Stack>
      </Card>
    );
  }

  return (
    <Card withBorder padding="sm" opacity={rolled ? 0.6 : 1}>
      <Group justify="space-between" wrap="nowrap" align="start">
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Group gap="xs">
            <Text size="sm" c="dimmed" style={{ fontVariantNumeric: "tabular-nums" }}>
              {formatClock(note.at, model.timezone)}
            </Text>
            {note.jobName && (
              <Badge size="sm" variant="light">
                {note.jobName}
              </Badge>
            )}
            {rolled && (
              <Badge size="sm" variant="light" color="gray">
                added to time
              </Badge>
            )}
          </Group>
          <Text size="sm">{note.text}</Text>
        </Stack>
        {!rolled && (
          <Button size="compact-xs" variant="subtle" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </Group>
    </Card>
  );
}

interface DraftLine {
  key: string;
  jobId: string | null;
  start: string;
  end: string;
  note: string;
  noteIds: string[];
}

function toDraft(line: RollupLine, tz: string): DraftLine {
  return {
    key: line.key,
    jobId: line.jobId,
    start: zonedTimeInput(line.startedAt, tz),
    end: zonedTimeInput(line.endedAt, tz),
    note: line.note,
    noteIds: line.noteIds,
  };
}

/** Review the proposed lines, fix them up, and commit them as entries. */
function RollupReview({ opened, onClose, notes }: { opened: boolean; onClose: () => void; notes: NoteView[] }) {
  const { model, dispatch } = useTracker();
  const narrow = useMediaQuery("(max-width: 36em)");
  const tz = model.timezone;
  const date = model.workDate;
  const isToday = date === model.today;
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [endTime, setEndTime] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fresh proposal each time the review opens — and only then. The notes are
  // read through a ref: the list is rebuilt on every data refresh (creating a
  // job from inside this dialog causes one), which must not wipe the edits.
  // The last line ends now (today) or an hour after the last note (a past
  // day); the person confirms either.
  const notesRef = useRef(notes);
  notesRef.current = notes;
  useEffect(() => {
    const notes = notesRef.current;
    if (!opened || notes.length === 0) return;
    const lastAt = Math.max(...notes.map((n) => n.at));
    const suggestedEnd = isToday ? Math.max(Date.now(), lastAt) : lastAt + 3600_000;
    const roundedEnd = Math.ceil(suggestedEnd / 300_000) * 300_000;
    setEndTime(zonedTimeInput(roundedEnd, tz));
    setLines(proposeRollup(notes, roundedEnd).map((l) => toDraft(l, tz)));
    setError(null);
  }, [opened, isToday, tz]);

  // The end-of-day time only moves the last line's end.
  function changeEnd(value: string) {
    setEndTime(value);
    setLines((ls) => ls.map((l, i) => (i === ls.length - 1 ? { ...l, end: value } : l)));
  }

  const resolved = useMemo(
    () =>
      lines.map((l) => {
        const startedAt = l.start ? zonedTimeToInstant(date, l.start, tz) : Number.NaN;
        let endedAt = l.end ? zonedTimeToInstant(date, l.end, tz) : Number.NaN;
        if (endedAt <= startedAt) endedAt = zonedTimeToInstant(addDays(date, 1), l.end, tz); // past midnight
        return { ...l, startedAt, endedAt };
      }),
    [lines, date, tz],
  );
  const problems = lines.length === 0 ? ["There's nothing to add."] : rollupProblems(resolved);
  const total = resolved.reduce((s, l) => s + (l.endedAt > l.startedAt ? (l.endedAt - l.startedAt) / 1000 : 0), 0);

  async function commit() {
    setBusy(true);
    setError(null);
    const result = await dispatch(
      "rollup.commit",
      {
        workDate: date,
        lines: resolved.map((l) => ({
          entryId: uuidv7(),
          jobId: l.jobId!,
          startedAt: l.startedAt,
          endedAt: l.endedAt,
          note: l.note.trim() || null,
          noteIds: l.noteIds,
        })),
      },
      { quiet: true },
    );
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error);
  }

  const update = (key: string, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <Modal opened={opened} onClose={onClose} title="Turn notes into time" centered size="lg" fullScreen={narrow}>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Each note counts until the next one. Check the jobs and times, remove anything that wasn't work (like
          lunch), then add them.
        </Text>
        <TimeInput label="Last note runs until" value={endTime} onChange={(e) => changeEnd(e.currentTarget.value)} />

        {lines.map((l) => (
          <Card key={l.key} withBorder padding="sm">
            <Stack gap="xs">
              <Group justify="space-between" align="start" wrap="nowrap">
                <Text size="sm" fw={500} style={{ flex: 1 }}>
                  {l.noteIds.length} note{l.noteIds.length === 1 ? "" : "s"}
                </Text>
                <CloseButton
                  aria-label="Remove this line"
                  onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                />
              </Group>
              <JobSelect
                value={l.jobId}
                onChange={(jobId) => update(l.key, { jobId })}
                placeholder="Pick a job"
                required
                error={l.jobId ? null : "Needs a job"}
              />
              <Group grow>
                <TimeInput label="From" value={l.start} onChange={(e) => update(l.key, { start: e.currentTarget.value })} />
                <TimeInput label="To" value={l.end} onChange={(e) => update(l.key, { end: e.currentTarget.value })} />
              </Group>
              <Textarea
                label="Note"
                value={l.note}
                onChange={(e) => update(l.key, { note: e.currentTarget.value })}
                autosize
                maxLength={NOTE_MAX_LENGTH}
              />
            </Stack>
          </Card>
        ))}

        {problems.length > 0 && lines.length > 0 && (
          <Alert color="yellow">
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </Alert>
        )}
        {error && (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}

        <Group justify="space-between">
          <Text fw={600}>Total {formatDurationHuman(total)}</Text>
          <Group gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void commit()} loading={busy} disabled={problems.length > 0}>
              Add {lines.length} entr{lines.length === 1 ? "y" : "ies"}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

