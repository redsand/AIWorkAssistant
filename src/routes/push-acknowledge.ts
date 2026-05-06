import { FastifyInstance } from "fastify";

// Acknowledge endpoint — stops escalation when user taps "Acknowledge" on a notification
export async function pushAcknowledgeRoutes(server: FastifyInstance) {
  server.post<{
    Body: { source: string; sourceId: string };
  }>("/push-acknowledge", async (request, reply) => {
    const { source, sourceId } = request.body || {};

    if (!source || !sourceId) {
      return reply
        .status(400)
        .send({ error: "source and sourceId are required" });
    }

    console.log(
      `[Push] Acknowledged: ${source}:${sourceId} by user at ${new Date().toISOString()}`
    );

    return {
      acknowledged: true,
      source,
      sourceId,
      timestamp: new Date().toISOString(),
    };
  });
}
