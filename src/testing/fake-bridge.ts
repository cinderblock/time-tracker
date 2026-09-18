import { XMLParser } from "fast-xml-parser";

import { xmlText } from "../accounting/qbxml.ts";
import { type FakeQuickBooks, LostAnswer } from "./fake-quickbooks.ts";

/**
 * A stand-in for the QB Bridge (github.com/cinderblock/quickbooks-desktop-sdk-bridge)
 * in front of a FakeQuickBooks: the entity routes the time tracker uses, with
 * the bridge's JSON-to-qbXML mapping (keys become elements, in the order
 * given), its envelopes, status codes and API key check. As a `fetch` for unit
 * tests, or served over HTTP for the end-to-end tests.
 */

export interface FakeBridgeOptions {
  apiKey: string;
  /** QuickBooks closed: the port doesn't answer. */
  down?: () => boolean;
  /** An older bridge, from before time tracking. */
  noTimeTracking?: () => boolean;
  /**
   * A bridge from before its route order was fixed (2026-09-18): /items/service
   * is answered by /items/{id} with id "service" — a 404 bare, and
   * UNKNOWN_QUERY_PARAM with any query string.
   */
  shadowedServiceItems?: () => boolean;
}

type Json = Record<string, unknown>;

/** URL segment -> QuickBooks entity, as in the bridge's registry. */
const ENTITIES: Record<string, { name: string; txn: boolean }> = {
  customers: { name: "Customer", txn: false },
  employees: { name: "Employee", txn: false },
  vendors: { name: "Vendor", txn: false },
  "other-names": { name: "OtherName", txn: false },
  "items/service": { name: "ItemService", txn: false },
  "payroll-items/wage": { name: "PayrollItemWage", txn: false },
  "time-tracking": { name: "TimeTracking", txn: true },
};
const NEW_ENTITIES = new Set(["other-names", "payroll-items/wage", "time-tracking"]);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The bridge's dict -> XML: keys in order, nested objects, lists repeat the element. */
function toXml(data: unknown): string {
  if (data == null) return "";
  if (typeof data !== "object") return xmlText(String(data));
  return Object.entries(data as Json)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => (Array.isArray(v) ? v.map((item) => `<${k}>${toXml(item)}</${k}>`).join("") : `<${k}>${toXml(v)}</${k}>`))
    .join("");
}

