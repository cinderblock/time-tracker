import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { TimeInput } from "@mantine/dates";
import { useMediaQuery } from "@mantine/hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

import { jobLabel, jobPath } from "../../src/job-names.ts";
import { NOTE_MAX_LENGTH } from "../../src/limits.ts";
import { joinNotes, proposeRollup, rollupProblems } from "../../src/rollup.ts";
import {
  addDays,
  formatClock,
  formatDurationHuman,
  formatDurationInput,
  formatWorkDate,
  parseDuration,
  zonedTimeInput,
  zonedTimeToInstant,
} from "../../src/time.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { DurationInput } from "../components/duration-input.tsx";
import { useTracker, useUndoToast } from "./context.tsx";
import { useFlight, whereItIs } from "./flight.tsx";
import { JobSelect, RecentJobButtons } from "./JobPicker.tsx";
import type { NoteView } from "./model.ts";
import appear from "../components/appear.module.css";
import classes from "./notes.module.css";

/**
 * Notes mode, by job. Adding a job to the day marks being on it from that
 * moment; notes then go under that job as the work happens. At the end of
 * the day each job's notes are turned into hours — one entry per job, its
 * notes as the description — and a day's notes must all be hours before the
 * next day can start.
 *
 * In timer mode the panel only shows a day's leftover notes (from before a
 * switch), so they can still be turned into hours.
 */
