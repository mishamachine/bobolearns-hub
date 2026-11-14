// Bobo Learns service worker: SHELL ONLY. Exists so the site is installable.
// It never caches /login/, /dashboard/, the auth scripts, or any cross-origin
// (API, CDN) or non-GET request. HTML is network-first.
// Bump CACHE_VERSION whenever SHELL changes.
var CACHE_VERSION = "bobo-shell-v1";
var SHELL = [
  "/assets/css/site.css?v=5",
  "/assets/js/site.js?v=5",
  "/assets/js/install.js?v=5",
  "/assets/img/favicon.svg",
  "/assets/img/icon-192.png",
  "/assets/img/bobo/bobo-avatar.svg"
];
// Only these exact static files are ever served from cache. Everything else goes to the network.
var STATIC_OK = /^\/assets\/(css\/site\.css|js\/(site|install)\.js|img\/.+\.(svg|png))$/;
// Pages whose HTML may be kept as an offline fallback (public, no user data).
var PUBLIC_PAGES = ["/", "/privacy/", "/terms/"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE_VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_VERSION; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") { return; }
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) { return; }
  var path = url.pathname;
  if (path.indexOf("/login") === 0 || path.indexOf("/dashboard") === 0) { return; }

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res.ok && PUBLIC_PAGES.indexOf(path) !== -1) {
          var copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) { c.put(path, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(path).then(function (hit) { return hit || caches.match("/"); }).then(function (hit) { return hit || Response.error(); });
      })
    );
    return;
  }

  if (STATIC_OK.test(path)) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          if (res.ok) {
            var copy = res.clone();
            caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
  }
});
