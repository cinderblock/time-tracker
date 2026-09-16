/**
 * Turning a day's sporadic notes into time entries.
 *
 * Each note means "from here on, I'm doing this". So a note's line runs until
 * the next note, and the last one until an end time the person confirms.
 * Consecutive notes on the same job merge into one line. A note with no job
 * yields a line with no job, which must be given one (or dropped) before
 * committing — a lunch break is a perfectly good reason to drop it.
 *
 * Pure and dependency-free: the review screen runs it in the browser, and the
 * server re-validates whatever the person finally commits.
 */

export interface RollupNote {
  id: string;
  at: number;
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
  /** The notes' texts, joined, as the entry's note. */
  note: string;
}

export function proposeRollup(notes: readonly RollupNote[], endAt: number): RollupLine[] {
  const sorted = [...notes].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const lines: RollupLine[] = [];

  for (const n of sorted) {
    const current = lines.at(-1);
    if (current && current.jobId != null && current.jobId === n.jobId) {
      current.noteIds.push(n.id);
      current.note = `${current.note}; ${n.text}`;
      continue;
    }
    if (current) current.endedAt = n.at;
    lines.push({ key: n.id, jobId: n.jobId, startedAt: n.at, endedAt: n.at, noteIds: [n.id], note: n.text });
  }

  const last = lines.at(-1);
  if (last) last.endedAt = Math.max(endAt, last.startedAt);
  return lines;
}

/** Problems that would stop a set of lines from being committed, in plain words. */
export function rollupProblems(lines: readonly Pick<RollupLine, "jobId" | "startedAt" | "endedAt">[]): string[] {
  const problems: string[] = [];
  if (lines.length === 0) problems.push("There's nothing to add.");
  if (lines.some((l) => l.jobId == null)) problems.push("Every line needs a job (or remove the line).");
  if (lines.some((l) => l.endedAt <= l.startedAt)) problems.push("Every line must end after it starts.");
  const sorted = [...lines].sort((a, b) => a.startedAt - b.startedAt);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.startedAt < sorted[i - 1]!.endedAt) {
      problems.push("Two lines overlap.");
      break;
    }
  }
  return problems;
}
