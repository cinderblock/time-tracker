import { type FakeQuickBooks, LostAnswer } from "./fake-quickbooks.ts";

/**
 * A stand-in for the QB Bridge's `POST /api/v1/qbxml` (docs/qb-bridge-qbxml.md)
 * in front of a FakeQuickBooks: as a `fetch` for unit tests, or as a real HTTP
 * server for the end-to-end tests. It enforces the contract's request-type
 * allowlist and API key, and answers in the bridge's envelope.
 */

export const ALLOWED_REQUESTS = [
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
  "TxnDelRq",
  "CustomerAddRq",
];

export interface FakeBridgeOptions {
  apiKey: string;
  /** QuickBooks closed: the port doesn't answer. */
  down?: () => boolean;
  /** An older bridge without the endpoint. */
  noEndpoint?: () => boolean;
}

const envelope = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Answer one HTTP request as the bridge would. */
export async function bridgeResponse(qb: FakeQuickBooks, opts: FakeBridgeOptions, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.get("X-API-Key") !== opts.apiKey) {
    return envelope(401, { ok: false, error: { code: "UNAUTHORIZED", message: "Invalid API key" } });
  }
  if (url.pathname !== "/api/v1/qbxml" || request.method !== "POST" || opts.noEndpoint?.()) {
    return new Response("Not Found", { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as { qbxml?: unknown } | null;
  if (typeof body?.qbxml !== "string" || !body.qbxml.includes("<QBXML>")) {
    return envelope(400, { ok: false, error: { code: "BAD_REQUEST", message: "Expected { qbxml: string }" } });
  }
  const qbxml = body.qbxml;
  // Every request element inside the message wrapper.
  const types = [...qbxml.matchAll(/<([A-Za-z]+Rq)\b/g)].map((m) => m[1]!).filter((t) => t !== "QBXMLMsgsRq");
  const refused = types.find((t) => !ALLOWED_REQUESTS.includes(t));
  if (!types.length || refused) {
    return envelope(403, { ok: false, error: { code: "REQUEST_NOT_ALLOWED", message: `${refused ?? "Nothing"} is not allowed` } });
  }
  if (types.includes("TxnDelRq") && !/<TxnDelType>TimeTracking<\/TxnDelType>/.test(qbxml)) {
    return envelope(403, { ok: false, error: { code: "REQUEST_NOT_ALLOWED", message: "Only time can be deleted" } });
  }
  return envelope(200, { ok: true, data: { qbxml: qb.handle(qbxml) } });
}

/** A `fetch` that talks to the fake bridge; the host part of the URL is ignored. */
export function fakeBridgeFetch(qb: FakeQuickBooks, opts: FakeBridgeOptions): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (opts.down?.()) throw new TypeError("fetch failed: connect ETIMEDOUT");
    const request = new Request(input, init);
    try {
      return await bridgeResponse(qb, opts, request);
    } catch (err) {
      // The request was applied but the answer never arrived.
      if (err instanceof LostAnswer) throw new TypeError("fetch failed: socket hang up");
      throw err;
    }
  };
  return impl as typeof fetch;
}

/** Serve the fake bridge over HTTP (end-to-end tests). */
export function serveFakeBridge(qb: FakeQuickBooks, opts: FakeBridgeOptions & { port: number }) {
  return Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    async fetch(request) {
      try {
        return await bridgeResponse(qb, opts, request);
      } catch (err) {
        if (err instanceof LostAnswer) return new Response("", { status: 502 });
        throw err;
      }
    },
  });
}
