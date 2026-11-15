// App shell, and Web Push. /ws, /api and /healthz always go to the network: agent data is never cached.
// The placeholder in CACHE becomes a hash of the build (web/vite.config.ts), so every deploy is a new worker: it takes over at once and
// deletes the old build's files from the cache.
const CACHE = "lumbridge-shell-__BUILD__";
// For you's chunk and the screens that load as their own (src/lazy-screens.ts), filled in by the build (web/vite.config.ts). index.html
// doesn't name them, so without this an offline start wouldn't find them unless each had been opened online since the deploy. Unbuilt, none.
const CHUNKS = "__CHUNKS__".split(",").filter((u) => u.startsWith("/assets/"));
// The new worker deletes the old build's cache when it takes over, so it fills its own first: the owner can still open the app
// with no network right after a deploy. Best effort; a failure here must not stop the update.
const precache = async () => {
  try {
    const html = await (await fetch("/", { cache: "no-store" })).text();
    // Everything the page itself loads from here: the build under /assets (fonts included), and the root files too (theme-boot.js,
    // the manifest, icons). Missing theme-boot.js, an offline reload after a first visit got the page's HTML in its place.
    const named = [...html.matchAll(/(?:src|href)="(\/(?!\/)[^"]+)"/g)].map((m) => m[1]);
    const assets = [...new Set([...named, ...CHUNKS])].filter((u) => u !== "/sw.js");
    // One by one, not addAll: addAll is all or nothing, so one bad path would silently leave the worker with no cache at all.
    const cache = await caches.open(CACHE);
    await Promise.allSettled(["/", ...assets].map((u) => cache.add(u)));
  } catch { /* the fetch handler fills the cache as pages load */ }
};
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(precache()); });
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname === "/ws" || url.pathname === "/healthz" || url.pathname.startsWith("/api/")) return;
  // Network first, so a deploy shows up immediately; the cache is for a bad connection.
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match("/"))));
});

// Every push must show a notification, whatever it holds, or Apple revokes the subscription.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  const url = typeof d.url === "string" && d.url.startsWith("/") && !d.url.startsWith("//") ? d.url : "/";
  e.waitUntil(Promise.all([
    self.registration.showNotification(typeof d.title === "string" && d.title ? d.title : "Lumbridge", {
      body: typeof d.body === "string" ? d.body : "",
      // One agent, one notification. A new one replaces the old and still buzzes.
      tag: typeof d.tag === "string" && d.tag ? d.tag : "lumbridge",
      renotify: true,
      icon: "/icon-192.png",
      badge: "/icon-badge-96.png",
      // `kind` tells an open page which ones to close when they're answered (web/src/notify.ts).
      data: { url, kind: typeof d.kind === "string" ? d.kind : "" },
    }),
    // Neither of these may get in the way of showing it.
    setIconBadge(d.badge).catch(() => {}),
    self.clients.matchAll({ type: "window" }).then((wins) => { for (const w of wins) w.postMessage({ type: "lumbridge-push" }); }).catch(() => {}),
  ]));
});

// The number on the app icon, with the app closed. An open page corrects it from what it knows. Not every browser has this.
const setIconBadge = async (n) => {
  const nav = self.navigator;
  if (!Number.isInteger(n) || n < 0 || !nav || !nav.setAppBadge) return;
  await (n === 0 && nav.clearAppBadge ? nav.clearAppBadge() : nav.setAppBadge(n));
};

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || "/", location.origin);
  if (target.origin !== location.origin) return;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === location.origin);
    if (!win) return self.clients.openWindow(target.href);
    await win.focus().catch(() => {});
    // The page moves itself (web/src/push.ts). navigate() is the fallback for a page too old to listen.
    win.postMessage({ type: "lumbridge-open", hash: target.hash });
    if ("navigate" in win) await win.navigate(target.href).catch(() => {});
  })());
});

// The push service replaced the subscription. The worker holds no device token, so it renews it here
// and the app reports the new one the next time it opens (initPush in web/src/push.ts).
self.addEventListener("pushsubscriptionchange", (e) => {
  const old = e.oldSubscription;
  if (!e.newSubscription && old) e.waitUntil(self.registration.pushManager.subscribe(old.options).catch(() => {}));
});
