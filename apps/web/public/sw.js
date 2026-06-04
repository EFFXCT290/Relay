/* Relay service worker — push notifications ONLY (no offline/asset caching, so
 * there is no stale-bundle risk against the runtime-env/auth/socket flow).
 *
 * SW_VERSION is a manual "ship new SW behavior" lever, NOT a cache version (there
 * is no cache to bust): bump it only to force every client to install+activate a
 * new service worker. skipWaiting + clients.claim make that takeover immediate. */
const SW_VERSION = "1";

// API origin is passed as ?api=... at registration time (register-sw.tsx) so the
// pushsubscriptionchange re-subscribe reaches the API in both dev (cross-port,
// still same-site → cookies flow) and prod (same-origin /api via nginx).
const API_BASE = new URL(self.location.href).searchParams.get("api") || "";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {};
  }
  const title = data.title || "Relay";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge.png",
    // Collapse a burst from the same conversation to the latest notification.
    // NOTE: iOS 16.4+ can silently DROP a renotify on an existing tag instead of
    // replacing it — verify the collapse behavior explicitly during R2.
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    actions: [{ action: "open", title: "Open" }],
    data: { url: data.url || "/conversations", v: data.v, type: data.type },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/conversations";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        // Reuse an open Relay tab; navigate it to the deep link when possible.
        await client.focus();
        if ("navigate" in client) {
          try {
            await client.navigate(url);
          } catch (_) {
            /* cross-origin/last-resort: leave the focused tab as-is */
          }
        }
        return;
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })(),
  );
});

// The browser can rotate a subscription out from under us; re-subscribe with the
// same applicationServerKey and re-register it with the API.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const appServerKey =
          event.oldSubscription && event.oldSubscription.options
            ? event.oldSubscription.options.applicationServerKey
            : undefined;
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: appServerKey || undefined,
        });
        await fetch(`${API_BASE}/api/push/subscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(sub),
        });
      } catch (_) {
        /* best-effort; the app re-subscribes on next launch */
      }
    })(),
  );
});
