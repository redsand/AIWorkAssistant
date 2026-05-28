import { FastifyInstance } from "fastify";
import { getEscalationConfig, setEscalationConfig } from "../push/escalation/config-store";

export async function escalationConfigRoutes(fastify: FastifyInstance) {
  fastify.get("/escalation-config", async () => {
    return getEscalationConfig();
  });

  fastify.put("/escalation-config", async (request, reply) => {
    const body = request.body as {
      globalEnabled?: boolean;
      sources?: { source: string; enabled: boolean }[];
    };

    const validSources = ["hawk-ir", "jitbit"];
    if (body.sources) {
      for (const s of body.sources) {
        if (!validSources.includes(s.source)) {
          return reply.code(400).send({ error: `Unknown source: ${s.source}` });
        }
      }
    }

    setEscalationConfig(body as Parameters<typeof setEscalationConfig>[0]);
    return getEscalationConfig();
  });
}
