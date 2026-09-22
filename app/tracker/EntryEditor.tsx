import { Alert, Button, Group, Modal, SegmentedControl, Stack, Text, TextInput, Textarea } from "@mantine/core";
import { TimeInput } from "@mantine/dates";
import { useMediaQuery } from "@mantine/hooks";
import { useEffect, useRef, useState } from "react";

import { jobLabel } from "../../src/job-names.ts";
import { NOTE_MAX_LENGTH } from "../../src/limits.ts";
import {
  addDays,
  formatDurationHuman,
  formatDurationInput,
  parseDuration,
  workDateOf,
  zonedTimeInput,
  zonedTimeToInstant,
} from "../../src/time.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { DurationInput, durationProblem } from "../components/duration-input.tsx";
import { useHeldOpen } from "../components/use-held-open.ts";
import { useTracker, useUndoToast } from "./context.tsx";
import { JobSelect } from "./JobPicker.tsx";
import type { EntryView } from "./model.ts";

type Mode = "times" | "duration";

/**
 * What else goes when a timer's times do. A paused timer recorded real gaps,
 * and a plain duration has nowhere to keep them — worth saying before it
 * happens rather than after.
 */
function pausesLost(entry: EntryView | null): string {
  const pauses = (entry?.segmentCount ?? 0) - 1;
  if (pauses < 1) return "";
  return `, and the ${pauses === 1 ? "pause" : `${pauses} pauses`} it recorded`;
}

/**
 * Create or edit an entry. An entry with start and end times is edited by
 * times; a typed-in duration by date and duration. An end time earlier than
 * the start means the work ran past midnight.
 */
