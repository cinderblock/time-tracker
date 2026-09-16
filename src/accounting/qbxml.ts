import { XMLParser } from "fast-xml-parser";

import type { FoundTime, RemoteItem, RemoteJob, RemotePerson, SyncFailure, SyncRequest, SyncResult, TimeRecord } from "./types.ts";

/**
 * qbXML: the request/response language of QuickBooks Desktop, spoken by both
 * the Web Connector and (through its /qbxml endpoint) the QB Bridge. Only
 * the QuickBooks backends use this module.
 *
 * Written against qbXML 13.0, which every QuickBooks Desktop since 2014
 * understands. Element order matters to QuickBooks — it rejects a request
 * whose children are out of the order the SDK defines — so the builders below
 * keep that order deliberately.
 */

export const QBXML_VERSION = "13.0";

/** QuickBooks' limit on customer and job names. */
export const QB_NAME_MAX_LENGTH = 41;

/** QuickBooks' limit on a time record's notes. */
export const QB_NOTES_MAX_LENGTH = 4095;

// ---- building -----------------------------------------------------------------------

/**
 * Escape text for an element. Anything outside printable ASCII becomes a
 * numeric reference: older QuickBooks releases read requests as Windows-1252,
 * and a reference means the same thing whichever encoding they assume.
 * Control characters other than tab and newline aren't allowed in XML at all.
 */
export function xmlText(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else if (ch === "'") out += "&apos;";
    else if (code === 9 || code === 10) out += ch;
    else if (code === 13) out += "&#13;";
    else if (code < 32 || (code >= 0x7f && code < 0xa0)) continue;
    else if (code > 126) out += `&#${code};`;
    else out += ch;
  }
  return out;
}

const el = (name: string, value: string) => `<${name}>${xmlText(value)}</${name}>`;
const ref = (name: string, listId: string | null) => (listId ? `<${name}>${el("ListID", listId)}</${name}>` : "");

/** "PT1H30M0S" */
export function qbDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `PT${Math.floor(m / 60)}H${m % 60}M0S`;
}

