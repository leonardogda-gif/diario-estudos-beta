const CACHE_NAME = "diario-estudos-v4.7.4.1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./version.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)));
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
  if(url.origin!==self.location.origin)return;

  if(url.pathname.endsWith("/version.json")){
    event.respondWith(fetch(req,{cache:"no-store"}).catch(()=>caches.match("./version.json")));
    return;
  }

  if(req.mode==="navigate"){
    event.respondWith(
      fetch(req,{cache:"no-store"})
        .then(response=>{
          if(response && response.status===200){
            const copy=response.clone();
            caches.open(CACHE_NAME).then(cache=>cache.put("./index.html",copy));
          }
          return response;
        })
        .catch(()=>caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached=>cached || fetch(req,{cache:"no-cache"}).then(response=>{
      if(response && response.status===200){
        const copy=response.clone();
        caches.open(CACHE_NAME).then(cache=>cache.put(req,copy));
      }
      return response;
    }))
  );
});
