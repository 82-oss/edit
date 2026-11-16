// Edit's notifications in a browser (apps/web/src/lib/notices.ts): shown from
// here, as a service worker, so a browser that won't show one from a page (a
// phone's Chrome) still does, and a click brings Edit's tab forward on the
// notice's page. It caches nothing and handles no requests.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (event) => {
  const path = typeof event.notification.data?.path === "string" && event.notification.data.path.startsWith("/") ? event.notification.data.path : "/";
  event.notification.close();
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const tab = open.find((one) => new URL(one.url).origin === self.location.origin);
      if (tab !== undefined) {
        await tab.focus();
        tab.postMessage({ type: "edit:open", path });
        return;
      }
      await self.clients.openWindow(path);
    })(),
  );
});
