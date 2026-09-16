import { type AccountingBackend, type BackendHealth, BackendUnreachableError, type Performed } from "./types.ts";

/**
 * Standalone mode: no accounting system at all.
 *
 * Jobs are defined in this app and nothing is ever sent anywhere; approved is
 * the end of the road for time. This is the default backend so a fresh clone
 * runs with zero external dependencies — which matters both for local
 * development and because this repo is meant to be useful to someone who has
 * never heard of QuickBooks.
 */
export class NoAccountingBackend implements AccountingBackend {
  readonly kind = "none" as const;
  readonly delivery = "none" as const;

  async health(): Promise<BackendHealth> {
    return { ok: true, detail: "Standalone — no accounting system is connected, so approved time stays here." };
  }

  async perform(): Promise<Performed> {
    throw new BackendUnreachableError("No accounting system is connected.");
  }
}
