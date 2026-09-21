/**
 * How a job's place in the tree is written for people.
 *
 * Accounting systems join a customer and its jobs with ":" — "Riverside:Phase
 * 1:Deck" — and that is how full names are stored, sent to QuickBooks and
 * written to the CSV. It is not how they are shown: on screen a job is its own
 * name, with where it sits either drawn as nesting, set beneath it, or written
 * out with "›" when only one line is going.
 */

/** Between the steps of a path on screen. Never ":". */
export const PATH_SEPARATOR = " › ";

/** The steps of a "Customer:Job:Sub" full name, outermost first. */
export function jobPathParts(fullName: string): string[] {
  return fullName.split(":");
}

/**
 * A job's own name, and the place above it — null for a customer, which has
 * nothing above it. For two lines: the name to read, and where it sits.
 */
export function jobPath(fullName: string): { name: string; above: string | null } {
  const parts = jobPathParts(fullName);
  const name = parts.pop() ?? fullName;
  return { name, above: parts.length > 0 ? parts.join(PATH_SEPARATOR) : null };
}

/** The whole path on one line: "Riverside › Phase 1 › Deck". */
export function jobLabel(fullName: string): string {
  return jobPathParts(fullName).join(PATH_SEPARATOR);
}
