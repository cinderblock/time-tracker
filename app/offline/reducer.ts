import type { Op } from "../../src/ops-schema.ts";
import { workDateOf } from "../../src/time.ts";
import { type DayModel, type EntryView, type JobView, type NoteView, compareEntries, compareNotes } from "../tracker/model.ts";

/**
 * Applies not-yet-reflected ops to the last server copy of a day, so the
 * screen shows a change the moment it's made — online or not.
 *
 * The server stays the authority: this only has to be right about what the
 * server *will* do for ops it accepts. An op the server rejects is dropped
 * from the queue, and the next render simply no longer applies it.
 *
 * Idempotent by construction: an op whose effect the copy already shows
 * (because it synced before the copy was fetched) is skipped, never applied
 * twice. Pure and dependency-free.
 */
export function applyPending(base: DayModel, ops: readonly Op[]): DayModel {
  const state: State = {
    m: {
      ...base,
      entries: [...base.entries],
      notes: [...base.notes],
      jobs: [...base.jobs],
      recentJobIds: [...base.recentJobIds],
      week: base.week.map((d) => ({ ...d })),
    },
    deletedEntries: new Map(),
    deletedNotes: new Map(),
  };
  for (const op of ops) applyOne(state, op);
  state.m.entries.sort(compareEntries);
  state.m.notes.sort(compareNotes);
  return state.m;
}

interface State {
  m: DayModel;
  /** Entries deleted by an op in this same run, so a later restore can bring them back. */
  deletedEntries: Map<string, { entry: EntryView; at: number }>;
  deletedNotes: Map<string, NoteView>;
}

function jobOf(m: DayModel, id: string | null | undefined): JobView | undefined {
  return id ? m.jobs.find((j) => j.id === id) : undefined;
}

function jobName(m: DayModel, id: string | null): string {
  if (!id) return "No job";
  return jobOf(m, id)?.fullName ?? "Unknown job";
}

function addToWeek(m: DayModel, date: string, seconds: number): void {
  if (!seconds) return;
  const day = m.week.find((d) => d.date === date);
  if (day) day.seconds = Math.max(0, day.seconds + seconds);
}

/**
 * Recent jobs, approximately: the server derives them from live entries (so a
 * job whose only entries were deleted drops off), which a single day's copy
 * can't reproduce. Here a job used by an op moves to the front and nothing is
 * removed until the next refresh — a shortcut row that's briefly generous.
 */
function touchRecent(m: DayModel, jobId: string): void {
  m.recentJobIds = [jobId, ...m.recentJobIds.filter((id) => id !== jobId)].slice(0, 6);
}

function findEntry(m: DayModel, id: string): EntryView | undefined {
  return m.entries.find((e) => e.id === id) ?? (m.open?.id === id ? m.open : undefined);
}

/** Replace an entry wherever it appears (list and/or open slot), or drop it from the list if it left this day. */
function putEntry(m: DayModel, entry: EntryView): void {
  const onDay = entry.workDate === m.workDate;
  const i = m.entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) {
    if (onDay) m.entries[i] = entry;
    else m.entries.splice(i, 1);
  } else if (onDay) {
    m.entries.push(entry);
  }
  if (m.open?.id === entry.id) m.open = entry.status === "open" ? entry : null;
}

function noteRequired(m: DayModel, jobId: string | null): boolean {
  return m.requireNoteOnStop || (jobOf(m, jobId)?.requiresNote ?? false);
}

function stopEntry(m: DayModel, entry: EntryView, at: number, note: string | null | undefined): void {
  const running = entry.runningSince != null ? Math.max(0, Math.round((at - entry.runningSince) / 1000)) : 0;
  const stopped: EntryView = {
    ...entry,
    status: "draft",
    durationSeconds: entry.durationSeconds + running,
    runningSince: null,
    endedAt: entry.runningSince != null ? at : (entry.lastEndedAt ?? at),
    lastEndedAt: entry.runningSince != null ? at : entry.lastEndedAt,
    note: note !== undefined ? note : entry.note,
    noteRequired: false,
  };
  addToWeek(m, entry.workDate, running);
  putEntry(m, stopped);
  m.open = null;
}

const cleanNote = (n: string | null | undefined) => (n === undefined ? undefined : n?.trim() ? n.trim() : null);

