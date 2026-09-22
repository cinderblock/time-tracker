import { Badge, Button, Card, Group, Modal, Stack, Text, Textarea, Title } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useEffect, useRef, useState } from "react";

import { jobLabel, jobPath } from "../../src/job-names.ts";
import { NOTE_MAX_LENGTH } from "../../src/limits.ts";
import { formatClock, formatDuration, formatDurationHuman } from "../../src/time.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { useNow, useTracker, useUndoToast } from "./context.tsx";
import { useFlight, whereItIs } from "./flight.tsx";
import { JobSelect, RecentJobButtons } from "./JobPicker.tsx";
import { type EntryView, type JobView, liveSeconds } from "./model.ts";

/**
 * The top of the screen: the running (or paused) timer with its controls, or
 * — when nothing is running — the ways to start one. Switching jobs is one
 * tap on a recent job; a required note is asked for right there.
 */
export function TimerPanel() {
  const { model } = useTracker();
  return model.open ? <RunningTimer entry={model.open} /> : <StartTimer />;
}

function StartTimer() {
  const { dispatch, pending, location } = useTracker();
  const [jobId, setJobId] = useState<string | null>(null);

  async function start(id: string) {
    await dispatch("timer.start", { entryId: uuidv7(), jobId: id, at: Date.now(), location: location() });
    setJobId(null);
  }

  return (
    <Card withBorder padding="lg" radius="md">
      <Stack gap="md">
        <Title order={3}>Start a timer</Title>
        <RecentJobButtons onPick={(job) => start(job.id)} disabled={pending} />
        <JobSelect
          value={jobId}
          onChange={(id) => {
            setJobId(id);
            if (id) void start(id);
          }}
          placeholder="Any job — type to search"
        />
      </Stack>
    </Card>
  );
}

