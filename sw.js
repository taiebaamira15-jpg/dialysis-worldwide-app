// Dialysis Worldwide – keeps the app shell available offline and shows phone notifications. Data always comes live from Supabase.
const CACHE="dw-app-v4";
const SHELL=["./","index.html","manifest.webmanifest","supabase.js","portal.js","591.supabase.js","jspdf.umd.min.js","icon-192.png","icon-512.png","apple-touch-icon.png","favicon.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener("fetch",e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=="GET"||u.origin!==location.origin) return;           // never cache Supabase / API calls
  // always ask the server for the newest version (no stale browser cache); fall back to the saved copy when offline
  e.respondWith(fetch(e.request.url,{cache:"no-cache",credentials:"same-origin"}).then(r=>{const cp=r.clone(); if(r.ok) caches.open(CACHE).then(c=>c.put(e.request,cp)); return r;}).catch(()=>caches.match(e.request).then(r=>r||caches.match("index.html"))));
});
// ---- phone notifications ----
self.addEventListener("push",e=>{
  let d={}; try{ d=e.data?e.data.json():{}; }catch{ d={body:e.data&&e.data.text()}; }
  e.waitUntil(self.registration.showNotification(d.title||"Dialysis Worldwide",{
    body:d.body||"New activity", icon:"icon-192.png", badge:"icon-192.png", tag:d.tag||undefined, data:{url:d.url||"./#dashboard"}
  }));
});
self.addEventListener("notificationclick",e=>{
  e.notification.close();
  const url=new URL((e.notification.data&&e.notification.data.url)||"./#dashboard",self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(cs=>{
    for(const c of cs){ if(c.url.startsWith(self.registration.scope)){ c.navigate(url).catch(()=>{}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
