// Keeps the app itself available offline. Only this site's own files are cached; Microsoft Graph and sign-in
// requests are never touched, so private data never lands in this cache.
const CACHE = "stepup-shell-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((n) => n.startsWith("stepup-shell-") && n !== CACHE).map((n) => caches.delete(n)))).then(() => self.clients.claim())
  );
});

// Files shared to the installed app from another app's Share menu (see share_target in manifest.webmanifest).
// They are parked in the same device-only cache as downloaded receipts (emptied on Sign out), and the page adds them
// to the unattached files once it is signed in. Always answers with a redirect so a refresh never re-posts them.
async function receiveShare(req) {
  try {
    const files = (await req.formData()).getAll("files").filter((f) => typeof f !== "string");
    const cache = await caches.open("stepup-docs");
    const stamp = Date.now();
    await Promise.all(files.map((f, i) => cache.put(
      `https://shared.local/${stamp}-${i}`,
      new Response(f, { headers: { "Content-Type": f.type || "application/octet-stream", "X-File-Name": encodeURIComponent(f.name || "Shared file") } })
    )));
  } catch {
    /* nothing usable arrived; the app just opens */
  }
  return Response.redirect(new URL("./?shared=1", self.location.href).href, 303);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === "POST" && url.origin === self.location.origin && url.pathname.endsWith("/share-target")) {
    event.respondWith(receiveShare(req));
    return;
  }
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
