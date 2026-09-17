import { bridgeResponse } from "../src/testing/fake-bridge.ts";
import { LostAnswer, sampleCompany } from "../src/testing/fake-quickbooks.ts";

/**
 * A pretend QB Bridge for the end-to-end tests (started by Playwright; see
 * playwright.config.ts). `/__test/*` lets a test look inside and misbehave:
 *
 *   GET  /__test/state   the pretend company file's time records and customers
 *   POST /__test/down    { down: boolean } — answer as the bridge does when it can't open QuickBooks
 *   POST /__test/fail    { code, message } — refuse the next request
 */

const port = Number(process.env.PORT ?? 3141);
const apiKey = process.env.QB_BRIDGE_API_KEY ?? "e2e-bridge-key";
const qb = sampleCompany();
let down = false;

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/state") {
      return Response.json({ records: qb.summary(), customers: qb.customers.map((c) => ({ ...c, fullName: qb.fullNameOf(c.id) })) });
    }
    if (url.pathname === "/__test/down") {
      down = Boolean(((await request.json()) as { down?: boolean }).down);
      return Response.json({ down });
    }
    if (url.pathname === "/__test/fail") {
      const { code, message } = (await request.json()) as { code: number; message?: string };
      qb.failNext(code, message);
      return Response.json({ ok: true });
    }
    if (down) {
      return Response.json(
        { ok: false, error: { code: "QBConnectionError", message: "Could not open the company file", qb_status_code: null } },
        { status: 502 },
      );
    }
    try {
      return await bridgeResponse(qb, { apiKey }, request);
    } catch (err) {
      if (err instanceof LostAnswer) return new Response("", { status: 502 });
      throw err;
    }
  },
});

console.log(`fake QB Bridge listening on http://127.0.0.1:${port}`);
