// The survey app moved to ../Survey/. This replaces the old service worker of this folder and
// removes itself, so phones that installed the app here are sent on to the new address.
// Caches and saved survey data are left alone: the app in ../Survey/ uses the same ones.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate('../Survey/');
  })());
});