export function EntryEditor({
  entry: subject,
  opened,
  onClose,
  defaultDate,
}: {
  /** null = create a new entry */
  entry: EntryView | null;
  opened: boolean;
  onClose: () => void;
  defaultDate: string;
}) {
  // The list clears `editing` in the same breath as `opened`, so without this
  // the dialog spends its whole fade-out as the "Add time" form.
  const entry = useHeldOpen(opened, subject);
  const { model, dispatch } = useTracker();
  const undoToast = useUndoToast();
  const narrow = useMediaQuery("(max-width: 36em)");
  const tz = model.timezone;
  const isOpenTimer = entry?.status === "open";

  const [mode, setMode] = useState<Mode>("times");
  const [jobId, setJobId] = useState<string | null>(null);
  const [date, setDate] = useState(defaultDate);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [duration, setDuration] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset the form when it opens — and only then. Defaults are read through a
  // ref: the model is rebuilt on every data refresh (creating a job from
  // inside this dialog causes one), which must not wipe what's been typed.
  const defaults = useRef({ jobId: model.open?.jobId ?? model.recentJobIds[0] ?? null, tz, defaultDate });
  defaults.current = { jobId: model.open?.jobId ?? model.recentJobIds[0] ?? null, tz, defaultDate };
  useEffect(() => {
    const { tz, defaultDate } = defaults.current;
    if (!opened) return;
    setError(null);
    setBusy(false);
    if (entry) {
      setMode(entry.startedAt != null ? "times" : "duration");
      setJobId(entry.jobId);
      setDate(entry.startedAt != null ? workDateOf(entry.startedAt, tz) : entry.workDate);
      setStart(entry.startedAt != null ? zonedTimeInput(entry.startedAt, tz) : "");
      setEnd(entry.endedAt != null ? zonedTimeInput(entry.endedAt, tz) : "");
      setDuration(formatDurationInput(entry.durationSeconds));
      setNote(entry.note ?? "");
    } else {
      setMode("times");
      setJobId(defaults.current.jobId);
      setDate(defaultDate);
      setStart("");
      setEnd("");
      setDuration("");
      setNote("");
    }
  }, [opened, entry]);

  // Derived span for "times" mode.
  const startAt = start ? zonedTimeToInstant(date, start, tz) : null;
  let endAt = end ? zonedTimeToInstant(date, end, tz) : null;
  const overnight = startAt != null && endAt != null && endAt <= startAt;
  if (overnight && endAt != null) endAt = zonedTimeToInstant(addDays(date, 1), end, tz);
  const durationFromTimes = startAt != null && endAt != null ? Math.round((endAt - startAt) / 1000) : null;
  const typedSeconds = parseDuration(duration) ?? 0;

  /**
   * The shape this entry is recorded in today, and whether the toggle is
   * asking to change it. An entry made of a span and one made of a typed-in
   * duration are different things, so switching is a conversion — saved with
   * `convertTo`, and said out loud under the toggle before it happens.
   */
  const shape: Mode = entry?.startedAt != null ? "times" : "duration";
  const converting = entry != null && !isOpenTimer && mode !== shape;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!jobId) return setError("Pick a job.");
    const cleanNote = note.trim() || null;

    let result;
    setBusy(true);
    if (entry && converting) {
      // Everything the new shape is made of goes, unconditionally: these
      // fields define the entry now rather than amending what's there.
      const common = {
        entryId: entry.id,
        jobId: jobId !== entry.jobId ? jobId : undefined,
        note: cleanNote !== entry.note ? cleanNote : undefined,
      };
      if (mode === "duration") {
        const problem = durationProblem(duration);
        if (problem) {
          setBusy(false);
          return setError(problem);
        }
        result = await dispatch(
          "entry.update",
          { ...common, convertTo: "duration", workDate: date, durationSeconds: typedSeconds },
          { quiet: true },
        );
      } else {
        if (startAt == null || endAt == null) {
          setBusy(false);
          return setError("Enter a start and an end time.");
        }
        result = await dispatch(
          "entry.update",
          { ...common, convertTo: "times", startedAt: startAt, endedAt: endAt },
          { quiet: true },
        );
      }
    } else if (!entry) {
      if (mode === "times") {
        if (startAt == null || endAt == null) {
          setBusy(false);
          return setError("Enter a start and an end time.");
        }
        result = await dispatch(
          "entry.create",
          { entryId: uuidv7(), jobId, startedAt: startAt, endedAt: endAt, note: cleanNote },
          { quiet: true },
        );
      } else {
        const problem = durationProblem(duration);
        if (problem) {
          setBusy(false);
          return setError(problem);
        }
        result = await dispatch(
          "entry.create",
          { entryId: uuidv7(), jobId, workDate: date, durationSeconds: typedSeconds, note: cleanNote },
          { quiet: true },
        );
      }
    } else if (entry.startedAt != null) {
      result = await dispatch(
        "entry.update",
        {
          entryId: entry.id,
          jobId: jobId !== entry.jobId ? jobId : undefined,
          note: cleanNote !== entry.note ? cleanNote : undefined,
          startedAt: startAt != null && startAt !== entry.startedAt ? startAt : undefined,
          endedAt: !isOpenTimer && endAt != null && endAt !== entry.endedAt ? endAt : undefined,
        },
        { quiet: true },
      );
    } else {
      const problem = durationProblem(duration);
      if (problem) {
        setBusy(false);
        return setError(problem);
      }
      result = await dispatch(
        "entry.update",
        {
          entryId: entry.id,
          jobId: jobId !== entry.jobId ? jobId : undefined,
          note: cleanNote !== entry.note ? cleanNote : undefined,
          workDate: date !== entry.workDate ? date : undefined,
          durationSeconds: typedSeconds !== entry.durationSeconds ? typedSeconds : undefined,
        },
        { quiet: true },
      );
    }
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error);
  }

  async function remove() {
    if (!entry) return;
    setBusy(true);
    const result = await dispatch("entry.delete", { entryId: entry.id, at: Date.now() });
    setBusy(false);
    if (!result.ok) return;
    onClose();
    undoToast(`Deleted ${jobLabel(entry.jobName)}.`, () => dispatch("entry.restore", { entryId: entry.id, at: Date.now() }));
  }

  const title = !entry ? "Add time" : isOpenTimer ? "Edit running timer" : "Edit entry";

  return (
    <Modal opened={opened} onClose={onClose} title={title} centered fullScreen={narrow}>
      <form onSubmit={save}>
        <Stack gap="md">
          <JobSelect label="Job" value={jobId} onChange={setJobId} required />

          {/* A running timer's shape isn't up for discussion — it's still
              collecting the times. Stopping it is the way. */}
          {!isOpenTimer && (
            <Stack gap={4}>
              <SegmentedControl
                value={mode}
                onChange={(v) => setMode(v as Mode)}
                data={[
                  { value: "times", label: "Start & end" },
                  { value: "duration", label: "Just a duration" },
                ]}
              />
              {converting && (
                <Text size="sm" c="dimmed">
                  {mode === "duration"
                    ? `Saving replaces the start and end with this duration${pausesLost(entry)}.`
                    : "Saving replaces the duration with these times."}
                </Text>
              )}
            </Stack>
          )}

          <TextInput
            type="date"
            label="Date"
            value={date}
            onChange={(e) => setDate(e.currentTarget.value)}
            required
            max={model.today}
            disabled={isOpenTimer}
          />

          {mode === "times" ? (
            <Stack gap={4}>
              <Group grow align="start">
                <TimeInput label="Start" value={start} onChange={(e) => setStart(e.currentTarget.value)} required />
                {!isOpenTimer && (
                  <TimeInput label="End" value={end} onChange={(e) => setEnd(e.currentTarget.value)} required />
                )}
              </Group>
              {durationFromTimes != null && durationFromTimes > 0 && (
                <Text size="sm" c="dimmed">
                  {formatDurationHuman(durationFromTimes)}
                  {overnight ? " — ends the next day" : ""}
                </Text>
              )}
              {isOpenTimer && (
                <Text size="sm" c="dimmed">
                  The timer is still running; stop it to set an end time.
                </Text>
              )}
            </Stack>
          ) : (
            <DurationInput label="Time worked" value={duration} onChange={setDuration} required />
          )}

          <Textarea
            label="Note"
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            maxLength={NOTE_MAX_LENGTH}
            autosize
            minRows={2}
            maxRows={6}
          />

          {entry && entry.segmentCount > 1 && !converting && (
            <Text size="sm" c="dimmed">
              This timer was paused {entry.segmentCount - 1} time{entry.segmentCount > 2 ? "s" : ""}; changing the
              start or end keeps the pauses.
            </Text>
          )}

          {error && (
            <Alert color="red" role="alert">
              {error}
            </Alert>
          )}

          <Group justify="space-between">
            {entry ? (
              <Button variant="subtle" color="red" onClick={() => void remove()} disabled={busy}>
                Delete
              </Button>
            ) : (
              <span />
            )}
            <Group gap="xs">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                {entry ? "Save" : "Add time"}
              </Button>
            </Group>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
