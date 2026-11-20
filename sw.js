/* Rainbow Cinema — Service Worker v4 */
const CACHE_SHELL = 'rainbow-shell-v4';
const CACHE_IMGS  = 'rainbow-img-v4';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/* ---------- Installation ---------- */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_SHELL)
      .then(c => Promise.allSettled(PRECACHE.map(u => c.add(u)))) // un 404 ne casse plus l'install
      .then(() => self.skipWaiting())
  );
});

/* ---------- Activation + nettoyage des anciens caches (v3, etc.) ---------- */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(
      ks.filter(k => k !== CACHE_SHELL && k !== CACHE_IMGS).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

/* ---------- Limitation de la taille du cache images ---------- */
async function trimCache(cache, max) {
  const keys = await cache.keys();
  if (keys.length <= max) return;
  await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k)));
}

/* ---------- Stratégies de requêtes ---------- */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  /* 1) NAVIGATION (pages) : réseau d'abord, repli cache si hors-ligne.
     → tu récupères tes mises à jour d'index.html sans changer le nom du cache */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_SHELL).then(c => c.put('./', copy));
        return res;
      }).catch(() => caches.match('./').then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  /* 2) MÊME ORIGINE (icônes, videos.json, sw, css...) :
     cache immédiat + revalidation en arrière-plan (stale-while-revalidate).
     → videos.json reste frais à la visite suivante, mais dispo hors-ligne */
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(hit => {
        const network = fetch(req).then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_SHELL).then(c => c.put(req, copy));
          }
          return res;
        });
        return hit || network.catch(() => Response.error());
      })
    );
    return;
  }

  /* 3) IMAGES ARCHIVE.ORG (vignettes) : cache d'abord, limité à 400 entrées.
     → la grille s'affiche instantanément, même en 4G faible ou hors-ligne */
  if (url.hostname.endsWith('archive.org') &&
      (/\.(png|jpe?g|webp)$/i.test(url.pathname) || url.pathname.includes('/services/img/'))) {
    e.respondWith(
      caches.open(CACHE_IMGS).then(async c => {
        const hit = await c.match(req, { ignoreSearch: true });
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok || res.type === 'opaque') {
            c.put(req, res.clone());
            trimCache(c, 400);
          }
          return res;
        } catch {
          return hit || Response.error();
        }
      })
    );
    return;
  }

  /* 4) TOUT LE RESTE (vidéos archive.org, flux radio, proxies CORS) :
     AUCUNE interception → streaming natif + cache HTTP du navigateur.
     C'est volontaire : mettre en cache des vidéos de 500 Mo casserait le
     streaming par plages (Range) et saturait le stockage mobile. */
});
