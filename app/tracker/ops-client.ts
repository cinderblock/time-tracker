import type { Op, OpPayload, OpResult, OpType } from "../../src/ops-schema.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { SignedOutError, TransportError } from "../offline/sync.ts";

/**
 * Browser side of the op protocol: building ops, and the one HTTP call that
 * delivers them. The outbox (app/offline/sync.ts) decides *when* to call it.
 */

const DEVICE_KEY = "tt-device-id";

/** A stable id for this browser install, recorded with every op. */
export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = uuidv7();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    // Storage can be unavailable (private mode, blocked); fall back to a
    // per-page id rather than failing the action.
    return "ephemeral";
  }
}

export function makeOp<T extends OpType>(type: T, payload: OpPayload<T>): Op {
  return { opId: uuidv7(), type, deviceId: deviceId(), clientTime: Date.now(), payload } as Op;
}

/**
 * Deliver ops. Anything short of a proper answer — no network, a timeout, a
 * proxy error because the app is down — is a TransportError, which leaves the
 * ops queued for a retry. A dead connection must fail fast rather than hang,
 * hence the timeout.
 */
export async function sendOps(ops: Op[], endpoint = "/api/ops"): Promise<OpResult[]> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ ops }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new TransportError("Can't reach the server.");
  }
  if (response.status === 401) throw new SignedOutError();
  const body = (await response.json().catch(() => null)) as { results?: OpResult[]; error?: string } | null;
  if (!response.ok || !body?.results || body.results.length !== ops.length) {
    throw new TransportError(body?.error ?? `The server answered ${response.status}.`);
  }
  return body.results;
}
