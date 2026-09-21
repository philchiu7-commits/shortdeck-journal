/* Service worker: cache the app shell so it runs offline once installed. */
const CACHE = "shortdeck-v35";
const PREFIX = "shortdeck-";   // other apps share this origin on GitHub Pages
const ASSETS = [
  ".", "index.html", "style.css", "app.js", "stats.js", "db.js", "vocab.js", "pinyin.js",
  "import.html", "convert.html",
  "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  // cache:"reload" skips the HTTP cache so a version bump always ships fresh files
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  // only our own old caches: Cache Storage is per-origin, and sibling apps
  // (poker-journal, range-lab, squid-web) share it on GitHub Pages
  e.waitUntil(caches.keys().then((ks) =>
    Promise.all(ks.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
// Stale-while-revalidate for same-origin GETs: serve the cached copy instantly,
// then refresh it from the network in the background. So a deploy that bumps app
// assets but NOT the CACHE name still self-heals one reload later; a CACHE bump is
// only needed to force an immediate purge. Cross-origin / non-GET fall through.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const cached = await c.match(req, { ignoreSearch: true });
      const net = fetch(req)
        .then((res) => { if (res && res.ok && res.type === "basic") c.put(req, res.clone()); return res; })
        .catch(() => cached);
      // Serving the cached copy resolves respondWith immediately; keep the SW
      // alive with waitUntil so the background refresh's c.put actually persists
      // (iOS can otherwise kill the worker right after respondWith settles).
      if (cached) { e.waitUntil(net); return cached; }
      return net;
    })
  );
});
