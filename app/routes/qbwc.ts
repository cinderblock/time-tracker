import { accountingBackendOrError } from "../../src/accounting/index.ts";
import { SoapError, handleWebConnectorCall, soapFault } from "../../src/accounting/webconnector.ts";
import type { Route } from "./+types/qbwc";

/**
 * /qbwc — the SOAP endpoint the QuickBooks Web Connector calls. It signs in
 * with its own user name and password (QBWC_USERNAME / QBWC_PASSWORD), not a
 * session, so there's no cookie or same-origin check here. Answers 404 unless
 * the Web Connector is the configured backend.
 */

/** The largest message accepted: a list pull from a big company file. */
const MAX_BODY_BYTES = 50 * 1024 * 1024;

const enabled = () => accountingBackendOrError().backend?.kind === "qb-webconnector";

export async function action({ request }: Route.ActionArgs) {
  if (!enabled()) return new Response("Not Found", { status: 404 });
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) {
    return new Response("Too large", { status: 413 });
  }
  const body = await request.text();
  const xml = (status: number, text: string) =>
    new Response(text, { status, headers: { "Content-Type": "text/xml; charset=utf-8" } });
  try {
    const outcome = handleWebConnectorCall(body);
    if (outcome.delayMs) await new Promise((resolve) => setTimeout(resolve, outcome.delayMs));
    return xml(200, outcome.body);
  } catch (err) {
    if (err instanceof SoapError) return xml(500, soapFault(err.message));
    throw err;
  }
}

/** A browser (or the Web Connector checking the address) gets a plain answer. */
export function loader() {
  if (!enabled()) return new Response("Not Found", { status: 404 });
  return new Response("QuickBooks Web Connector endpoint. Add this app to the Web Connector with its .qwc file.", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
