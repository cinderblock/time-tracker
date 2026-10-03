import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A pretend push service (the role FCM or Apple's push servers play) for the
 * end-to-end tests; started by Playwright, see playwright.config.ts. The app
 * sends to it with the real `web-push` library — VAPID signature and
 * aes128gcm encryption included — and the test decrypts what arrived with
 * the subscription keys it made up.
 *
 * HTTPS, because push endpoints always are and the library only speaks
 * HTTPS; the certificate is a throwaway made here with openssl, so the app
 * instance that sends to it runs with NODE_TLS_REJECT_UNAUTHORIZED=0.
 *
 *   POST /push/<name>       a message; answers 201, or 410 if <name> was marked gone
 *   GET  /__test/received   everything received: { path, headers, body (base64) }[]
 *   POST /__test/gone       { name } — answer 410 for that subscription from now on
 */

const port = Number(process.env.PORT ?? 3145);
const dir = mkdtempSync(join(tmpdir(), "fake-push-"));
execFileSync(
  "openssl",
  [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2", "-subj", "/CN=127.0.0.1",
  ],
  { stdio: "ignore" },
);

const received: { path: string; headers: Record<string, string>; body: string }[] = [];
const gone = new Set<string>();

Bun.serve({
  port,
  hostname: "127.0.0.1",
  tls: { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/received") return Response.json(received);
    if (url.pathname === "/__test/gone") {
      gone.add(((await request.json()) as { name: string }).name);
      return Response.json({ ok: true });
    }
    const name = url.pathname.match(/^\/push\/([\w-]+)$/)?.[1];
    if (name && request.method === "POST") {
      received.push({
        path: url.pathname,
        headers: Object.fromEntries(request.headers),
        body: Buffer.from(await request.arrayBuffer()).toString("base64"),
      });
      return new Response(null, { status: gone.has(name) ? 410 : 201 });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`fake push service listening on https://127.0.0.1:${port}`);
