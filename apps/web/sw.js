'use strict';
const BUILD=(new URL(self.location.href)).searchParams.get('v')||'dev';
// Control documents must never be restored from an obsolete cached build.
// Installed Helper clients keep their IndexedDB grants and session credentials;
// only service-worker-managed cached HTML is retired.
self.addEventListener('install',event=>{ self.skipWaiting(); });
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key.startsWith('ailinux-workspace-')||key.startsWith('ailinux-helper-')).map(key=>caches.delete(key)));
    await self.clients.claim();
  })());
});