/** Minutes in a qbXML duration ("PT1H30M0S", "PT90M", "PT1.5H"). */
export function parseQbDuration(text: string): number {
  const match = /^PT(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/.exec(text.trim());
  if (!match) return 0;
  const [, h = "0", m = "0", s = "0"] = match;
  return Math.round(Number(h) * 60 + Number(m) + Number(s) / 60);
}

function timeFields(r: TimeRecord): string {
  return [
    el("TxnDate", r.txnDate),
    ref("EntityRef", r.personRemoteId),
    ref("CustomerRef", r.jobRemoteId),
    ref("ItemServiceRef", r.serviceItemRemoteId),
    el("Duration", qbDuration(r.minutes)),
    ref("PayrollItemWageRef", r.payrollItemRemoteId),
    r.notes ? el("Notes", r.notes.slice(0, QB_NOTES_MAX_LENGTH)) : "",
    el("BillableStatus", r.billable ? "Billable" : "NotBillable"),
  ].join("");
}

const ALL = "<ActiveStatus>All</ActiveStatus>";
const include = (...names: string[]) => names.map((n) => `<IncludeRetElement>${n}</IncludeRetElement>`).join("");

/** Lists a pull can do without: their queries fail when the feature is switched off. */
const OPTIONAL_LISTS = ["wages", "others"];

function body(req: SyncRequest, id: string): string {
  const rid = xmlText(id);
  switch (req.type) {
    case "ping":
      return `<HostQueryRq requestID="${rid}"/>`;
    case "pull":
      return [
        `<CustomerQueryRq requestID="${rid}-customers">${ALL}${include("ListID", "Name", "FullName", "IsActive", "ParentRef")}</CustomerQueryRq>`,
        `<EmployeeQueryRq requestID="${rid}-employees">${ALL}${include("ListID", "Name", "IsActive")}</EmployeeQueryRq>`,
        `<VendorQueryRq requestID="${rid}-vendors">${ALL}${include("ListID", "Name", "IsActive")}</VendorQueryRq>`,
        `<OtherNameQueryRq requestID="${rid}-others">${ALL}${include("ListID", "Name", "IsActive")}</OtherNameQueryRq>`,
        `<ItemServiceQueryRq requestID="${rid}-services">${ALL}${include("ListID", "Name", "FullName", "IsActive")}</ItemServiceQueryRq>`,
        `<PayrollItemWageQueryRq requestID="${rid}-wages">${ALL}${include("ListID", "Name", "IsActive")}</PayrollItemWageQueryRq>`,
      ].join("");
    case "time.add":
      return `<TimeTrackingAddRq requestID="${rid}"><TimeTrackingAdd>${timeFields(req.record)}</TimeTrackingAdd></TimeTrackingAddRq>`;
    case "time.mod":
      return (
        `<TimeTrackingModRq requestID="${rid}"><TimeTrackingMod>` +
        `${el("TxnID", req.txnId)}${el("EditSequence", req.editSequence)}${timeFields(req.record)}` +
        `</TimeTrackingMod></TimeTrackingModRq>`
      );
    case "time.find":
      return "txnId" in req.by
        ? `<TimeTrackingQueryRq requestID="${rid}">${el("TxnID", req.by.txnId)}</TimeTrackingQueryRq>`
        : `<TimeTrackingQueryRq requestID="${rid}">` +
            `<TxnDateRangeFilter>${el("FromTxnDate", req.by.txnDate)}${el("ToTxnDate", req.by.txnDate)}</TxnDateRangeFilter>` +
            `<TimeTrackingEntityFilter>${el("ListID", req.by.personRemoteId)}</TimeTrackingEntityFilter>` +
            `</TimeTrackingQueryRq>`;
    case "time.delete":
      return `<TxnDelRq requestID="${rid}"><TxnDelType>TimeTracking</TxnDelType>${el("TxnID", req.txnId)}</TxnDelRq>`;
    case "job.add":
      return `<CustomerAddRq requestID="${rid}"><CustomerAdd>${el("Name", req.name)}${ref("ParentRef", req.parentRemoteId)}</CustomerAdd></CustomerAddRq>`;
  }
}

/**
 * A complete qbXML request document. A pull carries on past a failed query
 * (see OPTIONAL_LISTS); everything else is a single request.
 */
export function buildRequest(req: SyncRequest, requestId: string): string {
  const onError = req.type === "pull" ? "continueOnError" : "stopOnError";
  return (
    `<?xml version="1.0" encoding="utf-8"?><?qbxml version="${QBXML_VERSION}"?>` +
    `<QBXML><QBXMLMsgsRq onError="${onError}">${body(req, requestId)}</QBXMLMsgsRq></QBXML>`
  );
}

// ---- parsing ------------------------------------------------------------------------

const LISTS = [
  "CustomerRet",
  "EmployeeRet",
  "VendorRet",
  "OtherNameRet",
  "ItemServiceRet",
  "PayrollItemWageRet",
  "TimeTrackingRet",
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Decodes the numeric character references QuickBooks uses for non-ASCII.
  htmlEntities: true,
  isArray: (name) => LISTS.includes(name),
});

type Node = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const listId = (node: unknown): string | null => {
  const id = (node as Node | undefined)?.ListID;
  return id == null ? null : str(id);
};
const bool = (v: unknown) => str(v) !== "false";

// Status codes (QuickBooks SDK): 1 = query matched nothing; 3100 = name
// already in use; 3120 = object not found; 3200 = EditSequence out of date;
// 3170/3175/3176/3180 = record or list busy, in use by another user.
const RETRYABLE = new Set([3170, 3175, 3176, 3180]);

export function qbFailure(code: number, message: string): SyncFailure {
  return {
    ok: false,
    code,
    message,
    retryable: code === -1 || RETRYABLE.has(code),
    missing: code === 3120,
    stale: code === 3200,
    duplicate: code === 3100,
  };
}

interface Response {
  name: string;
  requestId: string;
  code: number;
  severity: string;
  message: string;
  node: Node;
}

