import { FastifyInstance } from "fastify";
import { notificationStore } from "../push/notification-store";

export async function pushAcknowledgeRoutes(server: FastifyInstance) {
  server.post<{
    Body: { source: "hawk-ir" | "jitbit"; sourceId: string };
  }>("/push-acknowledge", async (request, reply) => {
    const { source, sourceId } = request.body || {};

    if (!source || !sourceId) {
      return reply.status(400).send({ error: "source and sourceId are required" });
    }

    const alreadyNotified = await notificationStore.hasBeenNotified(source, sourceId);
    if (!alreadyNotified) {
      return reply.status(404).send({ error: "Item not found in notification store" });
    }

    await notificationStore.markAcknowledged(source, sourceId);

    console.log(`[Push] Acknowledged: ${source}:${sourceId} at ${new Date().toISOString()}`);

    return {
      acknowledged: true,
      source,
      sourceId,
      timestamp: new Date().toISOString(),
    };
  });
}
