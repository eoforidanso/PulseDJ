/* =====================================================================
   PULSE DJ — service worker
   ---------------------------------------------------------------------
   Precaches the whole app on install so that, once visited once from a
   real origin (https:// or localhost), it launches and runs fully offline
   — including the vendored React/Babel and the two engine modules the
   AudioWorklet and scheduler load at runtime. This is also what makes the
   app installable ("Install" on desktop, "Add to Home Screen" on mobile):
   an installed PWA is served entirely from this cache, so there is no
   server dependency after the first load.

   Bump CACHE on any asset change — the old cache is dropped on activate.
   ===================================================================== */

const CACHE = 'pulse-dj-v13';

const ASSETS = [
  './',
  'PulseDJ.html',
  'manifest.webmanifest',
  'vendor/react.production.min.js',
  'vendor/react-dom.production.min.js',
  'vendor/babel.min.js',
  'engine/deck-processor.js',
  'engine/scheduler.js',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  'favicon-64.png'
];

self.addEventListener('install', (e)=>{
  // addAll is atomic-ish: if any asset 404s the whole install fails, which
  // is what we want — a half-cached app that breaks offline is worse than
  // a failed install the user can retry.
  e.waitUntil(
    caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate', (e)=>{
  e.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch', (e)=>{
  const req = e.request;
  if(req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only handle same-origin requests; user-dropped audio never hits the
  // network anyway (it's read via FileReader), so there's nothing else to
  // proxy. Cross-origin requests fall through to the network untouched.
  if(url.origin !== self.location.origin) return;

  // Page navigations (typing a URL, opening the installed app, a link with
  // ?cache-bust=... or any other query string, a deep link with a #fragment)
  // must fall back to the cached app shell regardless of the exact query
  // string — an exact-match lookup here means "offline" only works for the
  // one precise URL that was cached, and fails outright for every other
  // variant, including the very first reload after install on some browsers.
  if(req.mode === 'navigate'){
    e.respondWith(
      fetch(req).catch(()=> caches.match('PulseDJ.html', {ignoreSearch:true}))
    );
    return;
  }

  // Cache-first: these assets are content-addressed by the CACHE version,
  // so a hit is always the right bytes. Network is only the cold-load path
  // and the offline fallback populates nothing new (all real assets are
  // precached; a miss here means a genuinely absent file).
  e.respondWith(
    caches.match(req, {ignoreSearch:true}).then(hit=> hit || fetch(req).then(res=>{
      // opportunistically cache anything new we successfully fetch
      if(res && res.ok && res.type === 'basic'){
        const copy = res.clone();
        caches.open(CACHE).then(c=>c.put(req, copy));
      }
      return res;
    }).catch(()=> hit))
  );
});
