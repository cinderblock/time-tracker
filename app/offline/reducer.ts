import { isEditable, isOwnerReopenable } from "../../src/entry-status.ts";
import { MAX_ENTRY_SECONDS, NOTE_MAX_LENGTH } from "../../src/limits.ts";
import type { Op } from "../../src/ops-schema.ts";
import { joinDescriptions } from "../../src/rollup.ts";
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
      unsubmittedDays: [...base.unsubmittedDays],
      // A copy stored before this field existed has none.
      heldDays: [...(base.heldDays ?? [])],
      week: base.week.map((d) => ({ ...d })),
    },
    deletedEntries: new Map(),
    deletedNotes: new Map(),
    closedInRun: new Set(),
    aliases: new Map(Object.entries(base.aliases ?? {})),
  };
  for (const op of ops) applyOne(state, op);
  state.m.entries.sort(compareEntries);
  state.m.notes.sort(compareNotes);
  return state.m;
}

interface State {
  m: DayModel;
  /**
   * Entries deleted by an op in this same run, so a later restore can bring
   * them back — with the notes that were part of each, which it frees.
   */
  deletedEntries: Map<string, { entry: EntryView; at: number; noteIds: string[] }>;
  deletedNotes: Map<string, NoteView>;
  /**
   * Timers stopped or paused by an op in this same run. A reopen undoes one
   * of those and nothing else: told apart from a timer the server had already
   * stopped, it can't reopen it twice when the ops are applied again on top
   * of a copy that already shows the stop.
   */
  closedInRun: Set<string>;
  /**
   * Ids standing for a line their time joined — from the server's copy, and
   * from ops in this run that the server will treat the same way.
   */
  aliases: Map<string, string>;
}

/** The entry an op's id names: itself, or the line its time joined. */
function resolve(s: State, id: string): string {
  return s.aliases.get(id) ?? id;
}

/**
 * The person's line for a job and day, as this copy knows it — the server's
 * rule (lineFor in entries.ts). Only the shown day's entries and the open
 * timer are here; a line on another day is the server's to find.
 */
