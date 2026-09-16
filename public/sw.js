/* Time Tracker service worker.
 *
 * Makes the installed app start and work with no connection:
 *
 *   build assets     cached at install, served cache-first. Their names are
 *                    content-hashed, so a cached copy is never wrong.
 *   tracking pages   ("/" and "/day/…") network-first; a fresh copy is kept,
 *                    and served when the network or the app is down. The page
 *                    is marked so the app knows it's looking at a kept copy.
 *   icons, manifest  served from cache, refreshed in the background.
 *   /api/, .data     never cached: the app keeps its own data in IndexedDB.
 *
 * `bun run build` replaces the placeholder below with this build's id and
 * file list (scripts/finalize-build.ts), which is also what makes each
 * release a new worker. The one from the previous release is kept until the
 * next, so a page still running old code can finish loading its files.
 *
 * Served unbundled from the site root, so its scope is "/".
 */

const PRECACHE = self.__TT_PRECACHE__;
const BUILD = (PRECACHE && PRECACHE.buildId) || "dev";
const ASSETS = `tt-assets-${BUILD}`;
const PAGES = "tt-pages";
const STATIC = "tt-static";
const META = "tt-meta";
const NAVIGATION_TIMEOUT_MS = 6000;

const isTrackingPage = (path) => path === "/" || /^\/day\/\d{4}-\d{2}-\d{2}$/.test(path);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      if (PRECACHE && PRECACHE.urls.length) {
        const cache = await caches.open(ASSETS);
        await cache.addAll(PRECACHE.urls);
      }
      // Keep the tracking page now, so the very first offline launch works.
      try {
        await keepPage("/", await fetch("/", { credentials: "same-origin" }));
      } catch {
        // Offline or signed out during install: kept on the next visit instead.
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Keep this build's assets and the previous build's; drop older ones.
      const meta = await caches.open(META);
      const previous = await meta.match("/current-build").then((r) => (r ? r.text() : null));
      const keep = new Set([ASSETS, previous && previous !== BUILD ? `tt-assets-${previous}` : null]);
      for (const name of await caches.keys()) {
        if (name.startsWith("tt-assets-") && !keep.has(name)) await caches.delete(name);
      }
      await meta.put("/current-build", new Response(BUILD));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  if (path.startsWith("/api/") || path.endsWith(".data") || path === "/sw.js") return;

  if (request.mode === "navigate") {
    event.respondWith(navigate(event, url));
  } else if (path.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
  } else if (path.startsWith("/icons/") || path === "/manifest.webmanifest" || path === "/favicon.ico") {
    event.respondWith(staleWhileRevalidate(event, request));
  }
});

async function keepPage(path, response) {
  const html = (response.headers.get("content-type") || "").includes("text/html");
  // Never keep a redirect (e.g. to sign-in) or an error in place of the page.
  if (!response.ok || response.redirected || response.type !== "basic" || !html) return;
  const cache = await caches.open(PAGES);
  await cache.put(path, response);
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

async function navigate(event, url) {
  try {
    const response = await withTimeout(fetch(event.request), NAVIGATION_TIMEOUT_MS);
    // The proxy answering for an app that's down counts as down.
    if (response.status >= 502 && response.status <= 504) throw new Error(`upstream ${response.status}`);
    if (isTrackingPage(url.pathname)) event.waitUntil(keepPage(url.pathname, response.clone()));
    return response;
  } catch {
    const kept = await caches.open(PAGES).then((c) => c.match(url.pathname));
    if (kept) return markAsKept(kept);
    return offlinePage(url.pathname);
  }
}

/** Tag a kept page so the app shows it's a saved copy and refreshes when it can. */
async function markAsKept(response) {
  const html = await response.text();
  // The body changes length (and is no longer compressed), so the stored
  // length and encoding headers would be wrong — and a wrong length truncates.
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(html.replace("<head>", '<head><meta name="tt-kept-copy" content="1">'), {
    status: 200,
    headers,
  });
}

function offlinePage(path) {
  const body = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline</title>
<style>:root{color-scheme:light dark}body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem}a{font-weight:600}</style>
</head><body>
<h1>You're offline</h1>
<p>This page (${path.replace(/[<>&"]/g, "")}) hasn't been saved on this device yet.</p>
<p>Time tracking still works offline: <a href="/">open Today</a>.</p>
</body></html>`;
  return new Response(body, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(ASSETS);
    await cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok) return cache.put(request, response.clone()).then(() => response);
      return response;
    })
    .catch(() => hit);
  if (hit) {
    event.waitUntil(refresh);
    return hit;
  }
  return refresh;
}

// ---- Web Push ------------------------------------------------------------------------

// A push arrives as JSON: { title, body, tag?, url? }.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "Time Tracker";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      // A shared tag collapses repeats instead of stacking them.
      tag: payload.tag || "time-tracker",
      renotify: true,
      data: { url: payload.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
