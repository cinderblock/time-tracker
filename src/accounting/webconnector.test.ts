import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { XMLParser } from "fast-xml-parser";

import { approveEntries } from "../approvals.ts";
import { config } from "../config.server.ts";
import { getEntry } from "../entries.ts";
import { listJobs } from "../jobs.ts";
import { applyOp } from "../ops.ts";
import { linkPerson } from "../remote-lists.ts";
import { syncState, webConnectorIds } from "../settings.ts";
import { freshDb } from "../testing/db.ts";
import { type FakeQuickBooks, sampleCompany } from "../testing/fake-quickbooks.ts";
import { createUser } from "../users.ts";
import { uuidv7 } from "../uuid.ts";
import { xmlText } from "./qbxml.ts";
import { SoapError, WebConnectorBackend, handleWebConnectorCall, qwcFile, resetWebConnectorSessions } from "./webconnector.ts";

/**
 * The Web Connector's side of the conversation, played against the real
 * SOAP handler and a pretend QuickBooks.
 */

const NINE = Date.parse("2026-09-16T16:00:00Z");
const accounting = config.accounting as { webConnectorUsername: string; webConnectorPassword: string | null };
const saved = { ...accounting };

let qb: FakeQuickBooks;
let now = NINE;

beforeEach(() => {
  freshDb();
  resetWebConnectorSessions();
  qb = sampleCompany();
  now = NINE;
  accounting.webConnectorUsername = "qbwc";
  accounting.webConnectorPassword = "correct horse";
});

afterEach(() => {
  Object.assign(accounting, saved);
});

const out = new XMLParser({ removeNSPrefix: true, parseTagValue: false, htmlEntities: true, isArray: (n) => n === "string" });

