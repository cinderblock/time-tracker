import type { Op, OpPayload, OpResult, OpType } from "../../src/ops-schema.ts";
import { uuidv7 } from "../../src/uuid.ts";

/**
 * Browser side of the op protocol. Phase 2 sends ops straight to the server;
 * phase 3 puts an IndexedDB outbox in front of `sendOps` without changing how
 * the screen builds or dispatches them.
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

/** Thrown when the server can't be reached or failed, so the op's fate is unknown. */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

export class SignedOutError extends Error {
  constructor() {
    super("You've been signed out. Sign in again to keep tracking.");
    this.name = "SignedOutError";
  }
}

export async function sendOps(ops: Op[]): Promise<OpResult[]> {
  let response: Response;
  try {
    response = await fetch("/api/ops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ ops }),
    });
  } catch {
    throw new TransportError("Can't reach the server.");
  }
  if (response.status === 401) throw new SignedOutError();
  const body = (await response.json().catch(() => null)) as { results?: OpResult[]; error?: string } | null;
  if (!response.ok || !body?.results) {
    throw new TransportError(body?.error ?? `The server answered ${response.status}.`);
  }
  return body.results;
}
