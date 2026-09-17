import { timingSafeEqual } from "node:crypto";

import { XMLParser } from "fast-xml-parser";

import { branding } from "../branding.ts";
import { config } from "../config.server.ts";
import { randomToken } from "../crypto.ts";
import { syncState } from "../settings.ts";
import { type Work, beginWork, finishWork, listWork, recordContact, workUnreachable } from "../sync.ts";
import { buildRequest, parseResponse, qbFailure, xmlText } from "./qbxml.ts";
import { type AccountingBackend, type BackendHealth, BackendUnreachableError, type Performed } from "./types.ts";

/**
 * QuickBooks Desktop through the QuickBooks Web Connector (QBWC).
 *
 * QBWC runs on the QuickBooks machine and calls us: every few minutes it
 * signs in to `/qbwc`, asks for a request, hands it to QuickBooks, and posts
 * back the answer, until we say we're done. So this backend never sends
 * anything itself — work waits in the tables (sync.ts) until QBWC asks.
 *
 * The protocol is SOAP 1.1 with a fixed set of methods; the messages are
 * small enough to handle as plain XML rather than with a SOAP toolkit.
 */

export class WebConnectorBackend implements AccountingBackend {
  readonly kind = "qb-webconnector" as const;
  readonly delivery = "poll" as const;

  async health(): Promise<BackendHealth> {
    const s = syncState();
    if (s.lastContactAt == null) {
      return { ok: false, detail: "The Web Connector hasn't connected yet. Add the .qwc file to it on the QuickBooks computer." };
    }
    const minutes = Math.round((Date.now() - s.lastContactAt) / 60_000);
    const ago = minutes < 1 ? "just now" : minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
    const stale = minutes > 3 * RUN_EVERY_MINUTES;
    return {
      ok: s.lastContactOk && !stale,
      detail: `Last heard from the Web Connector ${ago}${s.lastContactDetail ? `: ${s.lastContactDetail}` : "."}`,
    };
  }

  async perform(): Promise<Performed> {
    throw new BackendUnreachableError("The Web Connector asks for work; nothing is sent directly.");
  }
}

/** How often QBWC is told to connect, in the .qwc file. */
export const RUN_EVERY_MINUTES = 15;

/** Requests handed out in one session, so a misbehaving loop can't run forever. */
const MAX_REQUESTS_PER_SESSION = 500;
const SESSION_TTL_MS = 30 * 60_000;
const NS = "http://developer.intuit.com/";

interface Session {
  created: number;
  lastSeen: number;
  current: { work: Work; request: string } | null;
  sent: number;
  done: number;
  lastError: string;
}

const sessions = new Map<string, Session>();

function session(ticket: string, now: number): Session | null {
  for (const [key, s] of sessions) if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(key);
  const s = sessions.get(ticket);
  if (s) s.lastSeen = now;
  return s ?? null;
}

/** Test seam. */
export function resetWebConnectorSessions(): void {
  sessions.clear();
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- SOAP ---------------------------------------------------------------------------

const soapParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
  htmlEntities: true,
});

export class SoapError extends Error {}

function readCall(xml: string): { method: string; params: Record<string, string> } {
  if (/<!DOCTYPE/i.test(xml)) throw new SoapError("DTDs are not accepted.");
  let doc: Record<string, unknown>;
  try {
    doc = soapParser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new SoapError("Malformed SOAP message.");
  }
  const body = (doc.Envelope as Record<string, unknown> | undefined)?.Body as Record<string, unknown> | undefined;
  const [method, raw] = Object.entries(body ?? {})[0] ?? [];
  if (!method) throw new SoapError("No SOAP method.");
  const params: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) params[k] = v == null ? "" : String(v);
  }
  return { method, params };
}

const envelope = (inner: string) =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ' +
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">' +
  `<soap:Body>${inner}</soap:Body></soap:Envelope>`;

const reply = (method: string, value: string) =>
  envelope(`<${method}Response xmlns="${NS}"><${method}Result>${value}</${method}Result></${method}Response>`);

export function soapFault(message: string): string {
  return envelope(
    `<soap:Fault><faultcode>soap:Client</faultcode><faultstring>${xmlText(message)}</faultstring></soap:Fault>`,
  );
}

// ---- the methods --------------------------------------------------------------------

export interface SoapOutcome {
  body: string;
  /** Slow the caller down (a failed sign-in). */
  delayMs?: number;
}

const BACKEND = "qb-webconnector";

function progress(s: Session, now: number): number {
  if (s.sent >= MAX_REQUESTS_PER_SESSION) return 100;
  const remaining = listWork(now).length;
  if (remaining === 0) return 100;
  return Math.max(1, Math.min(99, Math.round((s.done / (s.done + remaining)) * 100)));
}

