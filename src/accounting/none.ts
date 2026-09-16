import type {
  AccountingBackend,
  BackendHealth,
  PushResult,
  PushableTimeEntry,
  RemoteJob,
  RemotePayrollItem,
  RemotePerson,
  RemoteServiceItem,
} from "./types.ts";

/**
 * Standalone mode: no accounting system at all.
 *
 * Jobs are defined in this app and nothing is ever pushed anywhere. This is the
 * default backend so a fresh clone runs with zero external dependencies — which
 * matters both for local development and because this repo is meant to be
 * useful to someone who has never heard of QuickBooks.
 *
 * The empty list results are not a stub: they are correct. With no backend
 * there are no remote jobs to import, and every job is a local one.
 */
export class NoAccountingBackend implements AccountingBackend {
  readonly kind = "none";

  async health(): Promise<BackendHealth> {
    return { ok: true, detail: "Standalone mode — no accounting backend configured." };
  }

  async listJobs(): Promise<RemoteJob[]> {
    return [];
  }

  async listPeople(): Promise<RemotePerson[]> {
    return [];
  }

  async listServiceItems(): Promise<RemoteServiceItem[]> {
    return [];
  }

  async listPayrollItems(): Promise<RemotePayrollItem[]> {
    return [];
  }

  async pushTime(entries: PushableTimeEntry[]): Promise<PushResult[]> {
    return entries.map((e) => ({
      localId: e.localId,
      ok: false as const,
      error: "No accounting backend is configured, so approved time stays here.",
      // Not retryable: retrying cannot help until someone changes the config.
      retryable: false,
    }));
  }

  async updateTime(entry: PushableTimeEntry): Promise<PushResult> {
    return (await this.pushTime([entry]))[0]!;
  }

  async deleteTime(): Promise<PushResult> {
    return {
      localId: "",
      ok: false,
      error: "No accounting backend is configured.",
      retryable: false,
    };
  }
}
