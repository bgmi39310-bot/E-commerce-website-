// DesiMarket Service Worker
// Only caches the static app shell (HTML/CSS/JS/images from this site).
// Firebase/Firestore requests always go straight to the network so stock,
// prices, and orders are never served stale from cache.

const CACHE_NAME = 'desimarket-shell-v1';

const APP_SHELL = [
    './index.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Never intercept Firebase/Firestore/Google API calls — always fetch live.
    if (
        url.origin.includes('firebaseio.com') ||
        url.origin.includes('googleapis.com') ||
        url.origin.includes('gstatic.com') ||
        url.origin.includes('firebaseapp.com')
    ) {
        return; // let the browser handle it normally
    }

    // Only handle same-origin GET requests for the app shell; cache-first with network fallback.
    if (event.request.method === 'GET' && url.origin === self.location.origin) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                return cached || fetch(event.request).catch(() => cached);
            })
        );
    }
});

