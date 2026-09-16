import { config } from "../config.ts";
import { NoAccountingBackend } from "./none.ts";
import { type AccountingBackend, BackendUnavailableError } from "./types.ts";

export * from "./types.ts";

let cached: AccountingBackend | undefined;

/**
 * The configured backend, built once.
 *
 * Selection happens here and nowhere else — no other module should branch on
 * `config.accounting.kind`.
 */
export function accountingBackend(): AccountingBackend {
  if (cached) return cached;

  switch (config.accounting.kind) {
    case "none":
      cached = new NoAccountingBackend();
      break;

    case "qb-bridge":
      // Phase 5. Deliberately a hard failure at startup rather than a silent
      // fallback to standalone: a deployment that asked for QuickBooks and
      // quietly got nothing would look fine right up until payroll.
      throw new BackendUnavailableError(
        "ACCOUNTING_BACKEND=qb-bridge is not implemented yet (phase 5). " +
          "Use ACCOUNTING_BACKEND=none until the bridge write endpoints exist.",
      );

    case "qb-webconnector":
      throw new BackendUnavailableError(
        "ACCOUNTING_BACKEND=qb-webconnector is not implemented yet (phase 6). " +
          "Use ACCOUNTING_BACKEND=none for now.",
      );
  }

  return cached;
}

/** Test seam: drop the memoized backend. */
export function resetAccountingBackend(): void {
  cached = undefined;
}
