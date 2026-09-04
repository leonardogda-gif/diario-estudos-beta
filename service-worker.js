const CACHE = "bingo-da-rua-v3-1";

const CORE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./vendor/fontawesome/css/all.min.css",
  "./vendor/fontawesome/webfonts/fa-solid-900.woff2",
  "./vendor/fontawesome/webfonts/fa-regular-400.woff2",
  "./vendor/fontawesome/webfonts/fa-brands-400.woff2"
];

const REMOTE = [
  "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js",
  "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"
];

self.addEventListener("install", event => {
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);

    // Core must be present.
    await cache.addAll(CORE);

    // Remote helpers are best-effort. Opaque responses are valid cache entries.
    await Promise.all(
      REMOTE.map(async url=>{
        try{
          const req=new Request(url,{mode:"no-cors"});
          const res=await fetch(req);
          await cache.put(req,res);
        }catch(e){}
      })
    );

    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k.startsWith("bingo-da-rua-") && k !== CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if(event.request.method !== "GET") return;

  const req=event.request;
  const url=new URL(req.url);

  // Release marker: network only. If offline, report unavailable.
  if(url.pathname.endsWith("/version.json")){
    event.respondWith(
      fetch(req,{cache:"no-store"})
        .catch(()=>new Response("",{status:503,statusText:"Offline"}))
    );
    return;
  }

  // App navigation: network first, offline shell fallback.
  if(req.mode==="navigate" || url.pathname.endsWith("/index.html")){
    event.respondWith(
      fetch(req,{cache:"no-store"})
        .then(response=>{
          const copy=response.clone();
          caches.open(CACHE).then(cache=>cache.put("./index.html",copy)).catch(()=>{});
          return response;
        })
        .catch(()=>caches.match("./index.html"))
    );
    return;
  }

  // Static/local/CDN assets: cache first. Cache opaque cross-origin responses too.
  event.respondWith(
    caches.match(req).then(cached=>{
      if(cached) return cached;

      return fetch(req).then(response=>{
        if(response && (response.ok || response.type==="opaque")){
          const copy=response.clone();
          caches.open(CACHE).then(cache=>cache.put(req,copy)).catch(()=>{});
        }
        return response;
      });
    })
  );
});