export function lineOf(m: DayModel, jobId: string, workDate: string, exceptId?: string): EntryView | undefined {
  const all = m.open && !m.entries.some((e) => e.id === m.open!.id) ? [...m.entries, m.open] : m.entries;
  return all
    .filter((e) => e.jobId === jobId && e.workDate === workDate && e.id !== exceptId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

/**
 * A line ready to take more time: as it is, or the person's own submission
 * taken back. Undefined when the server will refuse (an admin approved it).
 */
function readyToAdd(e: EntryView): EntryView | undefined {
  if (isEditable(e.status)) return e;
  if (isOwnerReopenable(e.status, e.adminApproved)) return { ...e, status: "draft" };
  return undefined;
}

/**
 * Add time to a line, as the server's addToLine does. Undefined, and the copy
 * untouched, when the server will refuse it.
 */
function addTo(
  m: DayModel,
  line: EntryView,
  add: { startedAt?: number; endedAt?: number; seconds?: number; note?: string | null },
): EntryView | undefined {
  const ready = readyToAdd(line);
  if (!ready) return undefined;
  const spanned = add.startedAt != null && add.endedAt != null;
  const adding = spanned ? Math.round((add.endedAt! - add.startedAt!) / 1000) : (add.seconds ?? 0);
  if (ready.durationSeconds + adding > MAX_ENTRY_SECONDS) return undefined;
  const note = joinDescriptions(ready.note, cleanNote(add.note));
  if (note && note.length > NOTE_MAX_LENGTH) return undefined;
  const next: EntryView = {
    ...ready,
    note,
    durationSeconds: ready.durationSeconds + adding,
    untimedSeconds: (ready.untimedSeconds ?? 0) + (spanned ? 0 : adding),
  };
  if (spanned) {
    next.startedAt = Math.min(ready.startedAt ?? add.startedAt!, add.startedAt!);
    next.endedAt = ready.status === "open" ? null : Math.max(ready.endedAt ?? add.endedAt!, add.endedAt!);
    next.lastEndedAt = Math.max(ready.lastEndedAt ?? add.endedAt!, add.endedAt!);
    next.segmentCount = ready.segmentCount + 1;
  }
  addToWeek(m, ready.workDate, adding);
  putEntry(m, next);
  return next;
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

function stopEntry(s: State, entry: EntryView, at: number, note: string | null | undefined): void {
  const { m } = s;
  const running = entry.runningSince != null ? Math.max(0, Math.round((at - entry.runningSince) / 1000)) : 0;
  // Stopped the moment it continued a line — its undo: the server drops the
  // empty segment, so the line ends where it ended before.
  const empty = entry.runningSince === at && (entry.segmentCount > 1 || (entry.untimedSeconds ?? 0) > 0);
  const stopped: EntryView = {
    ...entry,
    status: "draft",
    durationSeconds: entry.durationSeconds + running,
    runningSince: null,
    endedAt: empty ? entry.lastEndedAt : entry.runningSince != null ? at : (entry.lastEndedAt ?? at),
    lastEndedAt: empty ? entry.lastEndedAt : entry.runningSince != null ? at : entry.lastEndedAt,
    segmentCount: empty ? entry.segmentCount - 1 : entry.segmentCount,
    note: note !== undefined ? note : entry.note,
    noteRequired: false,
  };
  addToWeek(m, entry.workDate, running);
  putEntry(m, stopped);
  m.open = null;
  s.closedInRun.add(entry.id);
}

const cleanNote = (n: string | null | undefined) => (n === undefined ? undefined : n?.trim() ? n.trim() : null);

function applyOne(s: State, op: Op): void {
  const { m } = s;
  switch (op.type) {
    case "job.create": {
      const p = op.payload;
      if (m.jobs.some((j) => j.id === p.jobId)) return;
      const parent = jobOf(m, p.parentId);
      const name = p.name.trim();
      // A new customer (no parent) only groups; a job under a customer
      // takes time and inherits the customer's note rule.
      m.jobs.push({
        id: p.jobId,
        name,
        fullName: parent ? `${parent.fullName}:${name}` : name,
        parentId: parent?.id ?? null,
        requiresNote: parent?.requiresNote ?? false,
        bookable: parent != null,
        takesTime: null,
        provisional: false,
      });
      // The parent now holds a sub-job, so unless an admin has answered for
      // it, it stops taking hours itself — the server's rule (src/jobs.ts).
      if (parent && parent.parentId != null && parent.takesTime == null) parent.bookable = false;
      m.jobs.sort((a, b) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" }));
      return;
    }

    case "timer.start": {
      const p = op.payload;
      if (findEntry(m, resolve(s, p.entryId))) return;
      // The job already has hours that day: the timer continues that line.
      const line = lineOf(m, p.jobId, workDateOf(p.at, m.timezone), p.entryId);
      if (line) {
        if (m.open?.id === line.id) {
          s.aliases.set(p.entryId, line.id);
          // Already on it; paused, it resumes.
          if (line.runningSince == null) putEntry(m, { ...line, runningSince: p.at, segmentCount: line.segmentCount + 1 });
          return;
        }
        // Before the line's time ends, the server refuses.
        if (line.lastEndedAt != null && p.at < line.lastEndedAt) return;
        const ready = readyToAdd(line);
        const note = joinDescriptions(ready?.note, cleanNote(p.note));
        if (!ready || (note && note.length > NOTE_MAX_LENGTH)) return;
        s.aliases.set(p.entryId, line.id);
        if (m.open) stopEntry(s, m.open, p.at, undefined);
        const continued: EntryView = {
          ...ready,
          status: "open",
          note,
          endedAt: null,
          runningSince: p.at,
          segmentCount: ready.segmentCount + 1,
          startedAt: ready.startedAt ?? p.at,
          noteRequired: noteRequired(m, p.jobId),
        };
        m.open = continued;
        putEntry(m, continued);
        touchRecent(m, p.jobId);
        return;
      }
      if (m.open) stopEntry(s, m.open, p.at, undefined);
      const entry: EntryView = {
        id: p.entryId,
        jobId: p.jobId,
        jobName: jobName(m, p.jobId),
        workDate: workDateOf(p.at, m.timezone),
        note: cleanNote(p.note) ?? null,
        source: "timer",
        status: "open",
        durationSeconds: 0,
        untimedSeconds: 0,
        startedAt: p.at,
        endedAt: null,
        runningSince: p.at,
        lastEndedAt: null,
        segmentCount: 1,
        noteRequired: noteRequired(m, p.jobId),
        adminApproved: false,
        heldBy: null,
      };
      m.open = entry;
      putEntry(m, entry);
      touchRecent(m, p.jobId);
      return;
    }

    case "timer.pause": {
      const p = op.payload;
      const open = m.open;
      if (open?.id !== resolve(s, p.entryId) || open.runningSince == null) return;
      // A pause from before this segment began is an earlier one, already in
      // this copy (a line runs again under the same id); the server refuses it.
      if (p.at < open.runningSince) return;
      const ran = Math.max(0, Math.round((p.at - open.runningSince) / 1000));
      addToWeek(m, open.workDate, ran);
      putEntry(m, { ...open, durationSeconds: open.durationSeconds + ran, runningSince: null, lastEndedAt: p.at });
      s.closedInRun.add(open.id);
      return;
    }

    case "timer.resume": {
      const p = op.payload;
      const open = m.open;
      if (open?.id !== resolve(s, p.entryId) || open.runningSince != null) return;
      putEntry(m, { ...open, runningSince: p.at, segmentCount: open.segmentCount + 1 });
      return;
    }

    case "timer.stop": {
      const p = op.payload;
      if (m.open?.id !== resolve(s, p.entryId)) return;
      // A stop from before the running segment began is an earlier one,
      // already in this copy (a line runs again under the same id); the server
      // refuses it.
      if (m.open.runningSince != null && p.at < m.open.runningSince) return;
      stopEntry(s, m.open, p.at, cleanNote(p.note));
      return;
    }

    case "timer.reopen": {
      // Running again from the moment it last stopped or paused: a new
      // segment from there, as the server makes it, so the closed time and
      // the last end stay what they were.
      const e = findEntry(m, resolve(s, op.payload.entryId));
      // Stopped before this copy was fetched: nothing local to reopen until it syncs.
      if (!e || !s.closedInRun.has(e.id)) return;
      if (!e || (e.status !== "draft" && e.status !== "open") || e.runningSince != null || e.lastEndedAt == null) return;
      if (m.open && m.open.id !== e.id) return;
      s.closedInRun.delete(e.id);
      const reopened: EntryView = {
        ...e,
        status: "open",
        runningSince: e.lastEndedAt,
        endedAt: null,
        segmentCount: e.segmentCount + 1,
        noteRequired: noteRequired(m, e.jobId),
      };
      m.open = reopened;
      putEntry(m, reopened);
      return;
    }

    case "entry.create": {
      const p = op.payload;
      if (findEntry(m, resolve(s, p.entryId))) return;
      const spanned = p.startedAt != null && p.endedAt != null;
      const workDate = spanned ? workDateOf(p.startedAt!, m.timezone) : p.workDate!;
      const seconds = spanned ? Math.round((p.endedAt! - p.startedAt!) / 1000) : p.durationSeconds!;
      // The job already has hours that day: this joins them.
      const line = lineOf(m, p.jobId, workDate, p.entryId);
      if (line) {
        const added = addTo(m, line, spanned ? { startedAt: p.startedAt!, endedAt: p.endedAt!, note: p.note } : { seconds, note: p.note });
        if (added) {
          s.aliases.set(p.entryId, added.id);
          touchRecent(m, p.jobId);
        }
        return;
      }
      putEntry(m, {
        id: p.entryId,
        jobId: p.jobId,
        jobName: jobName(m, p.jobId),
        workDate,
        note: cleanNote(p.note) ?? null,
        source: "manual",
        status: "draft",
        durationSeconds: seconds,
        untimedSeconds: spanned ? 0 : seconds,
        startedAt: spanned ? p.startedAt! : null,
        endedAt: spanned ? p.endedAt! : null,
        runningSince: null,
        lastEndedAt: spanned ? p.endedAt! : null,
        segmentCount: spanned ? 1 : 0,
        noteRequired: false,
        adminApproved: false,
        heldBy: null,
      });
      addToWeek(m, workDate, seconds);
      touchRecent(m, p.jobId);
      return;
    }

    case "entry.update": {
      const p = op.payload;
      const e = findEntry(m, resolve(s, p.entryId));
      // Approved time is locked; the server will refuse the change.
      if (!e || !isEditable(e.status)) return;
      const next: EntryView = { ...e };
      if (p.jobId !== undefined) {
        next.jobId = p.jobId;
        next.jobName = jobName(m, p.jobId);
        if (e.status === "open") next.noteRequired = noteRequired(m, p.jobId);
        if (p.jobId !== e.jobId) touchRecent(m, p.jobId);
      }
      const note = cleanNote(p.note);
      if (note !== undefined) next.note = note;

      const hasTimes = e.startedAt != null;
      // Asking for the shape it already has is an ordinary edit (entries.ts).
      const convertTo = p.convertTo === (hasTimes ? "times" : "duration") ? undefined : p.convertTo;
      // A running timer can't change shape, and the server says so; leaving
      // the entry alone keeps this copy agreeing with the answer that comes back.
      if (convertTo !== undefined && e.status === "open") return;

      if (convertTo === "duration") {
        if (p.durationSeconds == null) return;
        // The times go, pauses and all.
        next.startedAt = null;
        next.endedAt = null;
        next.runningSince = null;
        next.lastEndedAt = null;
        next.segmentCount = 0;
        next.workDate = p.workDate ?? e.workDate;
        next.durationSeconds = p.durationSeconds;
        next.untimedSeconds = p.durationSeconds;
      } else if (convertTo === "times") {
        if (p.startedAt == null || p.endedAt == null) return;
        next.startedAt = p.startedAt;
        next.endedAt = p.endedAt;
        next.lastEndedAt = p.endedAt;
        next.runningSince = null;
        next.segmentCount = 1;
        next.workDate = workDateOf(p.startedAt, m.timezone);
        next.durationSeconds = Math.round((p.endedAt - p.startedAt) / 1000);
        next.untimedSeconds = 0;
      } else if (
        hasTimes &&
        (e.untimedSeconds ?? 0) > 0 &&
        p.durationSeconds !== undefined &&
        p.startedAt === undefined &&
        p.endedAt === undefined
      ) {
        // A line with both: a duration is its new total, the times stay.
        const timed = e.durationSeconds - (e.untimedSeconds ?? 0);
        if (p.durationSeconds < timed) return;
        next.durationSeconds = p.durationSeconds;
        next.untimedSeconds = p.durationSeconds - timed;
      } else if (hasTimes && e.startedAt != null) {
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
        if (p.durationSeconds !== undefined) {
          next.durationSeconds = p.durationSeconds;
          next.untimedSeconds = p.durationSeconds;
        }
      }
      if (p.untimedSeconds !== undefined && convertTo === undefined) {
        if (!hasTimes) return;
        next.durationSeconds += p.untimedSeconds - (next.untimedSeconds ?? 0);
        next.untimedSeconds = p.untimedSeconds;
      }
      // Moved onto a job and day that already has a line: the server refuses.
      if (next.jobId && (next.jobId !== e.jobId || next.workDate !== e.workDate) && lineOf(m, next.jobId, next.workDate, e.id)) {
        return;
      }
      addToWeek(m, e.workDate, -e.durationSeconds);
      addToWeek(m, next.workDate, next.durationSeconds);
      putEntry(m, next);
      return;
    }

    case "entry.delete": {
      const p = op.payload;
      // An id whose time joined a line names only part of it: refused.
      if (s.aliases.has(p.entryId)) return;
      const e = findEntry(m, p.entryId);
      if (!e || !isEditable(e.status)) return;
      // Notes that had become this entry are notes again (the server's rule: a
      // note is part of an entry only while the entry is live).
      const noteIds = m.notes.filter((n) => n.rolledIntoEntryId === e.id).map((n) => n.id);
      m.notes = m.notes.map((n) => (n.rolledIntoEntryId === e.id ? { ...n, rolledIntoEntryId: null } : n));
      s.deletedEntries.set(e.id, { entry: e, at: p.at, noteIds });
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
      m.notes = m.notes.map((n) => (deleted.noteIds.includes(n.id) ? { ...n, rolledIntoEntryId: e.id } : n));
      return;
    }

    case "note.create": {
      const p = op.payload;
      if (m.notes.some((n) => n.id === p.noteId)) return;
      if (workDateOf(p.at, m.timezone) !== m.workDate) return;
      m.notes.push({
        id: p.noteId,
        at: p.at,
        kind: p.kind ?? "note",
        text: p.kind === "start" ? "" : (p.text ?? "").trim(),
        jobId: p.jobId ?? null,
        jobName: p.jobId ? jobName(m, p.jobId) : null,
        rolledIntoEntryId: null,
        keptInAccounting: false,
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
      // Rolling up the day that was holding this one back frees it — as
      // far as this copy can tell; the server's next copy is the word.
      if (m.notesToRollUp?.date === p.workDate) m.notesToRollUp = null;
      if (p.workDate !== m.workDate) return;
      for (const line of p.lines) {
        if (findEntry(m, resolve(s, line.entryId))) continue;
        const spanned = line.startedAt != null && line.endedAt != null;
        const seconds = spanned ? Math.round((line.endedAt! - line.startedAt!) / 1000) : line.durationSeconds!;
        // The job already has hours that day: these join them.
        const existing = lineOf(m, line.jobId, p.workDate, line.entryId);
        if (existing) {
          const added = addTo(
            m,
            existing,
            spanned ? { startedAt: line.startedAt!, endedAt: line.endedAt!, note: line.note } : { seconds, note: line.note },
          );
          if (!added) continue;
          s.aliases.set(line.entryId, added.id);
          touchRecent(m, line.jobId);
          m.notes = m.notes.map((n) => (line.noteIds.includes(n.id) ? { ...n, rolledIntoEntryId: added.id } : n));
          continue;
        }
        if (seconds <= 0) continue;
        putEntry(m, {
          id: line.entryId,
          jobId: line.jobId,
          jobName: jobName(m, line.jobId),
          workDate: p.workDate,
          note: cleanNote(line.note) ?? null,
          source: "note_rollup",
          status: "draft",
          durationSeconds: seconds,
          untimedSeconds: spanned ? 0 : seconds,
          startedAt: spanned ? line.startedAt! : null,
          endedAt: spanned ? line.endedAt! : null,
          runningSince: null,
          lastEndedAt: spanned ? line.endedAt! : null,
          segmentCount: spanned ? 1 : 0,
          noteRequired: false,
          adminApproved: false,
          heldBy: null,
        });
        addToWeek(m, p.workDate, seconds);
        touchRecent(m, line.jobId);
        m.notes = m.notes.map((n) => (line.noteIds.includes(n.id) ? { ...n, rolledIntoEntryId: line.entryId } : n));
      }
      return;
    }

    case "entry.unmerge": {
      const p = op.payload;
      const e = findEntry(m, resolve(s, p.entryId));
      if (!e || !isEditable(e.status)) return;
      const untimed = e.untimedSeconds ?? 0;
      const fromUntimed = Math.min(untimed, p.removeSeconds ?? 0);
      const fromSegment =
        p.removeSegment?.endedAt != null ? Math.round((p.removeSegment.endedAt - p.removeSegment.startedAt) / 1000) : 0;
      const next: EntryView = {
        ...e,
        durationSeconds: Math.max(0, e.durationSeconds - fromUntimed - fromSegment),
        untimedSeconds: untimed - fromUntimed,
        segmentCount: p.removeSegment ? Math.max(0, e.segmentCount - 1) : e.segmentCount,
      };
      const note = cleanNote(p.note);
      if (note !== undefined) next.note = note;
      addToWeek(m, e.workDate, next.durationSeconds - e.durationSeconds);
      putEntry(m, next);
      if (p.releaseNoteIds?.length) {
        const free = new Set(p.releaseNoteIds);
        m.notes = m.notes.map((n) => (free.has(n.id) && n.rolledIntoEntryId === e.id ? { ...n, rolledIntoEntryId: null } : n));
      }
      return;
    }

    case "entry.combine": {
      const p = op.payload;
      const into = findEntry(m, resolve(s, p.intoEntryId));
      if (!into) return;
      const others: EntryView[] = [];
      for (const id of new Set(p.entryIds.map((x) => resolve(s, x)))) {
        if (id === into.id) continue;
        const o = findEntry(m, id);
        if (!o) return;
        others.push(o);
      }
      if (others.length === 0) return;
      const all = [into, ...others];
      if (all.some((e) => e.jobId !== into.jobId || e.workDate !== into.workDate || e.status === "open" || !isEditable(e.status))) {
        return;
      }
      const min = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.min(a, b));
      const max = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));
      let combined: EntryView = { ...into, untimedSeconds: into.untimedSeconds ?? 0 };
      for (const o of others) {
        combined = {
          ...combined,
          note: joinDescriptions(combined.note, o.note),
          durationSeconds: combined.durationSeconds + o.durationSeconds,
          untimedSeconds: (combined.untimedSeconds ?? 0) + (o.untimedSeconds ?? 0),
          segmentCount: combined.segmentCount + o.segmentCount,
          startedAt: min(combined.startedAt, o.startedAt),
          endedAt: max(combined.endedAt, o.endedAt),
          lastEndedAt: max(combined.lastEndedAt, o.lastEndedAt),
        };
      }
      if (combined.durationSeconds > MAX_ENTRY_SECONDS || (combined.note && combined.note.length > NOTE_MAX_LENGTH)) return;
      for (const o of others) {
        m.entries = m.entries.filter((x) => x.id !== o.id);
        m.notes = m.notes.map((n) => (n.rolledIntoEntryId === o.id ? { ...n, rolledIntoEntryId: into.id } : n));
        s.aliases.set(o.id, into.id);
      }
      putEntry(m, combined);
      return;
    }

    case "day.submit": {
      const { workDate } = op.payload;
      // Submitting takes every stopped entry on the day, so the day stops
      // being one that's waiting — whether or not it's the day on screen.
      m.unsubmittedDays = m.unsubmittedDays.filter((d) => d !== workDate);
      // A running timer isn't submitted; the server skips it and says so, and
      // submitting again after it stops picks it up.
      if (workDate !== m.workDate) return;
      m.entries = m.entries.map((e) => (e.status === "draft" ? { ...e, status: "submitted" } : e));
      return;
    }

    case "day.unsubmit": {
      const { workDate } = op.payload;
      if (workDate !== m.workDate) {
        // Another day's entries aren't in this copy; all that can be said is
        // that it has time waiting again.
        if (!m.unsubmittedDays.includes(workDate)) {
          m.unsubmittedDays = [...m.unsubmittedDays, workDate].sort().reverse();
        }
        // Draft time isn't sent, so it isn't held either.
        m.heldDays = m.heldDays.filter((d) => d !== workDate);
        return;
      }
      m.entries = m.entries.map((e) =>
        isOwnerReopenable(e.status, e.adminApproved) ? { ...e, status: "draft" } : e,
      );
      return;
    }

    case "duplicate.resolve": {
      const p = op.payload;
      const e = findEntry(m, p.entryId);
      if (!e?.heldBy) return;
      if (p.action === "discard") {
        // The person's own submission is taken back and the entry deleted;
        // an admin's approval stops it, as it stops any reopening. (An admin
        // acting for them may delete it anyway — the server says so, and the
        // fresh copy shows it.)
        if (e.status !== "draft" && !isOwnerReopenable(e.status, e.adminApproved)) return;
        // Its notes are settled by the record kept there, not hours to make again.
        m.notes = m.notes.map((n) =>
          n.rolledIntoEntryId === e.id ? { ...n, rolledIntoEntryId: null, keptInAccounting: true } : n,
        );
        m.entries = m.entries.filter((x) => x.id !== e.id);
        if (m.open?.id === e.id) m.open = null;
        addToWeek(m, e.workDate, -e.durationSeconds);
        return;
      }
      // Replaced, sent as well, or to be looked at again: no longer waiting on anyone here.
      putEntry(m, { ...e, heldBy: null });
      return;
    }
  }
}