function RunningTimer({ entry }: { entry: EntryView }) {
  const { model, dispatch, dispatchAll, pending, location } = useTracker();
  const { flyToEntry } = useFlight();
  const now = useNow();
  const undoToast = useUndoToast();
  // Where the time flies from when the timer ends and this card goes away.
  const card = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState(entry.note ?? "");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [switchTo, setSwitchTo] = useState<JobView | null>(null);
  const [otherJob, setOtherJob] = useState<string | null>(null);
  const paused = entry.runningSince == null;
  const tz = model.timezone;
  const { name: jobTitle, above: jobPlace } = jobPath(entry.jobName);

  // Keep the field in step when the entry changes underneath (another device).
  useEffect(() => setNote(entry.note ?? ""), [entry.id, entry.note]);

  const noteDirty = note.trim() !== (entry.note ?? "");
  const needsNote = entry.noteRequired && !note.trim();

  async function saveNote() {
    if (!noteDirty) return;
    await dispatch("entry.update", { entryId: entry.id, note: note.trim() || null }, { background: true });
  }

  /**
   * The time this timer will have recorded once it stops at `at` — what the
   * card is showing, and so what flies to the row it settles into.
   */
  function settled(at: number) {
    return formatDurationHuman(liveSeconds(entry, at));
  }

  async function stop() {
    if (needsNote) {
      setNoteError("This job needs a note before the timer can stop.");
      return;
    }
    setNoteError(null);
    const at = Date.now();
    // Before the dispatch: a successful stop takes this card off the screen.
    const from = whereItIs(card.current);
    const result = await dispatch("timer.stop", {
      entryId: entry.id,
      at,
      note: noteDirty ? note.trim() || null : undefined,
      location: location(),
    });
    if (!result.ok && result.code === "note_required") setNoteError(result.error);
    // This card is about to be replaced by "Start a timer": say where its time went.
    else if (result.ok) flyToEntry(entry.id, settled(at), from);
  }

  async function doSwitch(job: JobView, closingNote?: string) {
    const at = Date.now();
    const from = whereItIs(card.current);
    const ops: { type: "timer.stop" | "timer.start"; payload: unknown }[] = [];
    // Stop explicitly when there's a note to attach; otherwise the start
    // implies the stop at the same instant.
    if (closingNote !== undefined || noteDirty) {
      ops.push({
        type: "timer.stop",
        payload: { entryId: entry.id, at, note: (closingNote ?? note).trim() || null, location: location() },
      });
    }
    ops.push({ type: "timer.start", payload: { entryId: uuidv7(), jobId: job.id, at, location: location() } });
    const results = await dispatchAll(ops);
    const blocked = results.find((r) => !r.ok && r.code === "note_required");
    if (blocked) setSwitchTo(job);
    else {
      setSwitchTo(null);
      // The card stays, but it is the new job's now — the old job's time has
      // gone to the record, so it travels there too.
      flyToEntry(entry.id, settled(at), from);
    }
    setOtherJob(null);
  }

  function requestSwitch(job: JobView) {
    if (needsNote) setSwitchTo(job);
    else void doSwitch(job);
  }

  async function discard() {
    await dispatch("entry.delete", { entryId: entry.id, at: Date.now() });
    undoToast(`Discarded the ${jobLabel(entry.jobName)} timer.`, () =>
      dispatch("entry.restore", { entryId: entry.id, at: Date.now() }),
    );
  }

  return (
    <Card ref={card} withBorder padding="lg" radius="md" shadow="sm">
      <Stack gap="md">
        <Group justify="space-between" align="start" wrap="nowrap">
          <Stack gap={2}>
            <Text size="sm" c="dimmed">
              {paused ? "Paused" : "Working on"}
            </Text>
            <Title order={3} lh={1.2}>
              {jobTitle}
            </Title>
            {jobPlace && (
              <Text size="sm" c="dimmed">
                {jobPlace}
              </Text>
            )}
          </Stack>
          <Badge color={paused ? "yellow" : "green"} variant="light">
            {paused ? "paused" : "running"}
          </Badge>
        </Group>

        <Stack gap={0} align="center">
          <Text
            // Fixed-width digits in the normal face: the readout doesn't
            // jiggle as it ticks, without monospace's gappy colon.
            style={{ fontVariantNumeric: "tabular-nums" }}
            fz={{ base: 48, sm: 60 }}
            fw={600}
            lh={1.1}
            aria-live="off"
            c={paused ? "dimmed" : undefined}
          >
            {formatDuration(now === undefined ? entry.durationSeconds : liveSeconds(entry, now))}
          </Text>
          {entry.startedAt != null && (
            <Text size="sm" c="dimmed">
              Started {formatClock(entry.startedAt, tz)}
              {entry.workDate !== model.today ? ` on ${entry.workDate}` : ""}
            </Text>
          )}
        </Stack>

        <Textarea
          label="Note"
          placeholder={entry.noteRequired ? "Required before stopping" : "What are you doing? (optional)"}
          value={note}
          onChange={(e) => {
            setNote(e.currentTarget.value);
            setNoteError(null);
          }}
          onBlur={() => void saveNote()}
          maxLength={NOTE_MAX_LENGTH}
          autosize
          minRows={1}
          maxRows={4}
          error={noteError}
          required={entry.noteRequired}
        />

        <Group grow>
          <Button
            variant="default"
            size="lg"
            disabled={pending}
            onClick={() =>
              dispatch(paused ? "timer.resume" : "timer.pause", { entryId: entry.id, at: Date.now() })
            }
          >
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button color="red" size="lg" disabled={pending} onClick={() => void stop()}>
            Stop
          </Button>
        </Group>

        <Stack gap="xs">
          <Text size="sm" fw={500}>
            Switch to
          </Text>
          <RecentJobButtons onPick={requestSwitch} exclude={entry.jobId} disabled={pending} label="Switch to" />
          <JobSelect
            value={otherJob}
            onChange={(id) => {
              setOtherJob(id);
              const job = model.jobs.find((j) => j.id === id);
              if (job) requestSwitch(job);
            }}
            placeholder="Another job — type to search"
          />
        </Stack>

        <Group justify="flex-end">
          <Button variant="subtle" color="gray" size="compact-sm" onClick={() => void discard()} disabled={pending}>
            Discard this timer
          </Button>
        </Group>
      </Stack>

      <SwitchNoteModal
        job={switchTo}
        fromJob={entry.jobName}
        initial={note}
        onCancel={() => setSwitchTo(null)}
        onConfirm={(text) => switchTo && doSwitch(switchTo, text)}
      />
    </Card>
  );
}

/** Asked when switching away from a timer whose job needs a note. */
function SwitchNoteModal({
  job,
  fromJob,
  initial,
  onCancel,
  onConfirm,
}: {
  job: JobView | null;
  fromJob: string;
  initial: string;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const narrow = useMediaQuery("(max-width: 36em)");
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial, job]);
  return (
    <Modal opened={job != null} onClose={onCancel} title={`Note for ${jobLabel(fromJob)}`} centered fullScreen={narrow}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onConfirm(text);
        }}
      >
        <Stack>
          <Text size="sm">
            {jobLabel(fromJob)} needs a note before its timer stops. Then the timer switches to {job ? jobLabel(job.fullName) : ""}.
          </Text>
          <Textarea
            label="What did you do?"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            maxLength={NOTE_MAX_LENGTH}
            autosize
            minRows={2}
            required
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!text.trim()}>
              Save and switch
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
