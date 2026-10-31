// Dialysis Worldwide – keeps the app shell available offline. Data always comes live from Supabase.
const CACHE="dw-app-v1";
const SHELL=["./","index.html","manifest.webmanifest","supabase.js","591.supabase.js","jspdf.umd.min.js","icon-192.png","icon-512.png","apple-touch-icon.png","favicon.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener("fetch",e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=="GET"||u.origin!==location.origin) return;           // never cache Supabase / API calls
  e.respondWith(fetch(e.request).then(r=>{const cp=r.clone(); caches.open(CACHE).then(c=>c.put(e.request,cp)); return r;}).catch(()=>caches.match(e.request).then(r=>r||caches.match("index.html"))));
});
