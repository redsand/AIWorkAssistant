import { FastifyInstance } from "fastify";
import { env } from "../config/env";

interface PushSubscriptionData {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

// In-memory store for MVP; replace with database for production
const subscriptions = new Map<
  string,
  {
    id: string;
    userId: string;
    subscription: PushSubscriptionData;
    createdAt: string;
  }
>();

export async function pushSubscriptionRoutes(server: FastifyInstance) {
  // Expose VAPID public key so the frontend can subscribe to push notifications
  server.get("/push-vapid-key", async () => {
    return { vapidPublicKey: env.VAPID_PUBLIC_KEY };
  });

  server.post<{
    Body: { subscription: PushSubscriptionData; userId?: string };
  }>("/push-subscriptions", async (request, reply) => {
    const { subscription, userId } = request.body || {};

    if (!subscription?.endpoint) {
      return reply
        .status(400)
        .send({ error: "subscription with endpoint is required" });
    }

    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry = {
      id,
      userId: userId || "anonymous",
      subscription,
      createdAt: new Date().toISOString(),
    };

    subscriptions.set(subscription.endpoint, entry);

    console.log(`[Push] Subscription registered: ${id}`);
    return { ok: true, id };
  });

  server.delete<{
    Body: { endpoint: string };
  }>("/push-subscriptions", async (request, reply) => {
    const { endpoint } = request.body || {};

    if (!endpoint) {
      return reply.status(400).send({ error: "endpoint is required" });
    }

    const deleted = subscriptions.delete(endpoint);
    console.log(
      `[Push] Subscription removed: ${endpoint} (existed: ${deleted})`
    );
    return { ok: true, deleted };
  });

  server.get("/push-subscriptions", async () => {
    return Array.from(subscriptions.values());
  });
}

export function getAllSubscriptions(): PushSubscriptionData[] {
  return Array.from(subscriptions.values()).map((e) => e.subscription);
}