/** Send one SOAP call as the Web Connector does; return the result element's value. */
function call(method: string, params: Record<string, string> = {}): { result: unknown; delayMs?: number } {
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<soap:Body><${method} xmlns="http://developer.intuit.com/">` +
    Object.entries(params)
      .map(([k, v]) => `<${k}>${xmlText(v)}</${k}>`)
      .join("") +
    `</${method}></soap:Body></soap:Envelope>`;
  const reply = handleWebConnectorCall(body, now);
  const doc = out.parse(reply.body) as Record<string, any>;
  return { result: doc.Envelope.Body[`${method}Response`][`${method}Result`], delayMs: reply.delayMs };
}

const signIn = (password = "correct horse") => call("authenticate", { strUserName: "qbwc", strPassword: password }).result as { string: string[] };

/** Run a whole Web Connector session; returns how many requests it carried. */
function session(): number {
  const [ticket, status] = signIn().string;
  if (status === "none") {
    call("closeConnection", { ticket: ticket! });
    return 0;
  }
  let requests = 0;
  for (let percent = 0; percent < 100; ) {
    const request = String(call("sendRequestXML", { ticket: ticket!, strHCPResponse: "", strCompanyFileName: "", qbXMLCountry: "US", qbXMLMajorVers: "16", qbXMLMinorVers: "0" }).result ?? "");
    if (!request) break;
    requests++;
    const response = qb.handle(request);
    percent = Number(call("receiveResponseXML", { ticket: ticket!, response, hresult: "", message: "" }).result);
    if (percent < 0) break;
  }
  call("closeConnection", { ticket: ticket! });
  return requests;
}

describe("the Web Connector", () => {
  test("wrong credentials are refused, slowly; the right ones with nothing to do get 'none'", () => {
    const refused = call("authenticate", { strUserName: "qbwc", strPassword: "wrong" });
    expect((refused.result as { string: string[] }).string).toEqual(["", "nvu"]);
    expect(refused.delayMs).toBe(1000);
    expect(syncState()).toMatchObject({ lastContactOk: false });
    expect((call("authenticate", { strUserName: "someone", strPassword: "correct horse" }).result as { string: string[] }).string[1]).toBe("nvu");

    // A pull is always due on first contact.
    const [ticket, status] = signIn().string;
    expect(ticket).toMatch(/^[\w-]{20,}$/);
    expect(status).toBe("");
  });

  test("a session pulls the lists, then sends approved time, and reports progress", () => {
    expect(session()).toBe(1); // the pull
    expect(listJobs().map((j) => j.fullName)).toEqual(["Acme", "Acme:Phase 2"]);
    expect(signIn().string[1]).toBe("none");

    const admin = createUser({ name: "Ada", role: "admin", actorUserId: null }).id;
    const alice = createUser({ name: "Alice", role: "employee", actorUserId: admin }).id;
    linkPerson({ userId: alice, remoteId: "E-ALICE", actorUserId: admin });
    const acme = listJobs().find((j) => j.remoteId === "C-ACME")!.id;
    const ids = [0, 1, 2].map((i) => {
      const entryId = uuidv7();
      const r = applyOp(alice, {
        opId: uuidv7(),
        type: "entry.create",
        deviceId: "t",
        clientTime: now,
        payload: { entryId, jobId: acme, startedAt: NINE + i * 3_600_000, endedAt: NINE + i * 3_600_000 + 1_800_000, note: `Part ${i}` },
      }, now);
      expect(r.ok).toBe(true);
      return entryId;
    });
    approveEntries({ userId: alice, entryIds: ids, actorUserId: admin });

    const [ticket, status] = signIn().string;
    expect(status).toBe("");
    const percents: number[] = [];
    for (;;) {
      const request = String(call("sendRequestXML", { ticket: ticket!, qbXMLMajorVers: "13" }).result ?? "");
      if (!request) break;
      expect(request.startsWith('<?xml version="1.0" encoding="utf-8"?><?qbxml version="13.0"?>')).toBe(true);
      const percent = Number(call("receiveResponseXML", { ticket: ticket!, response: qb.handle(request), hresult: "", message: "" }).result);
      percents.push(percent);
      if (percent >= 100) break;
    }
    expect(percents).toEqual([33, 67, 100]);
    expect(call("closeConnection", { ticket: ticket! }).result).toBe("Done: 3 requests.");
    expect(qb.records.map((r) => r.notes.split(" [ref")[0])).toEqual(["Part 0", "Part 1", "Part 2"]);
    expect(ids.map((id) => getEntry(id)!.status)).toEqual(["synced", "synced", "synced"]);
    expect(syncState()).toMatchObject({ lastContactOk: true, lastContactAt: now });
  });

  test("a request QuickBooks can't process fails on its own; the rest carry on", () => {
    session();
    const admin = createUser({ name: "Ada", role: "admin", actorUserId: null }).id;
    linkPerson({ userId: admin, remoteId: "E-ALICE", actorUserId: admin });
    const acme = listJobs()[0]!.id;
    const make = () => {
      const entryId = uuidv7();
      applyOp(admin, { opId: uuidv7(), type: "entry.create", deviceId: "t", clientTime: now, payload: { entryId, jobId: acme, workDate: "2026-09-16", durationSeconds: 3600 } }, now);
      return entryId;
    };
    const [bad, good] = [make(), make()];
    approveEntries({ userId: admin, entryIds: [bad, good], actorUserId: admin });

    const [ticket] = signIn().string;
    call("sendRequestXML", { ticket: ticket!, qbXMLMajorVers: "13" });
    const percent = Number(
      call("receiveResponseXML", { ticket: ticket!, response: "", hresult: "0x80040400", message: "QuickBooks found an error when parsing the provided XML text stream." }).result,
    );
    expect(percent).toBe(50);
    const next = String(call("sendRequestXML", { ticket: ticket!, qbXMLMajorVers: "13" }).result);
    expect(Number(call("receiveResponseXML", { ticket: ticket!, response: qb.handle(next), hresult: "", message: "" }).result)).toBe(100);
    expect(getEntry(bad)!.status).toBe("sync_failed");
    expect(getEntry(good)!.status).toBe("synced");
  });

  test("QuickBooks not opening, old versions, unknown tickets", () => {
    const [ticket] = signIn().string;
    expect(call("sendRequestXML", { ticket: ticket!, qbXMLMajorVers: "8" }).result).toBe("");
    expect(call("getLastError", { ticket: ticket! }).result).toBe(
      "This QuickBooks is too old: qbXML 13 or newer is needed (QuickBooks 2014 or later).",
    );
    expect(call("connectionError", { ticket: ticket!, hresult: "0x80040408", message: "Could not start QuickBooks." }).result).toBe("done");
    expect(syncState()).toMatchObject({
      lastContactOk: false,
      lastContactDetail: "QuickBooks couldn't be opened (Could not start QuickBooks.).",
    });
    expect(call("sendRequestXML", { ticket: "made-up", qbXMLMajorVers: "13" }).result).toBe("");
    expect(call("receiveResponseXML", { ticket: "made-up", response: "" }).result).toBe("-101");
    expect(call("serverVersion").result).toContain("time tracker");
    expect(call("clientVersion", { strVersion: "2.3.0.215" }).result).toBe("");
  });

  test("sessions expire", () => {
    const [ticket] = signIn().string;
    now += 31 * 60_000;
    expect(call("sendRequestXML", { ticket: ticket!, qbXMLMajorVers: "13" }).result).toBe("");
  });

  test("hostile or broken input is refused", () => {
    expect(() => handleWebConnectorCall('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x/>')).toThrow(SoapError);
    expect(() => handleWebConnectorCall("<soap:Envelope><soap:Body></soap:Body></soap:Envelope>")).toThrow("No SOAP method");
    expect(() => call("deleteEverything")).toThrow("Unknown method deleteEverything");
    accounting.webConnectorPassword = null;
    expect(signIn().string).toEqual(["", "nvu"]);
  });

  test("the .qwc file and the health line", async () => {
    const qwc = qwcFile(webConnectorIds());
    expect(qwc).toContain("<AppURL>http://localhost:3000/qbwc</AppURL>".replace("http://localhost:3000", config.publicBaseUrl));
    expect(qwc).toContain("<UserName>qbwc</UserName>");
    expect(qwc).toMatch(/<OwnerID>\{[0-9a-f-]{36}\}<\/OwnerID>/);
    expect(qwc).toContain("<RunEveryNMinutes>15</RunEveryNMinutes>");
    // The ids are stable across downloads.
    expect(qwcFile(webConnectorIds())).toBe(qwc);

    const backend = new WebConnectorBackend();
    expect(await backend.health()).toEqual({
      ok: false,
      detail: "The Web Connector hasn't connected yet. Add the .qwc file to it on the QuickBooks computer.",
    });
    now = Date.now(); // health() reads the real clock
    signIn();
    expect((await backend.health()).detail).toMatch(/^Last heard from the Web Connector (just now|\d+ min ago): 1 thing to do\.$/);
  });
});
