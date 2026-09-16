/**
 * Time entry states, shared by the server and the browser (which mirrors the
 * server's rules offline), so this module must stay dependency-free.
 *
 *   open         a timer that hasn't been stopped (running or paused)
 *   draft        stopped, or entered by hand; its owner can still change it
 *   submitted    reserved for an employee "submit" step; not used yet
 *   approved     an admin has signed it off; locked until reopened
 *   synced       approved and recorded in the accounting system
 *   sync_failed  approved, but the accounting system refused it
 */
export type EntryStatus = "open" | "draft" | "submitted" | "approved" | "synced" | "sync_failed";

/** States in which an entry can be edited or deleted — by anyone, admins included. */
export const EDITABLE_STATUSES: ReadonlySet<EntryStatus> = new Set(["open", "draft"]);

/**
 * States an admin can take back to draft. Time already sent keeps its link to
 * the accounting system's record, so approving it again amends that record.
 */
export const REOPENABLE_STATUSES: ReadonlySet<EntryStatus> = new Set(["submitted", "approved", "synced", "sync_failed"]);

/** Signed off: approved, whether or not it has reached the accounting system yet. */
export const APPROVED_STATUSES: ReadonlySet<EntryStatus> = new Set(["approved", "synced", "sync_failed"]);

export function isEditable(status: EntryStatus): boolean {
  return EDITABLE_STATUSES.has(status);
}

/** Why an entry can't be changed, in words for the person trying. */
export function lockedReason(status: EntryStatus): string {
  switch (status) {
    case "synced":
      return "This time has been approved and sent to accounting. Ask an admin to reopen it to make changes.";
    case "submitted":
      return "This time has been submitted and can't be changed until it's reopened.";
    default:
      return "This time has been approved. Ask an admin to reopen it to make changes.";
  }
}
