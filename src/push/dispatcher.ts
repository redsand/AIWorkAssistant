import webpush from "web-push";
import { env } from "../config/env";

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  urgency?: "very-low" | "low" | "normal" | "high";
  requireInteraction?: boolean;
  tag?: string;
  source?: string;
  sourceId?: string;
  severity?: "page" | "urgent" | "info";
}

export interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

let initialized = false;

export function initPushDispatcher(): void {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.warn(
      "[Push] VAPID keys not configured — push notifications disabled"
    );
    return;
  }

  webpush.setVapidDetails(
    env.VAPID_ADMIN_EMAIL ||
      env.VAPID_SUBJECT ||
      "mailto:admin@ai-work-assistant.example",
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );
  initialized = true;
  console.log("[Push] VAPID dispatcher initialized");
}

export async function sendPushNotification(
  subscription: PushSubscriptionData,
  message: PushMessage
): Promise<boolean> {
  if (!initialized) {
    console.warn("[Push] Dispatcher not initialized — skipping push");
    return false;
  }

  const payload = JSON.stringify({
    title: message.title,
    body: message.body,
    url: message.url,
    source: message.source,
    sourceId: message.sourceId,
    severity: message.severity,
    tag: message.tag,
  });

  try {
    await webpush.sendNotification(subscription as any, payload, {
      urgency: message.urgency || "normal",
      TTL: 300,
    });
    return true;
  } catch (err: any) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      console.warn(
        `[Push] Subscription expired (410/404): ${subscription.endpoint.slice(-20)}`
      );
      return false;
    }
    console.error(`[Push] Send failed:`, err.message);
    return false;
  }
}
