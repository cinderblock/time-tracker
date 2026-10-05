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
import { Link, useFetcher } from "react-router";

import { jobLabel, jobPath } from "../../src/job-names.ts";
import { NOTE_MAX_LENGTH } from "../../src/limits.ts";
import { joinNotes, proposeRollup, rollupProblems } from "../../src/rollup.ts";
import {
  formatClock,
  formatDurationHuman,
  formatDurationInput,
  formatWorkDate,
  parseDuration,
  zonedTimeInput,
} from "../../src/time.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { isEditable, isOwnerReopenable } from "../../src/entry-status.ts";
import { DurationInput } from "../components/duration-input.tsx";
import { lineOf } from "../offline/reducer.ts";
import { useTracker, useUndoToast } from "./context.tsx";
import { useFlight, whereItIs } from "./flight.tsx";
import { JobSelect, RecentJobButtons } from "./JobPicker.tsx";
import { type NoteView, isPendingNote } from "./model.ts";
import { latestTimeOn, noteTimeOn } from "./note-time.ts";
import { useTrackerDraft } from "./tracker-draft.ts";
import appear from "../components/appear.module.css";
import classes from "./notes.module.css";

/**
 * Notes mode, by job. Adding a job to the day marks being on it from that
 * moment; notes then go under that job as the work happens. At the end of
 * the day each job's notes are turned into hours — one entry per job, its
 * notes as the description. A past day can be written up afterwards the same
 * way, each note saying when. By default a day's notes must all be hours
 * before the next day can start; a person can turn that hold off (it's offered
 * in the alert itself), and then an unfinished day is still called out, but
 * doesn't block.
 *
 * In timer mode the panel only shows a day's leftover notes (from before a
 * switch), so they can still be turned into hours.
 */
export function NotesPanel() {
  const { model, hrefFor, actingFor } = useTracker();
  const isToday = model.workDate === model.today;
  const notesMode = model.mode === "notes";
  // Today, or a day gone by being written up; never a day still to come.
  const writable = notesMode && model.workDate <= model.today;
  // An earlier day's notes come first. With the hold on, this day takes none
  // until they're hours; with it off, it's called out but doesn't wait.
  const unfinished = writable ? (model.notesToRollUp ?? null) : null;
  const heldBy = unfinished && model.notesHold ? unfinished : null;
  const canAdd = writable && !heldBy;
  const thisDay = isToday ? "today" : formatWorkDate(model.workDate);
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
              Turn {heldBy.count === 1 ? "its note" : `its ${heldBy.count} notes`} into hours before{" "}
              {isToday ? "today's notes" : `notes on ${thisDay}`} start.
            </Text>
            <Group>
              <Button component={Link} to={hrefFor(heldBy.date)} size="sm">
                Go to {formatWorkDate(heldBy.date)}
              </Button>
              {/* The setting is the person's own; an admin acting for them can't change it here. */}
              {!actingFor && <StartAnyway label={isToday ? "Start today anyway" : "Start this day anyway"} />}
            </Group>
          </Stack>
        </Alert>
      )}
      {/* Not holding anything back doesn't make it less unfinished: still the
          warning, just without the wall. */}
      {unfinished && !heldBy && (
        <Alert color="yellow" title={`${formatWorkDate(unfinished.date)} isn't finished`}>
          <Stack gap="xs">
            <Text size="sm">
              It still has {unfinished.count === 1 ? "a note" : `${unfinished.count} notes`} to turn into hours.{" "}
              {isToday ? "Today's notes" : "This day's notes"} don't have to wait for it.
            </Text>
            <Group>
              <Button component={Link} to={hrefFor(unfinished.date)} size="sm">
                Go to {formatWorkDate(unfinished.date)}
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
                  ? isToday
                    ? "Add the job you're on, then jot what you do as you go. At the end of the day, turn each job's notes into hours."
                    : "Write this day up: add each job you were on and when you started it, then what you did and when. Then turn each job's notes into hours."
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

/**
 * Turn the hold off from where it bites: today starts now, and from here on an
 * unfinished day is a reminder rather than a wall. The Account page has the
 * same switch, to turn it back on.
 */
function StartAnyway({ label }: { label: string }) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const busy = fetcher.state !== "idle";
  return (
    <Stack gap={2} align="flex-start">
      <Button
        size="sm"
        variant="default"
        loading={busy}
        onClick={() => fetcher.submit({ intent: "notes-hold", hold: "0" }, { method: "post", action: "/account" })}
      >
        {label}
      </Button>
      <Text size="xs" c="dimmed">
        From now on, an unfinished day won't hold the next one. Change it back under Your account.
      </Text>
      {fetcher.data && !fetcher.data.ok && (
        <Text size="xs" c="red" role="alert">
          {fetcher.data.error ?? "That didn't save. Try again when you're online."}
        </Text>
      )}
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
      pending: list.filter(isPendingNote),
    }))
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Pick a job to be on from now — or, writing up an earlier day, from the time
 * given. One already on the day just takes the cursor.
 */