export function NotesPanel() {
  const { model, hrefFor } = useTracker();
  const isToday = model.workDate === model.today;
  const notesMode = model.mode === "notes";
  // An earlier day's notes come first; until they're hours, today takes none.
  const heldBy = notesMode && isToday ? (model.notesToRollUp ?? null) : null;
  const canAdd = notesMode && isToday && !heldBy;
  const sections = useMemo(() => groupByJob(model.notes), [model.notes]);
  // The section whose note box should take the cursor next.
  const [focusJob, setFocusJob] = useState<string | null>(null);
  const clearFocus = useCallback(() => setFocusJob(null), []);

  if (!notesMode && model.notes.length === 0) return null;

  return (
    <Stack gap="sm">
      <Title order={3}>Notes</Title>
      {heldBy && (
        <Alert color="yellow" title={`${formatWorkDate(heldBy.date)} isn't finished`}>
          <Stack gap="xs">
            <Text size="sm">
              Turn {heldBy.count === 1 ? "its note" : `its ${heldBy.count} notes`} into hours before today's notes
              start.
            </Text>
            <Group>
              <Button component={Link} to={hrefFor(heldBy.date)} size="sm">
                Go to {formatWorkDate(heldBy.date)}
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
      {canAdd && <AddJob sections={sections} onAdded={setFocusJob} />}
      {sections.length === 0
        ? !heldBy && (
            <Text c="dimmed" size="sm">
              {model.partial
                ? "Notes for this day aren't on this device."
                : canAdd
                  ? "Add the job you're on, then jot what you do as you go. At the end of the day, turn each job's notes into hours."
                  : "No notes on this day."}
            </Text>
          )
        : sections.map((s) => (
            <JobSection
              key={s.key}
              section={s}
              canAdd={canAdd}
              focused={focusJob != null && focusJob === s.jobId}
              onFocused={clearFocus}
            />
          ))}
    </Stack>
  );
}

interface Section {
  key: string;
  jobId: string | null;
  jobName: string | null;
  /** In time order; the first is usually the start marker. */
  notes: NoteView[];
  startedAt: number;
  pending: NoteView[];
}

/** The day's notes by job, sections in the order the jobs were started. */
function groupByJob(notes: readonly NoteView[]): Section[] {
  const byJob = new Map<string | null, NoteView[]>();
  for (const n of notes) {
    const list = byJob.get(n.jobId) ?? [];
    list.push(n);
    byJob.set(n.jobId, list);
  }
  return [...byJob.entries()]
    .map(([jobId, list]) => ({
      key: jobId ?? "none",
      jobId,
      jobName: list[0]!.jobName,
      notes: list,
      startedAt: list[0]!.at,
      pending: list.filter((n) => !n.rolledIntoEntryId),
    }))
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** Pick a job to be on from now. One already on the day just takes the cursor. */
function AddJob({ sections, onAdded }: { sections: Section[]; onAdded: (jobId: string) => void }) {
  const { dispatch, location, pending } = useTracker();
  const [value, setValue] = useState<string | null>(null);

  async function pick(jobId: string | null) {
    setValue(null);
    if (!jobId) return;
    if (sections.some((s) => s.jobId === jobId)) {
      onAdded(jobId);
      return;
    }
    const result = await dispatch("note.create", {
      noteId: uuidv7(),
      at: Date.now(),
      kind: "start",
      jobId,
      location: location(),
    });
    if (result.ok) onAdded(jobId);
  }

  // The buttons are the fast way onto a job you've been on lately — the same
  // one tap that starts a timer. One already on the day is still worth a
  // button: tapping it is how you say you're back on it.
  return (
    <Stack gap="xs">
      <RecentJobButtons onPick={(job) => void pick(job.id)} disabled={pending} />
      <JobSelect value={value} onChange={(id) => void pick(id)} placeholder="Add a job for today — type to search" />
    </Stack>
  );
}

function JobSection({
  section,
  canAdd,
  focused,
  onFocused,
}: {
  section: Section;
  canAdd: boolean;
  focused: boolean;
  onFocused: () => void;
}) {
  const { model } = useTracker();
  const [hours, setHours] = useState(false);
  // Where this job's hours fly from when its notes become time.
  const card = useRef<HTMLDivElement>(null);
  const name = section.jobId ? (section.jobName ?? "Unknown job") : null;
  const { name: title, above: place } = jobPath(name ?? "");
  const written = section.pending.filter((n) => n.kind === "note").length;

  return (
    <Card
      ref={card}
      withBorder
      padding="sm"
      role="group"
      aria-label={name ? jobLabel(name) : "No job yet"}
      className={appear.appear}
    >
      <Stack gap="xs">
        <Group justify="space-between" align="start" wrap="nowrap">
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text fw={600}>{name ? title : "No job yet"}</Text>
            {place && (
              <Text size="xs" c="dimmed">
                {place}
              </Text>
            )}
          </Stack>
          <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
            since {formatClock(section.startedAt, model.timezone)}
          </Text>
        </Group>

        {section.notes.map((n) => (
          <NoteRow key={n.id} note={n} />
        ))}

        {section.jobId ? (
          canAdd && <NoteBox jobId={section.jobId} jobName={name!} autoFocus={focused} onFocused={onFocused} />
        ) : (
          <Text size="sm" c="dimmed">
            Give these notes a job (edit each one) to turn them into hours.
          </Text>
        )}

        {section.jobId && section.pending.length > 0 && (
          <Group>
            <Button size="sm" variant="light" onClick={() => setHours(true)}>
              {written > 0 ? `Turn ${written} note${written === 1 ? "" : "s"} into hours` : "Turn into hours"}
            </Button>
          </Group>
        )}
        {section.jobId && (
          <HoursDialog
            opened={hours}
            onClose={() => setHours(false)}
            jobId={section.jobId}
            jobName={name!}
            pending={section.pending}
            from={card}
          />
        )}
      </Stack>
    </Card>
  );
}

/** A note for one job, written as the work happens. */
function NoteBox({
  jobId,
  jobName,
  autoFocus,
  onFocused,
}: {
  jobId: string;
  jobName: string;
  autoFocus: boolean;
  onFocused: () => void;
}) {
  const { dispatch, location } = useTracker();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    ref.current?.focus();
    onFocused();
  }, [autoFocus, onFocused]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const written = text.trim();
    if (!written) return;
    // Empty the field now rather than when the dispatch answers. The note is
    // already in the list by then — the outbox takes it whether or not there
    // is a connection — and someone jotting a day's work types the next one
    // straight away. Clearing late wipes what they typed in between, and
    // leaves Add disabled over a field with words still in it.
    setText("");
    setBusy(true);
    const result = await dispatch("note.create", {
      noteId: uuidv7(),
      at: Date.now(),
      text: written,
      jobId,
      location: location(),
    });
    setBusy(false);
    // Hand it back if it was refused — but not over a note begun since, which
    // would be the same mistake pointing the other way.
    if (!result.ok) setText((current) => (current === "" ? written : current));
  }

  return (
    <form onSubmit={add}>
      <Group gap="xs" align="end" wrap="nowrap">
        <TextInput
          ref={ref}
          placeholder="What did you do?"
          aria-label={`Note for ${jobLabel(jobName)}`}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          maxLength={NOTE_MAX_LENGTH}
          style={{ flex: 1 }}
        />
        <Button type="submit" loading={busy} disabled={!text.trim()}>
          Add
        </Button>
      </Group>
    </form>
  );
}

/**
 * One line of the day. A note that hasn't become hours yet opens for editing
 * from anywhere on its row — the whole row is the tap target, as an entry's
 * is — with a pencil to say so: drawn on a touch device, where there is no
 * other clue, and faded in on hover where there's a mouse. The start marker
 * can only be removed, and a rolled-up note is just a record.
 */
function NoteRow({ note }: { note: NoteView }) {
  const { model, dispatch, pending } = useTracker();
  const undoToast = useUndoToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const [jobId, setJobId] = useState(note.jobId);
  const rolled = note.rolledIntoEntryId != null;
  const start = note.kind === "start";

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
    if (result.ok) {
      undoToast(start ? "Start removed." : "Note deleted.", () =>
        dispatch("note.restore", { noteId: note.id, at: Date.now() }),
      );
    }
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
          <JobSelect value={jobId} onChange={setJobId} placeholder="Job" required />
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

  const when = (
    <Text size="sm" c="dimmed" style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
      {formatClock(note.at, model.timezone)}
    </Text>
  );
  // `overflowWrap` so one long unbroken word shrinks with the row rather than
  // pushing the action off the end of it.
  const what = (
    <Text
      size="sm"
      c={start ? "dimmed" : undefined}
      fs={start ? "italic" : undefined}
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      {start ? "Started" : note.text}
    </Text>
  );

  return (
    <Group
      className={`${classes.row} ${appear.appear}`}
      justify="space-between"
      wrap="nowrap"
      align="start"
      opacity={rolled ? 0.6 : 1}
    >
      {start || rolled ? (
        <Group gap="xs" wrap="nowrap" align="start" style={{ minWidth: 0 }}>
          {when}
          {what}
          {rolled && (
            <Badge size="sm" variant="light" color="gray">
              added to time
            </Badge>
          )}
        </Group>
      ) : (
        <UnstyledButton
          className={classes.opener}
          onClick={() => setEditing(true)}
          aria-label={`Edit ${note.text}`}
          style={{ flex: 1, minWidth: 0 }}
        >
          <Group gap="xs" wrap="nowrap" align="start">
            {when}
            {what}
            <PencilIcon />
          </Group>
        </UnstyledButton>
      )}
      {!rolled && start && (
        <Button
          className={classes.action}
          size="compact-xs"
          variant="subtle"
          color="gray"
          onClick={() => void remove()}
          disabled={pending}
        >
          Remove
        </Button>
      )}
    </Group>
  );
}

/**
 * The hint that a note opens for editing, drawn here rather than taking on an
 * icon set for one glyph. Decorative: the row around it carries the label.
 */
function PencilIcon() {
  return (
    <svg
      className={classes.pencil}
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 21l1-4L16 5l3 3L7 20l-4 1z" />
      <path d="M14 7l3 3" />
    </svg>
  );
}

/**
 * Turn one job's pending notes into hours: the timeline over the whole day
 * suggests them (this job's runs, each until the next note of another job),
 * the person confirms or changes them, and one duration entry is made with
 * the notes as its description.
 */
function HoursDialog({
  opened,
  onClose,
  jobId,
  jobName,
  pending,
  from,
}: {
  opened: boolean;
  onClose: () => void;
  jobId: string;
  jobName: string;
  pending: NoteView[];
  /** The job's card: where its hours are seen to leave from. */
  from: React.RefObject<HTMLDivElement | null>;
}) {
  const { model, dispatch } = useTracker();
  const { flyToEntry } = useFlight();
  const narrow = useMediaQuery("(max-width: 36em)");
  const tz = model.timezone;
  const date = model.workDate;
  const isToday = date === model.today;
  const { name: title } = jobPath(jobName);
  const [endTime, setEndTime] = useState("");
  const [duration, setDuration] = useState("");
  const [touched, setTouched] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // This job runs to the end of the day when the day's last note is one of its pending ones.
  const lastNote = model.notes.at(-1);
  const runsToEnd = lastNote != null && lastNote.jobId === jobId && lastNote.rolledIntoEntryId == null;
  const lastAt = model.notes.length ? Math.max(...model.notes.map((n) => n.at)) : 0;

  // Fresh each time it opens — and only then. Read through refs: the model is
  // rebuilt on every data refresh, which must not wipe what's been typed.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => {
    if (!opened) return;
    const suggestedEnd = isToday ? Math.max(Date.now(), lastAt) : lastAt + 3600_000;
    const roundedEnd = Math.ceil(suggestedEnd / 300_000) * 300_000;
    setEndTime(zonedTimeInput(roundedEnd, tz));
    setNote(joinNotes(pendingRef.current.map((n) => n.text)));
    setTouched(false);
    setError(null);
    setBusy(false);
  }, [opened, isToday, tz, lastAt]);

  // The end of the day, from the field (a time before the last note means after midnight).
  const endAt = useMemo(() => {
    if (!endTime) return lastAt;
    const at = zonedTimeToInstant(date, endTime, tz);
    return at <= lastAt ? zonedTimeToInstant(addDays(date, 1), endTime, tz) : at;
  }, [endTime, date, tz, lastAt]);

  // This job's runs, over the whole day's notes; only their pending part counts.
  const spans = useMemo(() => {
    const pendingIds = new Set(pending.map((n) => n.id));
    const byId = new Map(model.notes.map((n) => [n.id, n]));
    const out: { startedAt: number; endedAt: number }[] = [];
    for (const line of proposeRollup(model.notes, endAt)) {
      if (line.jobId !== jobId) continue;
      const mine = line.noteIds.filter((id) => pendingIds.has(id));
      if (mine.length === 0) continue;
      const startedAt = mine.length === line.noteIds.length ? line.startedAt : byId.get(mine[0]!)!.at;
      if (line.endedAt > startedAt) out.push({ startedAt, endedAt: line.endedAt });
    }
    return out;
  }, [model.notes, pending, jobId, endAt]);
  const suggested = spans.reduce((sum, s) => sum + Math.round((s.endedAt - s.startedAt) / 1000), 0);

  useEffect(() => {
    if (touched) return;
    // The notes' own seconds are noise here — nobody means "2:07:43".
    setDuration(formatDurationInput(Math.round(suggested / 60) * 60));
  }, [suggested, touched]);

  const seconds = parseDuration(duration) ?? 0;
  const problems = rollupProblems([{ jobId, durationSeconds: seconds }]);

  async function commit() {
    setBusy(true);
    setError(null);
    const entryId = uuidv7();
    const leaves = whereItIs(from.current);
    const result = await dispatch(
      "rollup.commit",
      {
        workDate: date,
        lines: [
          {
            entryId,
            jobId,
            durationSeconds: seconds,
            note: note.trim() || null,
            noteIds: pending.map((n) => n.id),
          },
        ],
      },
      { quiet: true },
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // The row is already on the other side of the screen; show it getting there.
    flyToEntry(entryId, formatDurationHuman(seconds), leaves);
    onClose();
  }

  return (
    <Modal opened={opened} onClose={onClose} title={`Hours for ${jobLabel(jobName)}`} centered fullScreen={narrow}>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          From the notes, {title} ran{" "}
          {spans.length === 0
            ? "for no time at all"
            : spans
                .map((s) => `${formatClock(s.startedAt, tz)} – ${formatClock(s.endedAt, tz)}`)
                .join(" and ")}
          {spans.length > 0 ? `: ${formatDurationHuman(suggested)}` : ""}. Change it if that's not right.
        </Text>
        {runsToEnd && (
          <TimeInput label="Worked until" value={endTime} onChange={(e) => setEndTime(e.currentTarget.value)} />
        )}
        <DurationInput
          label="Time worked"
          value={duration}
          onChange={(v) => {
            setTouched(true);
            setDuration(v);
          }}
        />
        <Textarea
          label="Note"
          description="Goes with the hours, to accounting."
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          maxLength={NOTE_MAX_LENGTH}
          autosize
          minRows={2}
          maxRows={6}
        />
        {error && (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void commit()} loading={busy} disabled={problems.length > 0}>
            Add {formatDurationHuman(seconds)} to {title}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
