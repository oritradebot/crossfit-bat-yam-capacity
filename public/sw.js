/* Service worker — network-first so the app is always fresh online (avoids
   the stale-code problem), with a cache fallback for offline + installability.

   v2 also force-refreshes clients stuck on OLD bundles: builds from before the
   self-update mechanism never check version.json, so installed PWAs kept
   running them for days — with the old data-loss bugs. The browser re-checks
   sw.js on its own (on navigations, and for live pages within ~24h), so a
   changed sw.js is the one update channel that reaches those devices. */
var CACHE = "cfby-cache-v2";

self.addEventListener("install", function () { self.skipWaiting(); });

/* Pages running a current build answer the activation ping (see boot.js) and
   update themselves politely — via checkFreshBundle, never over unsynced data.
   Silence means a pre-ping bundle: force-navigate it. A reload keeps
   localStorage (and the dirty-stamp recovery) intact; staying on the old
   bundle is what loses workouts. */
var alive = {};
self.addEventListener("message", function (e) {
  if (e.data === "cfby-alive" && e.source && e.source.id) alive[e.source.id] = true;
});

self.addEventListener("activate", function (e) {
  e.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    await self.clients.claim();
    var wins = [];
    try { wins = await self.clients.matchAll({ type: "window" }); } catch (err) {}
    wins.forEach(function (c) { try { c.postMessage("cfby-sw-updated"); } catch (err) {} });
    await new Promise(function (r) { setTimeout(r, 3500); });
    wins.forEach(function (c) {
      if (alive[c.id]) return;
      try { c.navigate(c.url).catch(function () {}); } catch (err) {}
    });
  })());
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  // Never cache Supabase or cross-origin API traffic — always go to network.
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
      return res;
    }).catch(function () { return caches.match(req); })
  );
});
