// Service worker for AI Work Assistant push notifications

self.addEventListener("install", (event) => {
  console.log("[SW] Service worker installed");
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  console.log("[SW] Service worker activated");
  event.waitUntil(clients.claim());
});

self.addEventListener("push", (event) => {
  const data = event.data?.json() || {};

  const actions =
    data.severity === "page"
      ? [{ action: "acknowledge", title: "✅ Acknowledge" }]
      : [{ action: "view", title: "👁 View" }];

  event.waitUntil(
    self.registration.showNotification(data.title || "AI Assistant Alert", {
      body: data.body || "Action needed",
      icon: "/icon-192.png",
      badge: "/badge.png",
      data: {
        url: data.url || "/",
        source: data.source || "",
        sourceId: data.sourceId || "",
      },
      requireInteraction: data.severity === "page" || false,
      actions,
      tag: data.tag || undefined,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "acknowledge" && event.notification.data?.sourceId) {
    // Fire-and-forget acknowledge to stop escalation
    fetch("/api/push-acknowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: event.notification.data.source,
        sourceId: event.notification.data.sourceId,
      }),
    }).catch(() => {});
  }

  const url = event.notification.data?.url || "/";
  event.waitUntil(clients.openWindow(url));
});
