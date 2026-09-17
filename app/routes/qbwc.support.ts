import { accountingBackendOrError } from "../../src/accounting/index.ts";
import { xmlText } from "../../src/accounting/qbxml.ts";
import { branding } from "../../src/branding.ts";

/**
 * /qbwc/support — the support page the .qwc file points at. The Web
 * Connector requires one on the same host as the endpoint and links to it
 * from its window.
 */
export function loader() {
  if (accountingBackendOrError().backend?.kind !== "qb-webconnector") {
    return new Response("Not Found", { status: 404 });
  }
  const name = xmlText(branding().name);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} · QuickBooks Web Connector</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5}</style>
</head><body>
<h1>${name}</h1>
<p>This connection sends approved time from ${name} to QuickBooks, and brings QuickBooks' customer, job,
employee and item lists back.</p>
<ul>
<li>It runs every few minutes while the Web Connector is open and QuickBooks can open the company file.</li>
<li>If it reports an error, sign in to ${name} as an admin and open <strong>Accounting</strong>: every attempt and
its outcome is listed there.</li>
<li>If the password was changed, update it in the Web Connector's Password column.</li>
</ul>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
