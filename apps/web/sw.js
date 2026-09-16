'use strict';
const BUILD=(new URL(self.location.href)).searchParams.get('v')||'dev';
const CACHE='ailinux-helper-'+BUILD;
const SHELL='/v1/mcp?app='+encodeURIComponent(BUILD);

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    const response=await fetch(SHELL,{headers:{Accept:'text/html'},cache:'no-store'});
    if(response.ok)await cache.put(SHELL,response.clone());
  })().catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener('activate',event=>{
  event.waitUntil(Promise.all([
    caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE&&(key.startsWith('ailinux-workspace-')||key.startsWith('ailinux-helper-'))).map(key=>caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const navigation=event.request.mode==='navigate'||event.request.destination==='document';
  event.respondWith(fetch(event.request).catch(async()=>{
    if(navigation){
      const shell=await caches.match(SHELL);
      if(shell)return shell;
    }
    return (await caches.match(event.request))||Response.error();
  }));
});
