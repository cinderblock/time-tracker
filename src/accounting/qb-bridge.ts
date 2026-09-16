import { buildRequest, parseResponse } from "./qbxml.ts";
import {
  type AccountingBackend,
  type BackendHealth,
  BackendUnreachableError,
  type Performed,
  type SyncRequest,
} from "./types.ts";

/**
 * QuickBooks Desktop through the QB Bridge: a small REST service on the
 * QuickBooks machine that holds the company file open.
 *
 * Everything goes through one bridge endpoint, `POST /api/v1/qbxml`, which
 * takes a qbXML request and returns QuickBooks' qbXML answer inside the
 * bridge's usual `{ ok, data }` envelope (docs/qb-bridge-qbxml.md).
 *
 * The bridge only listens while QuickBooks has the company file open, so
 * "can't connect" is the normal state; it surfaces as BackendUnreachableError
 * and never counts against the request being sent.
 */

export interface BridgeOptions {
  baseUrl: string;
  apiKey: string;
  /** How long to wait for a connection and an answer. Pulls can be slow. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

let requestCounter = 0;

export class QbBridgeBackend implements AccountingBackend {
  readonly kind = "qb-bridge" as const;
  readonly delivery = "push" as const;
  private readonly base: string;

  constructor(private readonly opts: BridgeOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
  }

  async health(): Promise<BackendHealth> {
    try {
      const { result } = await this.perform({ type: "ping" }, 5_000);
      if (result.ok && result.type === "pong") return { ok: true, detail: `Connected to ${result.product}.` };
      return { ok: false, detail: result.ok ? "Unexpected answer from the bridge." : `QuickBooks answered: ${result.message}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async perform(request: SyncRequest, timeoutMs = this.opts.timeoutMs ?? 120_000): Promise<Performed> {
    const qbxml = buildRequest(request, `tt${Date.now().toString(36)}${(requestCounter++).toString(36)}`);
    const doFetch = this.opts.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.base}/api/v1/qbxml`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": this.opts.apiKey },
        body: JSON.stringify({ qbxml }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new BackendUnreachableError(
        timedOut
          ? "The QB Bridge didn't answer in time. It only listens while QuickBooks has the company file open."
          : `Can't reach the QB Bridge (${err instanceof Error ? err.message : String(err)}).`,
      );
    }

    const text = await response.text();
    let body: { ok?: boolean; data?: { qbxml?: unknown }; error?: { code?: string; message?: string } } | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      // handled below
    }

    if (response.status === 404 && !body?.error) {
      throw new BackendUnreachableError(
        "The QB Bridge has no /api/v1/qbxml endpoint yet — see docs/qb-bridge-qbxml.md.",
      );
    }
    if (!body || body.ok !== true) {
      const code = body?.error?.code ?? `HTTP ${response.status}`;
      const message = body?.error?.message ?? text.slice(0, 200);
      // Refusals about *us* — address, key, the request type — aren't about
      // the record being sent; retrying the same record won't change them.
      throw new BackendUnreachableError(`The QB Bridge refused the request (${code}): ${message}`);
    }
    const answer = typeof body.data?.qbxml === "string" ? body.data.qbxml : "";
    return { result: parseResponse(request, answer), request: qbxml, response: answer };
  }
}
