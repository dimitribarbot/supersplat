import { version as appVersion } from '../package.json';

// export default null
declare let self: ServiceWorkerGlobalScope;

const cacheName = `superSplat-v${appVersion}`;

const cacheUrls = [
    './',
    './index.css',
    './index.html',
    './index.js',
    './index.js.map',
    './manifest.json',
    './static/icons/logo-192.png',
    './static/icons/logo-512.png',
    './static/images/screenshot-narrow.jpg',
    './static/images/screenshot-wide.jpg',
    './static/lib/webp/webp.mjs',
    './static/lib/webp/webp.wasm',
    './static/locales/de.json',
    './static/locales/en.json',
    './static/locales/fr.json',
    './static/locales/ja.json',
    './static/locales/ko.json',
    './static/locales/zh-CN.json'
];

self.addEventListener('install', (event) => {
    console.log(`installing v${appVersion}`);

    // create cache for current version
    event.waitUntil(
        caches.open(cacheName)
        .then((cache) => {
            cache.addAll(cacheUrls);
        })
    );
});

self.addEventListener('activate', () => {
    console.log(`activating v${appVersion}`);

    // delete the old caches once this one is activated
    caches.keys().then((names) => {
        for (const name of names) {
            if (name !== cacheName) {
                caches.delete(name);
            }
        }
    });
});

self.addEventListener('fetch', (event) => {
    // Only GET requests can ever be served from the cache, so claiming anything
    // else gains nothing -- and costs a lot. A request answered via
    // respondWith() is re-issued by the service worker's own fetch(), which
    // makes the browser report NO XMLHttpRequest upload progress events on the
    // page (neither `progress` nor `load` on xhr.upload). That pinned the
    // render upload's progress bar at 0% for the whole transfer, and it also
    // proxies every multi-hundred-MB export upload for no reason.
    if (event.request.method !== 'GET') return;

    event.respondWith(
        caches.match(event.request)
        .then(response => response ?? fetch(event.request))
    );
});