/** Handle one SOAP call from the Web Connector. */
export function handleWebConnectorCall(xml: string, now: number = Date.now()): SoapOutcome {
  const { method, params } = readCall(xml);
  const ticket = params.ticket ?? "";

  switch (method) {
    case "serverVersion":
      return { body: reply(method, xmlText(`${branding().name} (time tracker)`)) };

    case "clientVersion":
      // Any Web Connector version is fine.
      return { body: reply(method, "") };

    case "authenticate": {
      const password = config.accounting.webConnectorPassword;
      const ok =
        password != null &&
        sameSecret(params.strUserName ?? "", config.accounting.webConnectorUsername) &&
        sameSecret(params.strPassword ?? "", password);
      if (!ok) {
        recordContact(false, "the Web Connector's user name or password was refused.", now);
        return { body: reply(method, "<string></string><string>nvu</string>"), delayMs: 1_000 };
      }
      const t = randomToken(24);
      sessions.set(t, { created: now, lastSeen: now, current: null, sent: 0, done: 0, lastError: "" });
      const pending = listWork(now).length;
      recordContact(true, pending ? `${pending} thing${pending === 1 ? "" : "s"} to do.` : "nothing to do.", now);
      // "" = use whichever company file QuickBooks has open; "none" = no work.
      return { body: reply(method, `<string>${t}</string><string>${pending ? "" : "none"}</string>`) };
    }

    case "sendRequestXML": {
      const s = session(ticket, now);
      if (!s) return { body: reply(method, "") };
      if (Number(params.qbXMLMajorVers || 99) < 13) {
        s.lastError = "This QuickBooks is too old: qbXML 13 or newer is needed (QuickBooks 2014 or later).";
        return { body: reply(method, "") };
      }
      const work = s.sent < MAX_REQUESTS_PER_SESSION ? listWork(now)[0] : undefined;
      if (!work) {
        s.lastError = "Nothing left to do.";
        return { body: reply(method, "") };
      }
      beginWork(work, now);
      const request = buildRequest(work.request, `${work.kind}:${work.id}`);
      s.current = { work, request };
      s.sent++;
      return { body: reply(method, xmlText(request)) };
    }

    case "receiveResponseXML": {
      const s = session(ticket, now);
      if (!s) return { body: reply(method, "-101") };
      const current = s.current;
      s.current = null;
      if (current) {
        const hresult = params.hresult ?? "";
        const result = hresult
          ? // QuickBooks couldn't process the request at all. Count it against
            // this piece of work, so one bad request can't stall the rest.
            qbFailure(-2, `QuickBooks couldn't process the request (${hresult}): ${params.message ?? ""}`.trim())
          : parseResponse(current.work.request, params.response ?? "");
        finishWork(BACKEND, current.work, { result, request: current.request, response: params.response ?? "" }, now);
        s.done++;
      }
      recordContact(true, "connected.", now);
      return { body: reply(method, String(progress(s, now))) };
    }

    case "connectionError": {
      const s = session(ticket, now);
      if (s?.current) workUnreachable(BACKEND, s.current.work, params.message ?? "connection error", now);
      if (s) s.current = null;
      recordContact(false, `QuickBooks couldn't be opened (${params.message || params.hresult || "no detail"}).`, now);
      return { body: reply(method, "done") };
    }

    case "getLastError": {
      const s = session(ticket, now);
      return { body: reply(method, xmlText(s?.lastError || "")) };
    }

    case "closeConnection": {
      const s = session(ticket, now);
      sessions.delete(ticket);
      const summary = s ? `Done: ${s.done} request${s.done === 1 ? "" : "s"}.` : "Done.";
      return { body: reply(method, xmlText(summary)) };
    }

    default:
      throw new SoapError(`Unknown method ${method}.`);
  }
}

// ---- the .qwc file ------------------------------------------------------------------

/** The file an admin adds to the Web Connector to connect it to this app. */
export function qwcFile(ids: { ownerId: string; fileId: string }): string {
  const base = config.publicBaseUrl.replace(/\/+$/, "");
  const fields: [string, string][] = [
    ["AppName", branding().name],
    ["AppID", ""],
    ["AppURL", `${base}/qbwc`],
    ["AppDescription", "Sends approved time to QuickBooks, and keeps its job, people and item lists."],
    ["AppSupport", `${base}/qbwc/support`],
    ["UserName", config.accounting.webConnectorUsername],
    ["OwnerID", ids.ownerId],
    ["FileID", ids.fileId],
    ["QBType", "QBFS"],
  ];
  return (
    '<?xml version="1.0"?>\r\n<QBWCXML>\r\n' +
    fields.map(([k, v]) => `  <${k}>${xmlText(v)}</${k}>\r\n`).join("") +
    `  <Scheduler>\r\n    <RunEveryNMinutes>${RUN_EVERY_MINUTES}</RunEveryNMinutes>\r\n  </Scheduler>\r\n` +
    "  <IsReadOnly>false</IsReadOnly>\r\n</QBWCXML>\r\n"
  );
}
