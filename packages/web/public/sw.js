// Keeps the app itself available offline. Only this site's own files are cached; Microsoft Graph and sign-in
// requests are never touched, so private data never lands in this cache.
const CACHE = "stepup-shell-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Hashed build files never change: cache first. Everything else (the page, manifest, reference data): network first, cache as fallback.
  const immutable = url.pathname.includes("/assets/");
  event.respondWith(
    immutable
      ? caches.match(req).then((hit) => hit || fetchAndStore(req))
      : fetchAndStore(req).catch(() => caches.match(req).then((hit) => hit || caches.match(new URL("./", self.location.href))))
  );
});

async function fetchAndStore(req) {
  const res = await fetch(req);
  if (res.ok && res.type === "basic") {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
}
