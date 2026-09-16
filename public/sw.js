/* Time Tracker service worker.
 *
 * PHASE 0 SCOPE: installability and Web Push only. The fetch handler is a
 * deliberate pass-through — there is no cache yet.
 *
 * Offline caching lands in phase 3, together with the IndexedDB cache and the
 * mutation outbox, because the two only make sense as a pair: a cached app
 * shell with no local data would boot into an error screen and would be harder
 * to debug than a plain network failure. When phase 3 lands, this file gains:
 *   - cache-first for content-hashed build assets (they are immutable)
 *   - network-first with a cached shell fallback for document requests
 *   - never-cache for /api/*, since the client reads its own IndexedDB
 *
 * Served unbundled from public/sw.js at the site root, so its scope is "/".
 */

self.addEventListener("install", () => {
  // Take over immediately rather than waiting for existing tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through. Present because Chrome requires a fetch handler for an app to
// be installable, not because it does anything yet.
self.addEventListener("fetch", () => {});

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
