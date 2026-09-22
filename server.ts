import { basename } from "node:path";

import { createRequestHandler } from "@react-router/express";
import type { ServerBuild } from "react-router";
import compression from "compression";
import express from "express";
import morgan from "morgan";

import { config } from "./src/config.server.ts";

/**
 * The production server: Express serving the React Router build.
 *
 * Why not `react-router-serve`: this app runs behind a reverse proxy that
 * terminates TLS, so what the browser calls https://example.com reaches the
 * container as plain http. React Router refuses any form action whose Origin
 * header doesn't match the request's own origin — a CSRF guard, and a good
 * one — and the stock server never tells Express to trust the proxy's
 * X-Forwarded-* headers, so every form submission behind a proxy came back
 * "400 Bad Request" before any route code ran. Tracking kept working (its
 * endpoint is a resource route, outside that guard), which made it look
 * like an admin-page bug. Two fixes, either sufficient, both applied:
 *
 *   1. Trust the proxy, so request.url is the origin the browser sees.
 *   2. Tell React Router that PUBLIC_BASE_URL's host is an allowed origin.
 *
 * The routes' own check (assertSameOrigin, exact scheme and host against
 * PUBLIC_BASE_URL) still runs after this, so nothing gets looser.
 */

// The build only exists after `bun run build`. The specifier is a variable so
// that typechecking a clean checkout doesn't go looking for the file.
const BUILD = "./build/server/index.js";
const build = (await import(BUILD)) as ServerBuild;

const app = express();
app.disable("x-powered-by");

// Which proxies' X-Forwarded-* headers to believe. The default covers a
// reverse proxy on this host or a private network (a compose network, say),
// which is where this container is meant to live. Express's own syntax:
// "loopback", "uniquelocal", CIDRs, or "true" for anyone.
app.set("trust proxy", process.env.TRUST_PROXY || "loopback, uniquelocal");

app.use(compression());

// Hashed build assets are immutable; everything else in build/client (the
// service worker, icons) may change between builds.
app.use("/assets", express.static("build/client/assets", { immutable: true, maxAge: "1y" }));
app.use(
  express.static("build/client", {
    maxAge: "1h",
    setHeaders(res, filePath) {
      // The worker script decides when every other cached file is replaced, so
      // it must never be answered from a cache. Browsers already bypass their
      // HTTP cache for it (updateViaCache defaults to "imports"), but a proxy
      // in between doesn't know that rule, and an hour-old worker is an
      // hour-old app.
      if (basename(filePath) === "sw.js") res.setHeader("Cache-Control", "no-cache");
    },
  }),
);

app.use(morgan("tiny"));

const publicHost = new URL(config.publicBaseUrl).host;
app.use(createRequestHandler({ build: { ...build, allowedActionOrigins: [publicHost] } }));

app.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}, serving ${config.publicBaseUrl}`);
});
