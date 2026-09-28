/* Service worker: cache the app shell so it runs offline once installed. */
const CACHE = "shortdeck-v100";
const PREFIX = "shortdeck-";   // other apps share this origin on GitHub Pages
const ASSETS = [
  ".", "index.html", "style.css", "app.js", "stats.js", "hfind.js", "db.js", "vocab.js", "pinyin.js",
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
/* Cache-first, and nothing refreshes a file on its own. Stale-while-revalidate
   healed each file on its own schedule, which builds a version that never
   shipped — a new app.js next to an old vocab.js. It boots, the first render
   touching something the old file lacks throws, and a panel comes up empty
   with dead buttons. Only an install, which replaces the shell all at once,
   may change the cache; app.js calls reg.update() on boot and on every return
   to the front. An offline miss answers the cached shell on a navigation and
   Response.error() otherwise — undefined from respondWith is a blank app. */
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const cached = await c.match(req, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.ok && res.type === "basic") c.put(req, res.clone());
        return res;
      } catch {
        if (req.mode === "navigate") {
          const shell = (await c.match("index.html")) || (await c.match("."));
          if (shell) return shell;
        }
        return Response.error();
      }
    })
  );
});
