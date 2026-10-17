// DraftOtter service worker: keeps the app (one HTML file plus icons) on the device so it opens and works offline.
// A new deploy changes BUILD, which installs a new copy in the background; the page then offers to reload.
const BUILD = '__BUILD__';
const CACHE = 'localcad-' + BUILD;
const ASSETS = ['./', './manifest.webmanifest', './icons/draftotter-192.png', './icons/draftotter-512.png', './icons/draftotter-maskable-512.png', './icons/draftotter-apple-touch.png'];

self.addEventListener('install', (e) => {
	e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))));
	// the first install takes over right away; updates wait until the page agrees (see 'skip-waiting')
	if (!self.registration.active) self.skipWaiting();
});

self.addEventListener('activate', (e) => {
	e.waitUntil((async () => {
		for (const k of await caches.keys()) if (k.startsWith('localcad-') && k !== CACHE) await caches.delete(k);
		await self.clients.claim();
	})());
});

self.addEventListener('message', (e) => {
	if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
	const req = e.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	if (url.origin !== location.origin) return;
	// the app itself: from the cache (instant, offline); the network only when it isn't cached yet
	const key = req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html') ? './' : req;
	e.respondWith((async () => {
		const cache = await caches.open(CACHE);
		const hit = await cache.match(key, { ignoreSearch: true });
		if (hit) return hit;
		try {
			const res = await fetch(req);
			if (res.ok && res.type === 'basic') cache.put(key, res.clone());
			return res;
		} catch (err) {
			const fallback = await cache.match('./');
			if (fallback && req.mode === 'navigate') return fallback;
			throw err;
		}
	})());
});
