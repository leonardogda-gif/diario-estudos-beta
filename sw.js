const CACHE_NAME="diario-estudos-v5.26";
const STATIC_ASSETS=["./manifest.json"];
self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(STATIC_ASSETS)).catch(()=>{}));
});
self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});
self.addEventListener("message",event=>{
  if(event.data?.type==="SKIP_WAITING")self.skipWaiting();
});
self.addEventListener("fetch",event=>{
  const req=event.request;
  if(req.method!=="GET")return;
  const url=new URL(req.url);

  if(url.origin===self.location.origin && url.pathname.endsWith("/version.json")){
    event.respondWith(fetch(req,{cache:"no-store"}));
    return;
  }

  if(req.mode==="navigate"){
    event.respondWith(
      fetch(req,{cache:"no-store"})
        .then(response=>{
          const copy=response.clone();
          caches.open(CACHE_NAME).then(cache=>cache.put("./index.html",copy)).catch(()=>{});
          return response;
        })
        .catch(()=>caches.match("./index.html").then(cached=>cached||caches.match("./")))
    );
    return;
  }

  if(url.origin===self.location.origin){
    if(url.pathname.includes("/videos/")){
      event.respondWith(fetch(req));
      return;
    }
    event.respondWith(
      caches.match(req).then(cached=>cached||fetch(req).then(response=>{
        if(response&&response.ok){
          const copy=response.clone();
          caches.open(CACHE_NAME).then(cache=>cache.put(req,copy)).catch(()=>{});
        }
        return response;
      }))
    );
  }
});