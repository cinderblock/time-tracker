import { QB_NOTES_MAX_LENGTH, parseQbDuration, qbDuration, qbFailure } from "./qbxml.ts";
import {
  type AccountingBackend,
  type BackendHealth,
  BackendUnreachableError,
  type FoundTime,
  type Performed,
  type RemoteItem,
  type RemoteJob,
  type RemotePerson,
  type SyncRequest,
  type SyncResult,
  type TimeRecord,
} from "./types.ts";

/**
 * QuickBooks Desktop through the QB Bridge
 * (github.com/cinderblock/quickbooks-desktop-sdk-bridge): a REST service on
 * the QuickBooks machine that turns JSON into qbXML and back.
 *
 * This uses its entity routes — customers, employees, vendors, other-names,
 * items/service, payroll-items/wage and time-tracking (the last three need
 * the bridge from 2026-09-16 on). See docs/qb-bridge.md for the key's
 * permissions.
 *
 * "Can't reach the bridge", "the bridge refused our key" and "QuickBooks
 * couldn't be opened" are BackendUnreachableError: normal, retried later, and
 * never counted against the record being sent. Only QuickBooks' own answer
 * about a record (a qbXML status code) is a SyncFailure.
 */

export interface BridgeOptions {
  baseUrl: string;
  apiKey: string;
  /** How long to wait for an answer. The bridge may have to open the company file first. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

interface Answer {
  status: number;
  body: Json | null;
  /** "METHOD path" and the body sent, for the attempt log. */
  exchange: string;
  text: string;
}

/** Errors that mean QuickBooks itself couldn't be reached, not that it refused a record. */
const UNREACHABLE_QB_ERRORS = new Set(["QBConnectionError", "QBSessionError", "QBNotRunningError", "QBTimeoutError"]);

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const listId = (v: unknown): string | null => {
  const id = (v as Json | undefined)?.ListID;
  return id == null ? null : str(id);
};
const bool = (v: unknown) => str(v) !== "false";
const asList = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : v ? [v as Json] : []);

function errorOf(body: Json | null): { code: string; message: string; qbStatus: number | null } | null {
  // The bridge's own errors come as { error }, FastAPI's as { detail: { error } }.
  const error = ((body?.error ?? (body?.detail as Json | undefined)?.error) ?? null) as Json | null;
  if (!error) return null;
  const qb = error.qb_status_code;
  return { code: str(error.code), message: str(error.message), qbStatus: typeof qb === "number" ? qb : null };
}

function timeBody(r: TimeRecord): Json {
  const ref = (id: string | null) => (id ? { ListID: id } : undefined);
  // Keys in the order qbXML's TimeTrackingAdd defines; the bridge keeps it.
  return {
    TxnDate: r.txnDate,
    EntityRef: { ListID: r.personRemoteId },
    CustomerRef: ref(r.jobRemoteId),
    ItemServiceRef: ref(r.serviceItemRemoteId),
    Duration: qbDuration(r.minutes),
    PayrollItemWageRef: ref(r.payrollItemRemoteId),
    Notes: r.notes ? r.notes.slice(0, QB_NOTES_MAX_LENGTH) : undefined,
    BillableStatus: r.billable ? "Billable" : "NotBillable",
  };
}

function jobOf(ret: Json): RemoteJob {
  return {
    remoteId: str(ret.ListID),
    name: str(ret.Name),
    fullName: str(ret.FullName) || str(ret.Name),
    parentRemoteId: listId(ret.ParentRef),
    active: bool(ret.IsActive),
  };
}

function foundOf(ret: Json): FoundTime {
  return {
    txnId: str(ret.TxnID),
    editSequence: str(ret.EditSequence),
    notes: str(ret.Notes),
    minutes: parseQbDuration(str(ret.Duration)),
  };
}

export class QbBridgeBackend implements AccountingBackend {
  readonly kind = "qb-bridge" as const;
  readonly delivery = "push" as const;
  private readonly base: string;

  constructor(private readonly opts: BridgeOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
  }

  async health(): Promise<BackendHealth> {
    try {
      const { result } = await this.perform({ type: "ping" });
      if (result.ok && result.type === "pong") return { ok: true, detail: `Connected to ${result.product}.` };
      return { ok: false, detail: result.ok ? "Unexpected answer from the bridge." : `QuickBooks answered: ${result.message}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private async call(method: string, path: string, body?: Json): Promise<Answer> {
    const doFetch = this.opts.fetch ?? fetch;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const exchange = `${method} ${path}${payload ? ` ${payload}` : ""}`;
    let response: Response;
    try {
      response = await doFetch(`${this.base}${path}`, {
        method,
        headers: { "X-API-Key": this.opts.apiKey, ...(payload ? { "Content-Type": "application/json" } : {}) },
        body: payload,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new BackendUnreachableError(
        timedOut
          ? "The QB Bridge didn't answer in time."
          : `Can't reach the QB Bridge (${err instanceof Error ? err.message : String(err)}). Is it running on the QuickBooks computer?`,
      );
    }
    const text = await response.text();
    let parsed: Json | null = null;
    try {
      parsed = JSON.parse(text) as Json;
    } catch {
      // handled by the callers
    }
    return { status: response.status, body: parsed, exchange, text };
  }

