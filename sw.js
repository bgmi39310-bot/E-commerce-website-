// DesiMarket Service Worker
// Only caches the static app shell (HTML/CSS/JS/images from this site).
// Firebase/Firestore requests always go straight to the network so stock,
// prices, and orders are never served stale from cache.
//
// v2 change: switched from "cache-first" to "network-first". Cache-first was
// the reason the installed PWA kept showing old pages/features (like the
// notification bell, Follow button, etc.) even after the site was updated —
// it always served whatever was cached first and never re-checked the
// network. Network-first always fetches the latest version when online, and
// only falls back to the cache when there's genuinely no connection.

const CACHE_NAME = 'desimarket-shell-v2';

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
    self.skipWaiting(); // activate the new service worker immediately instead of waiting for all tabs to close
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
        )
    );
    self.clients.claim(); // take control of any already-open tabs/installed app right away
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

    if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
        return;
    }

    // Network-first: always try to fetch the freshest copy. Update the cache
    // with whatever we get so offline mode still has something reasonably
    // recent to fall back on. Only use the cache if the network fails.
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                const copy = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});

