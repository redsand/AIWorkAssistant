// Handles service worker registration, push subscription, and the "Enable Pager Alerts" UI

let vapidPublicKey = "";

async function fetchVapidKey() {
  try {
    const res = await fetch("/api/push-vapid-key");
    if (res.ok) {
      const data = await res.json();
      vapidPublicKey = data.vapidPublicKey || "";
    }
  } catch {
    console.warn("[Push] Could not fetch VAPID key — push notifications unavailable");
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    console.warn("[Push] Service workers not supported");
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.register("/sw.js");
    console.log("[Push] Service worker registered:", registration.scope);
    return registration;
  } catch (err) {
    console.error("[Push] Service worker registration failed:", err);
    return null;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

function setPagerAlertsBtnVisible(visible) {
  const btn = document.getElementById("pagerAlertsBtn");
  if (btn) btn.style.display = visible ? "" : "none";
}

async function checkExistingSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;

    setPagerAlertsBtnVisible(false);

    // Re-register with the server — the server's in-memory store is wiped on restart
    const token = localStorage.getItem("authToken");
    await fetch("/api/push-subscriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
  } catch {
    // ignore — button stays visible, user can re-enable manually
  }
}

async function enablePagerAlerts() {
  if (!vapidPublicKey) {
    alert("Push notifications are not configured. Ask your admin to set VAPID_PUBLIC_KEY in .env");
    return;
  }

  const registration = await navigator.serviceWorker.ready;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifications not granted");
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });

  const token = localStorage.getItem("authToken");
  const response = await fetch("/api/push-subscriptions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });

  if (!response.ok) {
    throw new Error(`Push subscription failed: ${response.status}`);
  }

  setPagerAlertsBtnVisible(false);
  return subscription;
}

async function disablePagerAlerts() {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await subscription.unsubscribe();
    const token = localStorage.getItem("authToken");
    await fetch("/api/push-subscriptions", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    setPagerAlertsBtnVisible(true);
  }
}

// Expose to global scope for inline onclick handlers
window.enablePagerAlerts = enablePagerAlerts;
window.disablePagerAlerts = disablePagerAlerts;

// Auto-register service worker and fetch VAPID key on page load
registerServiceWorker().then(() => checkExistingSubscription());
fetchVapidKey();
