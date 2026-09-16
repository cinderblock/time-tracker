import { config } from "../config.server.ts";
import { NoAccountingBackend } from "./none.ts";
import { QbBridgeBackend } from "./qb-bridge.ts";
import { type AccountingBackend, BackendUnavailableError } from "./types.ts";
import { WebConnectorBackend } from "./webconnector.ts";

export * from "./types.ts";

let cached: AccountingBackend | undefined;
let override: AccountingBackend | undefined;

/**
 * The configured backend, built once.
 *
 * Selection happens here and nowhere else — no other module should branch on
 * `config.accounting.kind`. A backend that's selected but missing its
 * credentials is a hard failure rather than a silent fallback to standalone:
 * a deployment that asked for QuickBooks and quietly got nothing would look
 * fine right up until payroll.
 */
export function accountingBackend(): AccountingBackend {
  if (override) return override;
  if (cached) return cached;

  cached = build();
  return cached;
}

function build(): AccountingBackend {
  const { accounting } = config;
  switch (accounting.kind) {
    case "none":
      return new NoAccountingBackend();

    case "qb-bridge":
      if (!accounting.bridgeBaseUrl || !accounting.bridgeApiKey) {
        throw new BackendUnavailableError(
          "ACCOUNTING_BACKEND=qb-bridge needs QB_BRIDGE_URL and QB_BRIDGE_API_KEY.",
        );
      }
      return new QbBridgeBackend({ baseUrl: accounting.bridgeBaseUrl, apiKey: accounting.bridgeApiKey });

    case "qb-webconnector":
      if (!accounting.webConnectorPassword) {
        throw new BackendUnavailableError("ACCOUNTING_BACKEND=qb-webconnector needs QBWC_PASSWORD.");
      }
      return new WebConnectorBackend();
  }
}

/** The backend, or why there isn't one — for pages that must render either way. */
export function accountingBackendOrError(): { backend: AccountingBackend; error: null } | { backend: null; error: string } {
  try {
    return { backend: accountingBackend(), error: null };
  } catch (err) {
    if (err instanceof BackendUnavailableError) return { backend: null, error: err.message };
    throw err;
  }
}

/** Test seam: use this backend instead of the configured one (undefined to stop). */
export function setAccountingBackendForTests(backend: AccountingBackend | undefined): void {
  override = backend;
  cached = undefined;
}
