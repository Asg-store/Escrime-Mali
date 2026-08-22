/* Escrime Mali — service worker minimal (installabilité + démarrage rapide) */
const CACHE = "escrime-mali-v1";

self.addEventListener("install", (e) => { self.skipWaiting(); });

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // Réseau d'abord, cache en secours (utile hors connexion).
  e.respondWith(
    fetch(req)
      .then((res) => {
        try {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        } catch (err) {}
        return res;
      })
      .catch(() => caches.match(req))
  );
});