  /**
   * Turn a non-success answer into a SyncFailure (QuickBooks refused the
   * record) or throw BackendUnreachableError (anything else).
   */
  private refusal(answer: Answer, path: string): SyncResult {
    const error = errorOf(answer.body);
    if (answer.status === 404 && !error) {
      throw new BackendUnreachableError(
        `The QB Bridge has no ${path.split("?")[0]} — it needs updating (time tracking arrived in the bridge on 2026-09-16).`,
      );
    }
    if (error?.qbStatus != null && !UNREACHABLE_QB_ERRORS.has(error.code)) {
      return qbFailure(error.qbStatus, error.message || `QuickBooks error ${error.qbStatus}`);
    }
    if (answer.status === 400 && error?.code === "UNKNOWN_QUERY_PARAM") {
      // A bridge from before 2026-09-18 answered /items/service with its
      // get-one-item route (id "service"), which takes no query string.
      return {
        ...qbFailure(-3, `The QB Bridge answered ${path.split("?")[0]} as a single record — it needs updating (route order fixed in the bridge on 2026-09-18).`),
        retryable: false,
      };
    }
    if (answer.status === 400 && error) {
      // Our request was malformed: a bug here, not an outage. Show it; don't retry soon.
      return { ...qbFailure(-3, `The QB Bridge rejected the request: ${error.message}`), retryable: false };
    }
    const why = error ? `${error.code}: ${error.message}` : `HTTP ${answer.status} ${answer.text.slice(0, 200)}`;
    throw new BackendUnreachableError(
      answer.status === 401 || answer.status === 403
        ? `The QB Bridge refused the request (${why}). Check QB_BRIDGE_API_KEY and its permissions.`
        : `The QB Bridge couldn't do it (${why}).`,
    );
  }

  /** Every record of a list entity, following the bridge's iterator where it has one. */
  private async list(path: string, iterator: boolean, log: string[]): Promise<{ rows: Json[] } | { failed: SyncResult }> {
    const rows: Json[] = [];
    let cursor: string | null = iterator ? "Start" : null;
    for (let page = 0; page < 1000; page++) {
      const query = new URLSearchParams({ active: "All", max_returned: iterator ? "1000" : "5000" });
      if (cursor) query.set("iterator_id", cursor);
      const target = `${path}?${query}`;
      const answer = await this.call("GET", target);
      log.push(`${answer.exchange} -> ${answer.status}`);
      if (answer.status !== 200 || answer.body?.ok !== true) return { failed: this.refusal(answer, target) };
      rows.push(...asList(answer.body.data));
      const meta = (answer.body.meta ?? {}) as Json;
      if (!iterator || !meta.iterator_id || !Number(meta.remaining)) break;
      cursor = str(meta.iterator_id);
    }
    return { rows };
  }