function request(rq: string, body: Json = {}): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<?qbxml version="13.0"?>\n<QBXML><QBXMLMsgsRq onError="stopOnError"><${rq} requestID="1">${toXml(body)}</${rq}></QBXMLMsgsRq></QBXML>`;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
  htmlEntities: true,
});

/** The bridge's response parsing: status check, then the *Ret children as dicts. */
function parse(xml: string): { error: { code: number; message: string } | null; data: Json[] } {
  const doc = parser.parse(xml) as Json;
  const msgs = ((doc.QBXML as Json).QBXMLMsgsRs ?? {}) as Json;
  const [, rs] = Object.entries(msgs).find(([k]) => !k.startsWith("@_")) ?? [];
  const node = (rs ?? {}) as Json;
  if (node["@_statusSeverity"] === "Error") {
    return { error: { code: Number(node["@_statusCode"]), message: String(node["@_statusMessage"] ?? "") }, data: [] };
  }
  const data: Json[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("@_") || !k.endsWith("Ret")) continue;
    for (const item of Array.isArray(v) ? v : [v]) data.push(item as Json);
  }
  return { error: null, data };
}

function qbError(error: { code: number; message: string }) {
  return json(502, { ok: false, error: { code: "QBRequestError", message: error.message, qb_status_code: error.code } });
}

const notFound = (what: string) =>
  json(404, { detail: { ok: false, error: { code: "NOT_FOUND", message: `${what} not found` } } });

/** Answer one HTTP request as the bridge would. */
export async function bridgeResponse(qb: FakeQuickBooks, opts: FakeBridgeOptions, req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/v1/")) return json(404, { detail: "Not Found" });
  if (req.headers.get("X-API-Key") !== opts.apiKey) {
    return json(401, { detail: { ok: false, error: { code: "INVALID_API_KEY", message: "Invalid or revoked API key" } } });
  }
  const rest = url.pathname.slice("/api/v1/".length);

  if (rest === "company" && req.method === "GET") {
    const answer = parse(qb.handle(request("CompanyQueryRq")));
    return answer.error ? qbError(answer.error) : json(200, { ok: true, data: answer.data[0] ?? null });
  }

  const segment = Object.keys(ENTITIES)
    .sort((a, b) => b.length - a.length)
    .find((p) => rest === p || rest.startsWith(`${p}/`));
  if (!segment || (opts.noTimeTracking?.() && NEW_ENTITIES.has(segment))) return json(404, { detail: "Not Found" });
  if (segment === "items/service" && rest === segment && opts.shadowedServiceItems?.()) {
    const sent = [...url.searchParams.keys()];
    if (sent.length === 0) return json(404, { detail: { ok: false, error: { code: "NOT_FOUND", message: "ItemService 'service' not found" } } });
    return json(400, { detail: { ok: false, error: { code: "UNKNOWN_QUERY_PARAM", message: `Unknown query parameter(s): ${sent.join(", ")}. Allowed: (none).` } } });
  }
  const entity = ENTITIES[segment]!;
  const id = rest.length > segment.length ? decodeURIComponent(rest.slice(segment.length + 1)) : null;
  const idField = entity.txn ? "TxnID" : "ListID";
  const body = req.method === "POST" || req.method === "PUT" ? ((await req.json()) as Json) : null;

  if (req.method === "GET" && id == null) {
    const q = url.searchParams;
    const filters: Json = { MaxReturned: q.get("max_returned") ?? "100" };
    if (entity.txn) {
      if (q.has("active")) {
        return json(400, { detail: { ok: false, error: { code: "PARAM_NOT_APPLICABLE", message: "'active' does not apply" } } });
      }
      if (q.has("from_date") || q.has("to_date")) {
        filters.TxnDateRangeFilter = { FromTxnDate: q.get("from_date") ?? undefined, ToTxnDate: q.get("to_date") ?? undefined };
      }
    } else if (q.get("active") && q.get("active") !== "ActiveOnly") {
      filters.ActiveStatus = q.get("active");
    }
    const answer = parse(qb.handle(request(`${entity.name}QueryRq`, filters)));
    if (answer.error) return qbError(answer.error);
    const meta: Json = { count: answer.data.length };
    if (q.get("iterator_id")) Object.assign(meta, { iterator_id: "{fake-iterator}", remaining: 0 });
    return json(200, { ok: true, data: answer.data, meta });
  }

  if (req.method === "GET") {
    const answer = parse(qb.handle(request(`${entity.name}QueryRq`, { [idField]: id })));
    if (answer.error) return qbError(answer.error);
    return answer.data[0] ? json(200, { ok: true, data: answer.data[0] }) : notFound(entity.name);
  }

  if (req.method === "POST" && id == null) {
    const answer = parse(qb.handle(request(`${entity.name}AddRq`, { [`${entity.name}Add`]: body })));
    return answer.error ? qbError(answer.error) : json(201, { ok: true, data: answer.data[0] ?? null });
  }

  if (req.method === "PUT" && id != null) {
    const { EditSequence, ...fields } = body ?? {};
    if (!EditSequence) {
      return json(400, { detail: { ok: false, error: { code: "MISSING_EDIT_SEQUENCE", message: "EditSequence is required" } } });
    }
    const answer = parse(qb.handle(request(`${entity.name}ModRq`, { [`${entity.name}Mod`]: { [idField]: id, EditSequence, ...fields } })));
    return answer.error ? qbError(answer.error) : json(200, { ok: true, data: answer.data[0] ?? null });
  }

  if (req.method === "DELETE" && id != null) {
    const del = entity.txn ? request("TxnDelRq", { TxnDelType: entity.name, TxnID: id }) : request("ListDelRq", { ListDelType: entity.name, ListID: id });
    const answer = parse(qb.handle(del));
    return answer.error ? qbError(answer.error) : json(200, { ok: true, data: null });
  }

  return json(405, { detail: "Method Not Allowed" });
}

/** A `fetch` that talks to the fake bridge; the host part of the URL is ignored. */
export function fakeBridgeFetch(qb: FakeQuickBooks, opts: FakeBridgeOptions): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (opts.down?.()) throw new TypeError("fetch failed: connect ETIMEDOUT");
    try {
      return await bridgeResponse(qb, opts, new Request(input, init));
    } catch (err) {
      // The request was applied but the answer never arrived.
      if (err instanceof LostAnswer) throw new TypeError("fetch failed: socket hang up");
      throw err;
    }
  };
  return impl as typeof fetch;
}
