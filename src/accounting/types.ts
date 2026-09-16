/**
 * The seam between this app and whatever accounting system it feeds.
 *
 * The app core deals in *jobs*, *people*, *items* and *sending approved
 * time*, expressed as the requests and results below. How a request reaches
 * the accounting system — and what language it's spoken in there — belongs to
 * the backend. (Both QuickBooks backends encode with `qbxml.ts`.)
 *
 * Direction of truth:
 *   - The backend owns the job / person / item lists. We cache them.
 *   - We own everything about time. Start and stop times, pauses, locations,
 *     notes and approval state have no representation in QuickBooks, which
 *     stores only a date plus a duration. Never read time back out of it,
 *     except to find a record we sent.
 */

import type { AccountingBackendKind } from "../config.server.ts";

/** A customer or customer:job in the accounting system. */
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
 * an Other Name own a time record, and only Employees take payroll items — so
 * the kind travels with the person.
 */
export interface RemotePerson {
  remoteId: string;
  name: string;
  kind: "employee" | "vendor" | "other";
  active: boolean;
}

/** A service item (what the work was) or a wage payroll item (how it's paid). */
export interface RemoteItem {
  remoteId: string;
  kind: "service" | "payroll_wage";
  name: string;
  fullName: string;
  active: boolean;
}

/** One entry, flattened into what the accounting system stores. */
export interface TimeRecord {
  /** Wall-clock date, 'YYYY-MM-DD'. The accounting system has no timezone here. */
  txnDate: string;
  personRemoteId: string;
  jobRemoteId: string | null;
  serviceItemRemoteId: string | null;
  payrollItemRemoteId: string | null;
  minutes: number;
  /** Ends with the entry's reference (sync.ts `entryRef`), so the record can be found again. */
  notes: string;
  billable: boolean;
}

export type SyncRequest =
  /** Is the accounting system there and answering? */
  | { type: "ping" }
  /** Every job, person and item. */
  | { type: "pull" }
  | { type: "time.add"; record: TimeRecord }
  | { type: "time.mod"; txnId: string; editSequence: string; record: TimeRecord }
  /** Records for one person on one date, or one record by id. */
  | { type: "time.find"; by: { txnDate: string; personRemoteId: string } | { txnId: string } }
  | { type: "time.delete"; txnId: string }
  | { type: "job.add"; name: string; parentRemoteId: string | null };

export interface FoundTime {
  txnId: string;
  editSequence: string;
  notes: string;
  minutes: number;
}

export interface PulledLists {
  jobs: RemoteJob[];
  people: RemotePerson[];
  items: RemoteItem[];
  /** Lists that couldn't be read (payroll switched off, say). Their cached copies are kept. */
  skipped: string[];
}

export type SyncResult =
  | { ok: true; type: "pong"; product: string }
  | { ok: true; type: "pull"; lists: PulledLists }
  | { ok: true; type: "time.saved"; txnId: string; editSequence: string }
  | { ok: true; type: "time.found"; records: FoundTime[] }
  | { ok: true; type: "deleted" }
  | { ok: true; type: "job.added"; job: RemoteJob }
  | SyncFailure;

export interface SyncFailure {
  ok: false;
  /** The accounting system's status code, or -1 when its answer couldn't be read. */
  code: number;
  message: string;
  /** Worth trying again soon, unchanged (the record was busy, say). */
  retryable: boolean;
  /** The record we pointed at isn't there any more. */
  missing: boolean;
  /** Our copy of the record's version is stale: someone changed it there. */
  stale: boolean;
  /** The name is already taken. */
  duplicate: boolean;
}

/** One request carried out: its outcome, and the raw exchange for the attempt log. */
export interface Performed {
  result: SyncResult;
  request: string;
  response: string;
}

export interface BackendHealth {
  ok: boolean;
  /** Human-readable, shown to admins. Say *why* it's down, not just that. */
  detail: string;
}

export interface AccountingBackend {
  readonly kind: AccountingBackendKind;

  /**
   * How work reaches the accounting system:
   *   none  — it doesn't; approved time stays here.
   *   push  — the app sends each request when it likes (`perform`).
   *   poll  — the accounting side asks for work (the Web Connector), so
   *           requests wait for it.
   */
  readonly delivery: "none" | "push" | "poll";

  /**
   * Cheap liveness probe. Expected to fail routinely — the QB Bridge only
   * listens while QuickBooks Desktop has the company file open — so callers
   * must treat "down" as normal and never let it block time tracking.
   */
  health(): Promise<BackendHealth>;

  /**
   * Push delivery: carry out one request now. Throws `BackendUnreachableError`
   * when the system can't be reached or isn't set up to answer — that says
   * nothing about the request itself.
   */
  perform(request: SyncRequest): Promise<Performed>;
}

/** Thrown when a backend is selected but cannot be built from the config. */
export class BackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendUnavailableError";
  }
}

/** The accounting system couldn't be reached, or refused us before looking at the request. */
export class BackendUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendUnreachableError";
  }
}
