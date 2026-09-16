import type { OpErrorCode } from "./ops-schema.ts";

/**
 * A rejected op: the request was well-formed but doesn't make sense against
 * the current state (stopping a timer that isn't running, a job that's been
 * closed, a missing required note). The message is shown to the person.
 *
 * Unlike an unexpected exception, a rejection is recorded in the op ledger, so
 * replaying the same op gets the same answer.
 */
export class OpError extends Error {
  readonly code: OpErrorCode;
  constructor(code: OpErrorCode, message: string) {
    super(message);
    this.name = "OpError";
    this.code = code;
  }
}
