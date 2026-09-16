/**
 * The seam between this app and whatever accounting system it feeds.
 *
 * The app core deals in *jobs*, *people*, *service items* and *pushing approved
 * time*. It must never learn what qbXML is. Everything QuickBooks-shaped lives
 * behind this interface so a second backend (Web Connector) — or none at all —
 * is a matter of picking a different implementation.
 *
 * Direction of truth:
 *   - The backend owns the job / person / service-item lists. We cache them.
 *   - We own everything about time. Start and stop times, pauses, locations,
 *     notes and approval state have no representation in QuickBooks, which
 *     stores only a date plus a duration. Never read time back out of it.
 */

/** A Customer or Customer:Job in the accounting system. */
export interface RemoteJob {
  /** Stable backend identifier (QuickBooks ListID). */
  remoteId: string;
  /** Leaf name, e.g. "Phase 2". */
  name: string;
  /** Fully qualified path, e.g. "Acme Corp:Building 4:Phase 2". */
  fullName: string;
  parentRemoteId: string | null;
  active: boolean;
}

/**
 * Someone time can be booked against. QuickBooks lets an Employee, a Vendor or
 * an Other Name own a TimeTracking record, and the choice changes how payroll
 * treats it — so the kind travels with the person.
 */
export interface RemotePerson {
  remoteId: string;
  name: string;
  kind: "employee" | "vendor" | "other";
  active: boolean;
}

export interface RemoteServiceItem {
  remoteId: string;
  name: string;
  fullName: string;
  active: boolean;
}

export interface RemotePayrollItem {
  remoteId: string;
  name: string;
}

/** A time entry flattened into what the backend can actually store. */
export interface PushableTimeEntry {
  /** Our `time_entries.id`, echoed back for correlation. */
  localId: string;
  /** Wall-clock date, 'YYYY-MM-DD'. QuickBooks has no timezone here. */
  workDate: string;
  personRemoteId: string;
  jobRemoteId: string | null;
  serviceItemRemoteId: string | null;
  payrollItemRemoteId: string | null;
  durationSeconds: number;
  note: string | null;
  billable: boolean;
}

/** Identifies an already-pushed record so it can be amended or removed. */
export interface RemoteRef {
  txnId: string;
  editSequence: string | null;
}

export type PushResult =
  | { localId: string; ok: true; remote: RemoteRef }
  | { localId: string; ok: false; error: string; retryable: boolean };

export interface BackendHealth {
  ok: boolean;
  /** Human-readable, shown to admins. Say *why* it's down, not just that. */
  detail: string;
}

export interface AccountingBackend {
  readonly kind: string;

  /**
   * Cheap liveness probe. Expected to fail routinely — the QB Bridge only
   * listens while QuickBooks Desktop has the company file open — so callers
   * must treat "down" as normal and never let it block time tracking.
   */
  health(): Promise<BackendHealth>;

  listJobs(): Promise<RemoteJob[]>;
  listPeople(): Promise<RemotePerson[]>;
  listServiceItems(): Promise<RemoteServiceItem[]>;
  listPayrollItems(): Promise<RemotePayrollItem[]>;

  pushTime(entries: PushableTimeEntry[]): Promise<PushResult[]>;
  updateTime(entry: PushableTimeEntry, remote: RemoteRef): Promise<PushResult>;
  deleteTime(remote: RemoteRef): Promise<PushResult>;
}

/** Thrown when a backend is selected but cannot be built from the config. */
export class BackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendUnavailableError";
  }
}
