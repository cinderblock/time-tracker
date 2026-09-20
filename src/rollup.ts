/**
 * Turning a day's notes into time.
 *
 * Each note means "from here on, I'm doing this". So a note's line runs until
 * the next note, and the last one until an end time the person confirms.
 * Consecutive notes on the same job merge into one line. A start marker (a
 * note with no words, made when a job is added to the day) is a note like
 * any other here: it starts its job's run and ends the previous one. A note
 * with no job yields a line with no job, which must be given one (or dropped)
 * before committing — a lunch break is a perfectly good reason to drop it.
 *
 * What gets committed is one line per job: a span, or just a duration on the
 * day (how the per-job "turn into hours" step works — the timeline suggests
 * the hours, the person confirms them).
 *
 * Pure and dependency-free: the tracking screen runs it in the browser, and
 * the server re-validates whatever the person finally commits.
 */

export interface RollupNote {
  id: string;
  at: number;
  /** Empty for a start marker. */
  text: string;
  jobId: string | null;
}

export interface RollupLine {
  /** Stable key for UI lists: the first note's id. */
  key: string;
  jobId: string | null;
  startedAt: number;
  endedAt: number;
  noteIds: string[];
  /** The notes' words, joined, as the entry's note. */
  note: string;
}

export function proposeRollup(notes: readonly RollupNote[], endAt: number): RollupLine[] {
  const sorted = [...notes].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const lines: RollupLine[] = [];

  for (const n of sorted) {
    const current = lines.at(-1);
    if (current && current.jobId != null && current.jobId === n.jobId) {
      current.noteIds.push(n.id);
      current.note = joinNotes([current.note, n.text]);
      continue;
    }
    if (current) current.endedAt = n.at;
    lines.push({ key: n.id, jobId: n.jobId, startedAt: n.at, endedAt: n.at, noteIds: [n.id], note: n.text });
  }

  const last = lines.at(-1);
  if (last) last.endedAt = Math.max(endAt, last.startedAt);
  return lines;
}

/** Notes' words as one description; markers and blanks contribute nothing. */
export function joinNotes(texts: readonly string[]): string {
  return texts
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .join("; ");
}

export const MAX_LINE_SECONDS = 24 * 3600;

/** A line as it is committed: a span on the day, or just a duration. */
export interface CommitLine {
  jobId: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  durationSeconds?: number | null;
}

/** Problems that would stop a set of lines from being committed, in plain words. */
export function rollupProblems(lines: readonly CommitLine[]): string[] {
  const problems: string[] = [];
  if (lines.length === 0) problems.push("There's nothing to add.");
  if (lines.some((l) => l.jobId == null)) problems.push("Every line needs a job (or remove the line).");

  const spans = lines.filter((l) => l.startedAt != null && l.endedAt != null);
  const durations = lines.filter((l) => l.startedAt == null && l.endedAt == null);
  if (spans.length + durations.length < lines.length) problems.push("A line needs both a start and an end, or a duration.");
  if (spans.some((l) => l.endedAt! <= l.startedAt!)) problems.push("Every line must end after it starts.");
  if (durations.some((l) => !(l.durationSeconds! > 0))) problems.push("Every line needs some time.");
  if (
    spans.some((l) => l.endedAt! - l.startedAt! > MAX_LINE_SECONDS * 1000) ||
    durations.some((l) => l.durationSeconds! > MAX_LINE_SECONDS)
  ) {
    problems.push("A line can't be longer than 24 hours.");
  }

  const sorted = [...spans].sort((a, b) => a.startedAt! - b.startedAt!);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.startedAt! < sorted[i - 1]!.endedAt!) {
      problems.push("Two lines overlap.");
      break;
    }
  }
  return problems;
}
