// Service worker de remplacement pour l'ancienne adresse /a2-budget/ d'A² Home.
// L'app installée avant le renommage vérifie ses mises à jour ici : ce fichier se désactive,
// supprime les caches de l'ancienne adresse et rouvre l'app à sa nouvelle adresse /a2budget/.
// Les données (localStorage, IndexedDB) ne sont pas touchées : même domaine.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.includes('/a2-budget/')).map((key) => caches.delete(key)));
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: 'window' });
    for (const client of windows) client.navigate(client.url.replace('/a2-budget/', '/a2budget/'));
  })());
});
