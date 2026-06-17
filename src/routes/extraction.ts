import { FastifyInstance } from "fastify";
import { z } from "zod";
import { extractionService } from "../extraction/extraction-service";

const extractionInputSchema = z.object({
  conversationText: z.string().min(1),
  context: z.string().optional(),
  maxItems: z.number().int().min(1).max(50).optional(),
});

const extractedItemSchema = z.object({
  type: z.enum([
    "task",
    "decision",
    "code_review",
    "roadmap",
    "customer_followup",
    "detection",
    "research",
    "personal",
    "support",
    "release",
  ]),
  title: z.string().min(1),
  description: z.string(),
  priority: z.enum(["low", "medium", "high", "critical"]),
  source: z.enum([
    "chat",
    "jira",
    "github",
    "gitlab",
    "jitbit",
    "calendar",
    "manual",
    "roadmap",
  ]),
  tags: z.array(z.string()).optional(),
  dueAt: z.string().optional(),
});

const createItemsSchema = z.array(extractedItemSchema).max(50);

export async function extractionRoutes(fastify: FastifyInstance) {
  fastify.post("/extract", async (request, reply) => {
    const parsed = extractionInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }
    return extractionService.extractWorkItems(parsed.data);
  });

  fastify.post("/create", async (request, reply) => {
    const parsed = createItemsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }
    const createdIds = await extractionService.createExtractedItems(parsed.data);
    return { created: createdIds };
  });
}
