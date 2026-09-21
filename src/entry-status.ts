/**
 * Time entry states, shared by the server and the browser (which mirrors the
 * server's rules offline), so this module must stay dependency-free.
 *
 *   open         a timer that hasn't been stopped (running or paused)
 *   draft        stopped, or entered by hand; its owner can still change it
 *   submitted    its owner says it's done; the rate is frozen and it's locked
 *   approved     an admin has signed it off as well; only when approval is required
 *   synced       recorded in the accounting system
 *   sync_failed  sent, but the accounting system refused it
 *
 * Submitting is the step that makes time final. Approval is an organisation's
 * option on top of it (the `require_approval` setting): off, submitted time is
 * sent as it is; on, it waits for an admin. Nothing in this module reads that
 * setting — it takes it as an argument, because the browser imports this too.
 */
export type EntryStatus = "open" | "draft" | "submitted" | "approved" | "synced" | "sync_failed";

/** States in which an entry can be edited or deleted — by anyone, admins included. */
export const EDITABLE_STATUSES: ReadonlySet<EntryStatus> = new Set(["open", "draft"]);

/**
 * States an admin can take back to draft. Time already sent keeps its link to
 * the accounting system's record, so submitting it again amends that record.
 */
export const REOPENABLE_STATUSES: ReadonlySet<EntryStatus> = new Set(["submitted", "approved", "synced", "sync_failed"]);

/**
 * Final: submitted, and everything after it. This is the set that counts as
 * "signed off" in reports and on the calendar, because with approval switched
 * off `approved` is a state time never passes through.
 */
export const SIGNED_OFF_STATUSES: ReadonlySet<EntryStatus> = new Set([
  "submitted",
  "approved",
  "synced",
  "sync_failed",
]);

/** An admin has signed it off, whether or not it has reached accounting yet. */
export const APPROVED_STATUSES: ReadonlySet<EntryStatus> = new Set(["approved", "synced", "sync_failed"]);

export function isEditable(status: EntryStatus): boolean {
  return EDITABLE_STATUSES.has(status);
}

/** Time in a state the sync may send, given whether approval is required. */
export function sendableStatuses(requireApproval: boolean): readonly EntryStatus[] {
  // `approved` is sendable either way: an organisation can switch approval off
  // with time already approved under it, and that time still has to go.
  return requireApproval ? ["approved", "sync_failed"] : ["submitted", "approved", "sync_failed"];
}

/**
 * Whether the person whose time this is may take it back themselves, rather
 * than asking an admin. Their own submission is theirs to withdraw; once
 * someone else has approved it, it isn't.
 *
 * `adminApproved` is "an admin has approved this at some point" — the server
 * reads it from `approved_by`, which a reopen clears. With approval switched
 * off nothing ever sets it, so people can always correct their own time.
 */
export function isOwnerReopenable(status: EntryStatus, adminApproved: boolean): boolean {
  return !adminApproved && REOPENABLE_STATUSES.has(status);
}

/**
 * Why an entry can't be changed, in words for the person trying. `canTakeBack`
 * says whether they can undo it themselves — if they can, point them at that
 * rather than at an admin.
 */
export function lockedReason(status: EntryStatus, canTakeBack = false): string {
  if (canTakeBack) {
    return status === "submitted"
      ? "This time has been submitted. Take the day back to change it."
      : "This time has been submitted and sent to accounting. Take the day back to change it.";
  }
  switch (status) {
    case "synced":
      return "This time has been approved and sent to accounting. Ask an admin to reopen it to make changes.";
    case "submitted":
      return "This time has been submitted and can't be changed until it's reopened.";
    default:
      return "This time has been approved. Ask an admin to reopen it to make changes.";
  }
}
