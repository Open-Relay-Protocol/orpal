/* Orpal service worker — minimal offline support + installability.
 *
 * Strategy:
 *   - navigation requests: network-first, falling back to the cached app shell
 *     (so the SPA still opens offline);
 *   - other same-origin GETs (hashed JS/CSS/assets): cache-first, populated on
 *     first fetch.
 * Cross-origin requests (the board WebSocket is not even a fetch) are left alone.
 */
const CACHE = "orpal-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/* ORPAL-016: contentless wake (ORP-009). The board fires a payload-less push on
 * a signaling-channel timeout to wake an offline device. There is NO message
 * content here -- the push only pokes us. We nudge any live app window to
 * reconnect + re-announce (the broker auto-reconnects and presence re-announces
 * on its own once the page is alive), and if the app isn't open we show a
 * minimal notification so the user can reopen it and receive the queued message. */
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) client.postMessage({ type: "orpal-wake" });
      const anyVisible = clients.some((c) => c.visibilityState === "visible");
      if (!anyVisible) {
        await self.registration.showNotification("Orpal", {
          body: "Someone is trying to reach you. Open Orpal to receive your message.",
          tag: "orpal-wake",
          renotify: false,
        });
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clients.find((c) => "focus" in c);
      if (existing) {
        existing.postMessage({ type: "orpal-wake" });
        return existing.focus();
      }
      return self.clients.openWindow("./");
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't touch cross-origin

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./"))),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req).then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