function AddJob({ sections, onAdded }: { sections: Section[]; onAdded: (jobId: string) => void }) {
  const { model, dispatch, location, pending } = useTracker();
  const isToday = model.workDate === model.today;
  const [value, setValue] = useState<string | null>(null);
  // Untouched, the time follows the latest one written on the day.
  const [time, setTime] = useTrackerDraft<string | null>(isToday ? null : `add-job-at:${model.workDate}`, null);
  const shownTime = time ?? latestTimeOn(model.notes, model.timezone);
  const [problem, setProblem] = useState<string | null>(null);

  async function pick(jobId: string | null) {
    setValue(null);
    if (!jobId) return;
    if (sections.some((s) => s.jobId === jobId)) {
      onAdded(jobId);
      return;
    }
    let at = Date.now();
    if (!isToday) {
      const when = noteTimeOn(model.workDate, shownTime, model.timezone, at);
      if (!when.ok) {
        setProblem(when.problem);
        return;
      }
      at = when.at;
    }
    setProblem(null);
    const result = await dispatch("note.create", {
      noteId: uuidv7(),
      at,
      kind: "start",
      jobId,
      // Where the device is now says nothing about where an earlier day was.
      location: isToday ? location() : null,
    });
    if (result.ok) {
      setTime(null);
      onAdded(jobId);
    }
  }

  // The buttons are the fast way onto a job you've been on lately — the same
  // one tap that starts a timer. One already on the day is still worth a
  // button: tapping it is how you say you're back on it.
  return (
    <Stack gap="xs">
      {!isToday && (
        <TimeInput
          label="Started at"
          description="When you got onto the job you pick below"
          value={shownTime}
          onChange={(e) => {
            setTime(e.currentTarget.value);
            setProblem(null);
          }}
          error={problem}
          data-draft
          maw={320}
        />
      )}
      <RecentJobButtons onPick={(job) => void pick(job.id)} disabled={pending} />
      <JobSelect
        value={value}
        onChange={(id) => void pick(id)}
        placeholder={isToday ? "Add a job for today — type to search" : "Add a job you were on — type to search"}
      />
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
  // Open or not survives a reload, with what was typed in it (HoursDialog).
  const [hours, setHours] = useTrackerDraft(section.jobId ? `hours-open:${model.workDate}:${section.jobId}` : null, false);
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
          canAdd && <NoteBox
              jobId={section.jobId}
              jobName={name!}
              notes={section.notes}
              autoFocus={focused}
              onFocused={onFocused}
            />
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

/**
 * A note for one job, written as the work happens — or, writing up an earlier
 * day, with the time it happened.
 */
function NoteBox({
  jobId,
  jobName,
  notes,
  autoFocus,
  onFocused,
}: {
  jobId: string;
  jobName: string;
  /** The job's notes so far, in time order. */
  notes: readonly NoteView[];
  autoFocus: boolean;
  onFocused: () => void;
}) {
  const { model, dispatch, location } = useTracker();
  const isToday = model.workDate === model.today;
  // Kept on the device as it's typed: an update or a crash puts it back.
  const [text, setText] = useTrackerDraft(`note-box:${model.workDate}:${jobId}`, "");
  // Writing up an earlier day, each note says when. Untouched, the time follows
  // this job's latest note — not the day's: a note after another job's start
  // would mean being back on this one, and reshape both jobs' hours.
  const [time, setTime] = useTrackerDraft<string | null>(isToday ? null : `note-box-at:${model.workDate}:${jobId}`, null);
  const shownTime = time ?? latestTimeOn(notes, model.timezone);
  const [problem, setProblem] = useState<string | null>(null);
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
    let at = Date.now();
    if (!isToday) {
      const when = noteTimeOn(model.workDate, shownTime, model.timezone, at);
      if (!when.ok) {
        setProblem(when.problem);
        return;
      }
      at = when.at;
    }
    setProblem(null);
    // Empty the field now rather than when the dispatch answers. The note is
    // already in the list by then — the outbox takes it whether or not there
    // is a connection — and someone jotting a day's work types the next one
    // straight away. Clearing late wipes what they typed in between, and
    // leaves Add disabled over a field with words still in it.
    setText("");
    setBusy(true);
    const result = await dispatch("note.create", {
      noteId: uuidv7(),
      at,
      text: written,
      jobId,
      // Where the device is now says nothing about where an earlier day was.
      location: isToday ? location() : null,
    });
    setBusy(false);
    // Hand it back if it was refused — but not over a note begun since, which
    // would be the same mistake pointing the other way.
    if (!result.ok) setText((current) => (current === "" ? written : current));
    // The time typed stays for the next note: writing a day up, the next one
    // is usually a little later, and that's the person's to say.
  }

  return (
    <form onSubmit={add}>
      <Group gap="xs" align="start" wrap="nowrap">
        {!isToday && (
          <TimeInput
            aria-label={`Time of the note for ${jobLabel(jobName)}`}
            value={shownTime}
            onChange={(e) => {
              setTime(e.currentTarget.value);
              setProblem(null);
            }}
            error={problem}
            data-draft
            w={130}
          />
        )}
        <TextInput
          ref={ref}
          placeholder="What did you do?"
          aria-label={`Note for ${jobLabel(jobName)}`}
          data-draft
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
  // Part of an entry, or settled by the accounting system's record: a record either way.
  const rolled = !isPendingNote(note);
  // An edit under way is kept on the device — open, with what's been typed —
  // so an update or a crash brings it back as it was.
  const [edit, setEdit, discardEdit] = useTrackerDraft<{ text: string; jobId: string | null; time?: string } | null>(
    rolled ? null : `note-edit:${note.id}`,
    null,
  );
  const editing = edit != null;
  const noteTime = zonedTimeInput(note.at, model.timezone);
  const text = edit ? edit.text : note.text;
  const jobId = edit ? edit.jobId : note.jobId;
  const time = edit?.time ?? noteTime;
  const setEditing = (open: boolean) => (open ? setEdit({ text: note.text, jobId: note.jobId }) : discardEdit());
  const setText = (value: string) => setEdit((e) => ({ ...e, text: value, jobId: e ? e.jobId : note.jobId }));
  const setJobId = (value: string | null) => setEdit((e) => ({ ...e, text: e ? e.text : note.text, jobId: value }));
  const setTime = (value: string) =>
    setEdit((e) => ({ text: e ? e.text : note.text, jobId: e ? e.jobId : note.jobId, time: value }));
  const start = note.kind === "start";
  // Untouched, the time stays to the second; typed, it's that minute on the
  // note's own day, and not later than now.
  const retimed = time === noteTime ? null : noteTimeOn(model.workDate, time, model.timezone, Date.now());

  async function save() {
    if (retimed && !retimed.ok) return;
    const result = await dispatch("note.update", {
      noteId: note.id,
      text: text.trim() !== note.text ? text.trim() : undefined,
      jobId: jobId !== note.jobId ? jobId : undefined,
      at: retimed?.ok ? retimed.at : undefined,
    });
    if (result.ok) setEditing(false);
  }

  async function remove() {
    const result = await dispatch("note.delete", { noteId: note.id, at: Date.now() });
    if (result.ok) {
      undoToast(start ? "Start removed." : "Note deleted.");
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
            data-draft
          />
          <Group gap="xs" align="start" wrap="nowrap">
            <TimeInput
              aria-label="Time of the note"
              value={time}
              onChange={(e) => setTime(e.currentTarget.value)}
              error={retimed && !retimed.ok ? retimed.problem : null}
              data-draft
              w={130}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <JobSelect value={jobId} onChange={setJobId} placeholder="Job" required />
            </div>
          </Group>
          <Group justify="space-between">
            <Button variant="subtle" color="red" size="xs" onClick={() => void remove()} disabled={pending}>
              Delete
            </Button>
            <Group gap="xs">
              <Button variant="default" size="xs" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="xs"
                onClick={() => void save()}
                disabled={!text.trim() || (retimed != null && !retimed.ok) || pending}
              >
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
              {note.keptInAccounting ? "kept in accounting" : "added to time"}
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
 * the notes as its description. When the job already has hours that day the
 * notes join them — one line per job per day — and what's asked is the new
 * total; leaving it as it was attaches the notes to hours already counted.
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
  // When the dialog opened: where today's last run is taken to end.
  const [openedAt, setOpenedAt] = useState(0);
  // What the person typed over the suggestions, kept on the device so an
  // update or a crash brings the dialog back as it was. Untyped, each field
  // follows its suggestion.
  const [draft, setDraft, discardDraft] = useTrackerDraft<{ duration?: string; note?: string } | null>(
    `hours:${date}:${jobId}`,
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lastAt = model.notes.length ? Math.max(...model.notes.map((n) => n.at)) : 0;

  // Fresh each time it opens — and only then. Read through refs: the model is
  // rebuilt on every data refresh, which must not wipe what's been typed.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  // The job's hours already on the day, read when the suggestion is made.
  const alreadyRef = useRef(0);
  alreadyRef.current = lineOf(model, jobId, model.workDate)?.durationSeconds ?? 0;
  useEffect(() => {
    if (!opened) return;
    setOpenedAt(Date.now());
    setError(null);
    setBusy(false);
  }, [opened]);

  // Where the day's last run ends: now, today; on an earlier day, its last note
  // — the notes say no more than that, and the person corrects the total. (A
  // "worked until" field used to ask; it confused more than it helped.)
  const endAt = isToday ? Math.max(openedAt, lastAt) : lastAt;

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

  // The notes' own seconds are noise here — nobody means "2:07:43".
  const duration = draft?.duration ?? formatDurationInput(Math.round(suggested / 60) * 60 + alreadyRef.current);
  const note = draft?.note ?? joinNotes(pending.map((n) => n.text));
  /** Close, forgetting what was typed: cancelled, or saved. */
  const close = () => {
    discardDraft();
    onClose();
  };

  // The job's hours already on the day, which these join.
  const line = lineOf(model, jobId, date);
  const already = line?.durationSeconds ?? 0;
  const typed = parseDuration(duration) ?? 0;
  // With a line, the field is the day's total and what's added is the difference.
  const seconds = line ? typed - already : typed;
  const locked = line != null && !isEditable(line.status);
  const lockedForGood = locked && !isOwnerReopenable(line.status, line.adminApproved);
  const problems =
    line && seconds < 0
      ? ["That's less than the hours already there. To lower those, edit them."]
      : lockedForGood
        ? ["These hours are approved; an admin can reopen them to add more."]
        : rollupProblems([{ jobId, durationSeconds: seconds, joinsLine: line != null }]);

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
    flyToEntry(line?.id ?? entryId, seconds > 0 ? formatDurationHuman(seconds) : "notes", leaves);
    close();
  }

  return (
    <Modal opened={opened} onClose={close} title={`Hours for ${jobLabel(jobName)}`} centered fullScreen={narrow}>
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
        {line && (
          <Text size="sm">
            {title} already has {formatDurationHuman(already)} {isToday ? "today" : `on ${formatWorkDate(date)}`}; these
            notes join those hours, as one line.
            {locked && !lockedForGood ? " They're submitted, so they'll be taken back — submit the day again after." : ""}
          </Text>
        )}
        <div data-draft>
          <DurationInput
            label={line ? "Total for the day" : "Time worked"}
            value={duration}
            onChange={(v) => {
              setDraft((t) => ({ ...t, duration: v }));
            }}
          />
        </div>
        <Textarea
          label="Note"
          description="Goes with the hours, to accounting."
          value={note}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setDraft((t) => ({ ...t, note: v }));
          }}
          data-draft
          maxLength={NOTE_MAX_LENGTH}
          autosize
          minRows={2}
          maxRows={6}
        />
        {line && problems.length > 0 && (
          <Text size="sm" c="red">
            {problems[0]}
          </Text>
        )}
        {error && (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void commit()} loading={busy} disabled={problems.length > 0}>
            {line && seconds === 0 ? `Attach the notes to ${title}` : `Add ${formatDurationHuman(Math.max(0, seconds))} to ${title}`}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
