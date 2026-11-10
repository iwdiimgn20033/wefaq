/* Offline support. Shared couple data (/api) always goes to the server and is never cached. */
const C="wifaq-v4",CORE=["./","manifest.webmanifest","icon-192.png","icon-512.png","apple-touch-icon.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(CORE)));self.skipWaiting()});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener("fetch",e=>{
 const r=e.request,u=new URL(r.url);
 if(r.method!=="GET"||u.origin!==location.origin||u.pathname.startsWith("/api/"))return;
 if(r.mode==="navigate"||u.pathname==="/"||u.pathname.endsWith(".html")){
  e.respondWith(fetch(r).then(res=>{const cp=res.clone();caches.open(C).then(c=>c.put("./",cp));return res}).catch(()=>caches.match("./")));return}
 e.respondWith(caches.match(r).then(hit=>hit||fetch(r).then(res=>{const cp=res.clone();caches.open(C).then(c=>c.put(r,cp));return res})));
});
/* phone notifications */
self.addEventListener("push",e=>{
 let d={};try{d=e.data?e.data.json():{}}catch(x){d={body:e.data?e.data.text():""}}
 e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(cs=>{
  if(cs.some(c=>c.visibilityState==="visible"&&c.focused))return;
  return self.registration.showNotification(d.title||"ميزان الوفاق",{body:d.body||"لديك تحديث جديد",icon:"icon-192.png",badge:"icon-192.png",tag:d.tag||"wifaq",renotify:true,dir:"rtl",lang:"ar",data:{url:d.url||"/#journal"}})}))});
self.addEventListener("notificationclick",e=>{
 e.notification.close();const url=(e.notification.data&&e.notification.data.url)||"/#journal";
 e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(cs=>{
  for(const c of cs){if("focus"in c){if(c.navigate)c.navigate(url).catch(()=>{});return c.focus()}}
  return self.clients.openWindow(url)}))});
