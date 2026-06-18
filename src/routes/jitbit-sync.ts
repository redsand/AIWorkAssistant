import { FastifyInstance } from "fastify";
import { z } from "zod";
import { jitbitSyncService } from "../sync/jitbit-sync-service";
import { requireAuth } from "../middleware/auth";

const jitbitSyncInputSchema = z.object({
  days: z.number().int().min(1).max(90).optional(),
  categoryId: z.number().int().optional(),
  companyId: z.number().int().optional(),
  maxItems: z.number().int().min(1).max(100).optional(),
});

export async function jitbitSyncRoutes(fastify: FastifyInstance) {
  fastify.post("/jitbit", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = jitbitSyncInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }
    return jitbitSyncService.syncFromJitbit(parsed.data);
  });

  fastify.get("/jitbit/status", { preHandler: requireAuth }, async () => {
    return { syncedCount: jitbitSyncService.getSyncedCount() };
  });
}