  async perform(request: SyncRequest): Promise<Performed> {
    switch (request.type) {
      case "ping": {
        const answer = await this.call("GET", "/api/v1/company");
        if (answer.status !== 200 || answer.body?.ok !== true) {
          return { result: this.refusal(answer, "/api/v1/company"), request: answer.exchange, response: answer.text };
        }
        const company = str((answer.body.data as Json | undefined)?.CompanyName);
        return {
          result: { ok: true, type: "pong", product: company ? `QuickBooks (${company})` : "QuickBooks" },
          request: answer.exchange,
          response: answer.text,
        };
      }

      case "pull": {
        const log: string[] = [];
        const skipped: string[] = [];
        const lists: Record<string, Json[]> = {};
        const sources: [key: string, path: string, iterator: boolean, optional: boolean][] = [
          ["customers", "/api/v1/customers", true, false],
          ["employees", "/api/v1/employees", false, false],
          ["vendors", "/api/v1/vendors", true, false],
          ["others", "/api/v1/other-names", false, true],
          // Optional: an older bridge can't list them (see refusal), and the
          // lists that let people link jobs and themselves shouldn't wait on it.
          ["services", "/api/v1/items/service", true, true],
          ["wages", "/api/v1/payroll-items/wage", false, true],
        ];
        for (const [key, path, iterator, optional] of sources) {
          const got = await this.list(path, iterator, log);
          if ("rows" in got) {
            lists[key] = got.rows;
            continue;
          }
          // Payroll can be switched off, and some files have no other names:
          // QuickBooks' refusal there doesn't stop the rest.
          if (optional && !got.failed.ok) {
            skipped.push(key);
            log.push(`${key} skipped: ${got.failed.message}`);
            lists[key] = [];
            continue;
          }
          return { result: got.failed, request: log.join("\n"), response: "" };
        }
        const people = (key: string, kind: RemotePerson["kind"]): RemotePerson[] =>
          (lists[key] ?? []).map((r) => ({ remoteId: str(r.ListID), name: str(r.Name), kind, active: bool(r.IsActive) }));
        const items = (key: string, kind: RemoteItem["kind"]): RemoteItem[] =>
          (lists[key] ?? []).map((r) => ({
            remoteId: str(r.ListID),
            kind,
            name: str(r.Name),
            fullName: str(r.FullName) || str(r.Name),
            active: bool(r.IsActive),
          }));
        const result: SyncResult = {
          ok: true,
          type: "pull",
          lists: {
            jobs: (lists.customers ?? []).map(jobOf),
            people: [...people("employees", "employee"), ...people("vendors", "vendor"), ...people("others", "other")],
            items: [...items("services", "service"), ...items("wages", "payroll_wage")],
            skipped,
          },
        };
        const counts = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length]));
        return { result, request: log.join("\n"), response: JSON.stringify({ counts, skipped }) };
      }

      case "time.add":
      case "time.mod": {
        const path =
          request.type === "time.add"
            ? "/api/v1/time-tracking"
            : `/api/v1/time-tracking/${encodeURIComponent(request.txnId)}`;
        const body =
          request.type === "time.add"
            ? timeBody(request.record)
            : { EditSequence: request.editSequence, ...timeBody(request.record) };
        const answer = await this.call(request.type === "time.add" ? "POST" : "PUT", path, body);
        const ret = answer.body?.data as Json | undefined;
        const result: SyncResult =
          (answer.status === 200 || answer.status === 201) && answer.body?.ok === true && ret
            ? { ok: true, type: "time.saved", txnId: str(ret.TxnID), editSequence: str(ret.EditSequence) }
            : this.refusal(answer, path);
        return { result, request: answer.exchange, response: answer.text };
      }

      case "time.find": {
        if ("txnId" in request.by) {
          const path = `/api/v1/time-tracking/${encodeURIComponent(request.by.txnId)}`;
          const answer = await this.call("GET", path);
          let result: SyncResult;
          if (answer.status === 200 && answer.body?.ok === true) {
            result = { ok: true, type: "time.found", records: asList(answer.body.data).map(foundOf) };
          } else if (answer.status === 404 && errorOf(answer.body)?.code === "NOT_FOUND") {
            result = { ok: true, type: "time.found", records: [] };
          } else {
            result = this.refusal(answer, path);
          }
          return { result, request: answer.exchange, response: answer.text };
        }
        // The bridge filters by person *name*; we know the ListID, so filter here.
        const { txnDate, personRemoteId } = request.by;
        const path = `/api/v1/time-tracking?${new URLSearchParams({ from_date: txnDate, to_date: txnDate, max_returned: "5000" })}`;
        const answer = await this.call("GET", path);
        const result: SyncResult =
          answer.status === 200 && answer.body?.ok === true
            ? {
                ok: true,
                type: "time.found",
                records: asList(answer.body.data)
                  .filter((r) => listId(r.EntityRef) === personRemoteId)
                  .map(foundOf),
              }
            : this.refusal(answer, path);
        return { result, request: answer.exchange, response: answer.text };
      }

      case "time.delete": {
        const path = `/api/v1/time-tracking/${encodeURIComponent(request.txnId)}`;
        const answer = await this.call("DELETE", path);
        const result: SyncResult =
          answer.status === 200 && answer.body?.ok === true ? { ok: true, type: "deleted" } : this.refusal(answer, path);
        return { result, request: answer.exchange, response: answer.text };
      }

      case "job.add": {
        const body: Json = { Name: request.name };
        if (request.parentRemoteId) body.ParentRef = { ListID: request.parentRemoteId };
        const answer = await this.call("POST", "/api/v1/customers", body);
        const ret = answer.body?.data as Json | undefined;
        const result: SyncResult =
          (answer.status === 200 || answer.status === 201) && answer.body?.ok === true && ret
            ? { ok: true, type: "job.added", job: jobOf(ret) }
            : this.refusal(answer, "/api/v1/customers");
        return { result, request: answer.exchange, response: answer.text };
      }
    }
  }
}