function applyOne(s: State, op: Op): void {
  const { m } = s;
  switch (op.type) {
    case "job.create": {
      const p = op.payload;
      if (m.jobs.some((j) => j.id === p.jobId)) return;
      const parent = jobOf(m, p.parentId);
      m.jobs.push({
        id: p.jobId,
        fullName: parent ? `${parent.fullName}:${p.name.trim()}` : p.name.trim(),
        requiresNote: false,
        active: true,
        provisional: false,
      });
      m.jobs.sort((a, b) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" }));
      return;
    }

    case "timer.start": {
      const p = op.payload;
      if (findEntry(m, p.entryId)) return;
      if (m.open) stopEntry(m, m.open, p.at, undefined);
      const entry: EntryView = {
        id: p.entryId,
        jobId: p.jobId,
        jobName: jobName(m, p.jobId),
        workDate: workDateOf(p.at, m.timezone),
        note: cleanNote(p.note) ?? null,
        source: "timer",
        status: "open",
        durationSeconds: 0,
        startedAt: p.at,
        endedAt: null,
        runningSince: p.at,
        lastEndedAt: null,
        segmentCount: 1,
        noteRequired: noteRequired(m, p.jobId),
      };
      m.open = entry;
      putEntry(m, entry);
      touchRecent(m, p.jobId);
      return;
    }

    case "timer.pause": {
      const p = op.payload;
      const open = m.open;
      if (open?.id !== p.entryId || open.runningSince == null) return;
      const ran = Math.max(0, Math.round((p.at - open.runningSince) / 1000));
      addToWeek(m, open.workDate, ran);
      putEntry(m, { ...open, durationSeconds: open.durationSeconds + ran, runningSince: null, lastEndedAt: p.at });
      return;
    }

    case "timer.resume": {
      const p = op.payload;
      const open = m.open;
      if (open?.id !== p.entryId || open.runningSince != null) return;
      putEntry(m, { ...open, runningSince: p.at, segmentCount: open.segmentCount + 1 });
      return;
    }

    case "timer.stop": {
      const p = op.payload;
      if (m.open?.id !== p.entryId) return;
      stopEntry(m, m.open, p.at, cleanNote(p.note));
      return;
    }

    case "entry.create": {
      const p = op.payload;
      if (findEntry(m, p.entryId)) return;
      const spanned = p.startedAt != null && p.endedAt != null;
      const workDate = spanned ? workDateOf(p.startedAt!, m.timezone) : p.workDate!;
      const seconds = spanned ? Math.round((p.endedAt! - p.startedAt!) / 1000) : p.durationSeconds!;
      putEntry(m, {
        id: p.entryId,
        jobId: p.jobId,
        jobName: jobName(m, p.jobId),
        workDate,
        note: cleanNote(p.note) ?? null,
        source: "manual",
        status: "draft",
        durationSeconds: seconds,
        startedAt: spanned ? p.startedAt! : null,
        endedAt: spanned ? p.endedAt! : null,
        runningSince: null,
        lastEndedAt: spanned ? p.endedAt! : null,
        segmentCount: spanned ? 1 : 0,
        noteRequired: false,
      });
      addToWeek(m, workDate, seconds);
      touchRecent(m, p.jobId);
      return;
    }

    case "entry.update": {
      const p = op.payload;
      const e = findEntry(m, p.entryId);
      if (!e) return;
      const next: EntryView = { ...e };
      if (p.jobId !== undefined) {
        next.jobId = p.jobId;
        next.jobName = jobName(m, p.jobId);
        if (e.status === "open") next.noteRequired = noteRequired(m, p.jobId);
        if (p.jobId !== e.jobId) touchRecent(m, p.jobId);
      }
      const note = cleanNote(p.note);
      if (note !== undefined) next.note = note;

      if (e.startedAt != null) {
        if (p.startedAt !== undefined) {
          next.startedAt = p.startedAt;
          next.workDate = workDateOf(p.startedAt, m.timezone);
          // A lone running segment starts where the timer starts.
          if (e.runningSince != null && e.segmentCount === 1) next.runningSince = p.startedAt;
          else next.durationSeconds += Math.round((e.startedAt - p.startedAt) / 1000);
        }
        if (p.endedAt !== undefined && e.endedAt != null) {
          next.durationSeconds += Math.round((p.endedAt - e.endedAt) / 1000);
          next.endedAt = p.endedAt;
          next.lastEndedAt = p.endedAt;
        }
      } else {
        if (p.workDate !== undefined) next.workDate = p.workDate;
        if (p.durationSeconds !== undefined) next.durationSeconds = p.durationSeconds;
      }
      addToWeek(m, e.workDate, -e.durationSeconds);
      addToWeek(m, next.workDate, next.durationSeconds);
      putEntry(m, next);
      return;
    }

    case "entry.delete": {
      const p = op.payload;
      const e = findEntry(m, p.entryId);
      if (!e) return;
      s.deletedEntries.set(e.id, { entry: e, at: p.at });
      m.entries = m.entries.filter((x) => x.id !== e.id);
      if (m.open?.id === e.id) m.open = null;
      addToWeek(m, e.workDate, -e.durationSeconds);
      return;
    }

    case "entry.restore": {
      const p = op.payload;
      const deleted = s.deletedEntries.get(p.entryId);
      // Deleted before this copy was fetched: nothing local to restore until it syncs.
      if (!deleted || findEntry(m, deleted.entry.id)) return;
      const e = deleted.entry;
      s.deletedEntries.delete(e.id);
      let restored = e;
      if (e.status === "open" && m.open) {
        // Another timer started meanwhile: it comes back stopped at the moment
        // it was deleted, as the server does.
        const stopAt = e.runningSince != null ? Math.max(deleted.at, e.runningSince) : deleted.at;
        const ran = e.runningSince != null ? Math.round((stopAt - e.runningSince) / 1000) : 0;
        restored = {
          ...e,
          status: "draft",
          durationSeconds: e.durationSeconds + ran,
          runningSince: null,
          endedAt: e.runningSince != null ? stopAt : (e.lastEndedAt ?? stopAt),
          lastEndedAt: e.runningSince != null ? stopAt : e.lastEndedAt,
          noteRequired: false,
        };
      } else if (e.status === "open") {
        m.open = e;
      }
      addToWeek(m, restored.workDate, restored.durationSeconds);
      putEntry(m, restored);
      return;
    }

    case "note.create": {
      const p = op.payload;
      if (m.notes.some((n) => n.id === p.noteId)) return;
      if (workDateOf(p.at, m.timezone) !== m.workDate) return;
      m.notes.push({
        id: p.noteId,
        at: p.at,
        text: p.text.trim(),
        jobId: p.jobId ?? null,
        jobName: p.jobId ? jobName(m, p.jobId) : null,
        rolledIntoEntryId: null,
      });
      return;
    }

    case "note.update": {
      const p = op.payload;
      const i = m.notes.findIndex((n) => n.id === p.noteId);
      if (i < 0) return;
      const n = { ...m.notes[i]! };
      if (p.text !== undefined) n.text = p.text.trim();
      if (p.jobId !== undefined) {
        n.jobId = p.jobId;
        n.jobName = p.jobId ? jobName(m, p.jobId) : null;
      }
      if (p.at !== undefined) n.at = p.at;
      if (workDateOf(n.at, m.timezone) === m.workDate) m.notes[i] = n;
      else m.notes.splice(i, 1);
      return;
    }

    case "note.delete": {
      const p = op.payload;
      const n = m.notes.find((x) => x.id === p.noteId);
      if (!n) return;
      s.deletedNotes.set(n.id, n);
      m.notes = m.notes.filter((x) => x.id !== n.id);
      return;
    }

    case "note.restore": {
      const p = op.payload;
      const n = s.deletedNotes.get(p.noteId);
      if (!n || m.notes.some((x) => x.id === n.id)) return;
      s.deletedNotes.delete(n.id);
      m.notes.push(n);
      return;
    }

    case "rollup.commit": {
      const p = op.payload;
      if (p.workDate !== m.workDate) return;
      for (const line of p.lines) {
        if (findEntry(m, line.entryId)) continue;
        const seconds = Math.round((line.endedAt - line.startedAt) / 1000);
        putEntry(m, {
          id: line.entryId,
          jobId: line.jobId,
          jobName: jobName(m, line.jobId),
          workDate: p.workDate,
          note: cleanNote(line.note) ?? null,
          source: "note_rollup",
          status: "draft",
          durationSeconds: seconds,
          startedAt: line.startedAt,
          endedAt: line.endedAt,
          runningSince: null,
          lastEndedAt: line.endedAt,
          segmentCount: 1,
          noteRequired: false,
        });
        addToWeek(m, p.workDate, seconds);
        touchRecent(m, line.jobId);
        m.notes = m.notes.map((n) => (line.noteIds.includes(n.id) ? { ...n, rolledIntoEntryId: line.entryId } : n));
      }
      return;
    }
  }
}
