import type { AppLoadContext, EntryContext } from "react-router";
import { ServerRouter } from "react-router";
// Import the Web Streams build *explicitly* rather than the bare
// "react-dom/server".
//
// Two reasons, in order of importance:
//
// 1. Correctness under Bun. `react-dom/server` has a `bun` export condition
//    pointing at `server.bun.js`, a CJS shim. Running it under `bun --bun` on
//    Bun 1.3.0 (Windows) dies at import with "Expected CommonJS module to have
//    a function wrapper", which takes the whole server down before it serves a
//    byte. Naming the entry point sidesteps condition resolution entirely.
// 2. Fit. This build speaks Web Streams, which is what Bun's HTTP server and
//    the Fetch `Response` want. The Node build would mean rendering to a Node
//    stream and adapting it back, for nothing.
import { renderToReadableStream } from "react-dom/server.browser";

export const streamTimeout = 5_000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext,
) {
  let didError = false;

  const stream = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: AbortSignal.timeout(streamTimeout),
      onError(error: unknown) {
        // Mark the response 500 but keep rendering: a shell is more useful to
        // the person holding the phone than a blank page.
        didError = true;
        console.error(error);
      },
    },
  );

  // Wait for the complete document instead of streaming it.
  //
  // React emits its streaming-SSR Suspense markers after </html> to hand
  // loader data to the client. When those markers get split across network
  // chunks — which a reverse proxy forwarding chunks eagerly will do — a
  // browser can momentarily mis-parse one and render a stray visible "$".
  // This app has no deferred data, so buffering costs essentially nothing.
  await stream.allReady;

  responseHeaders.set("Content-Type", "text/html");
  return new Response(stream, {
    headers: responseHeaders,
    status: didError ? 500 : responseStatusCode,
  });
}