/** The response elements, in order. */
function responses(xml: string): Response[] | SyncFailure {
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch (err) {
    return qbFailure(-1, `Couldn't read QuickBooks' answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  const msgs = (doc.QBXML as Node | undefined)?.QBXMLMsgsRs;
  if (!msgs || typeof msgs !== "object") return qbFailure(-1, "QuickBooks' answer had no responses in it.");
  const out: Response[] = [];
  for (const [name, value] of Object.entries(msgs as Node)) {
    if (name.startsWith("@_")) continue;
    for (const raw of Array.isArray(value) ? value : [value]) {
      const node = (raw ?? {}) as Node;
      out.push({
        name,
        node,
        requestId: str(node["@_requestID"]),
        code: Number(node["@_statusCode"] ?? -1),
        severity: str(node["@_statusSeverity"]),
        message: str(node["@_statusMessage"]),
      });
    }
  }
  return out;
}

/** Code 0 is success and 1 means a query matched nothing; anything else at Error severity failed. */
const failed = (r: Response) => r.code !== 0 && r.code !== 1 && r.severity !== "Info" && r.severity !== "Warn";

function jobOf(ret: Node): RemoteJob {
  return {
    remoteId: str(ret.ListID),
    name: str(ret.Name),
    fullName: str(ret.FullName) || str(ret.Name),
    parentRemoteId: listId(ret.ParentRef),
    active: bool(ret.IsActive),
  };
}

export function parseResponse(req: SyncRequest, xml: string): SyncResult {
  const list = responses(xml);
  if (!Array.isArray(list)) return list;
  if (list.length === 0) return qbFailure(-1, "QuickBooks' answer had no responses in it.");

  const suffix = (r: Response) => r.requestId.slice(r.requestId.lastIndexOf("-") + 1);
  const skipped: string[] = [];
  for (const r of list) {
    if (!failed(r)) continue;
    if (req.type === "pull" && OPTIONAL_LISTS.includes(suffix(r))) {
      skipped.push(suffix(r));
      continue;
    }
    return qbFailure(r.code, r.message || `QuickBooks error ${r.code}`);
  }

  const rets = (name: string) => list.flatMap((r) => (r.node[name] as Node[] | undefined) ?? []);

  switch (req.type) {
    case "ping": {
      const host = list[0]!.node.HostRet as Node | undefined;
      return { ok: true, type: "pong", product: str(host?.ProductName) || "QuickBooks" };
    }
    case "pull": {
      const people = (name: string, kind: RemotePerson["kind"]): RemotePerson[] =>
        rets(name).map((r) => ({ remoteId: str(r.ListID), name: str(r.Name), kind, active: bool(r.IsActive) }));
      const items = (name: string, kind: RemoteItem["kind"]): RemoteItem[] =>
        rets(name).map((r) => ({
          remoteId: str(r.ListID),
          kind,
          name: str(r.Name),
          fullName: str(r.FullName) || str(r.Name),
          active: bool(r.IsActive),
        }));
      return {
        ok: true,
        type: "pull",
        lists: {
          jobs: rets("CustomerRet").map(jobOf),
          people: [
            ...people("EmployeeRet", "employee"),
            ...people("VendorRet", "vendor"),
            ...people("OtherNameRet", "other"),
          ],
          items: [...items("ItemServiceRet", "service"), ...items("PayrollItemWageRet", "payroll_wage")],
          skipped,
        },
      };
    }
    case "time.add":
    case "time.mod": {
      const ret = rets("TimeTrackingRet")[0];
      if (!ret) return qbFailure(-1, "QuickBooks didn't return the saved record.");
      return { ok: true, type: "time.saved", txnId: str(ret.TxnID), editSequence: str(ret.EditSequence) };
    }
    case "time.find":
      return {
        ok: true,
        type: "time.found",
        records: rets("TimeTrackingRet").map(
          (r): FoundTime => ({
            txnId: str(r.TxnID),
            editSequence: str(r.EditSequence),
            notes: str(r.Notes),
            minutes: parseQbDuration(str(r.Duration)),
          }),
        ),
      };
    case "time.delete":
      return { ok: true, type: "deleted" };
    case "job.add": {
      const ret = rets("CustomerRet")[0];
      if (!ret) return qbFailure(-1, "QuickBooks didn't return the new job.");
      return { ok: true, type: "job.added", job: jobOf(ret) };
    }
  }
}

/** The request types a pull or push can send — what a bridge must allow, and nothing more. */
export const QBXML_REQUEST_TYPES = [
  "HostQueryRq",
  "CustomerQueryRq",
  "EmployeeQueryRq",
  "VendorQueryRq",
  "OtherNameQueryRq",
  "ItemServiceQueryRq",
  "PayrollItemWageQueryRq",
  "TimeTrackingAddRq",
  "TimeTrackingModRq",
  "TimeTrackingQueryRq",
  "TxnDelRq (TxnDelType TimeTracking only)",
  "CustomerAddRq",
] as const;
