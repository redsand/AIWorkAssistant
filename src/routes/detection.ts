import { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { detectionAssistant } from "../detection/detection-assistant.js";
import type { DetectionIdeaOutput } from "../detection/types.js";

const DetectionIdeaInputSchema = z.object({
  name: z.string(),
  description: z.string(),
  dataSource: z.string().optional(),
  mitreTechniques: z.array(z.string()).optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
});

const MitreMappingInputSchema = z.object({
  technique: z.string().optional(),
  tactic: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
});

const DetectionReviewInputSchema = z.object({
  name: z.string(),
  logic: z.string(),
  format: z.string().optional(),
});

const DetectionWorkItemInputSchema = z.object({
  idea: z.custom<DetectionIdeaOutput>((val) =>
    val != null && typeof val === "object" && "workItems" in (val as DetectionIdeaOutput)
  ),
  priority: z.string().optional(),
  assignToJira: z.boolean().optional(),
});

const CoverageGapInputSchema = z.object({
  existingDetections: z.array(z.string()).optional(),
  mitreTechniques: z.array(z.string()).optional(),
  dataSources: z.array(z.string()).optional(),
});

function parseRequest<T>(schema: z.ZodSchema<T>, payload: unknown, reply: FastifyReply): T | null {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    reply.status(400).send({
      error: "Validation failed",
      details: parsed.error.issues,
    });
    return null;
  }
  return parsed.data;
}

export async function detectionRoutes(fastify: FastifyInstance) {
  fastify.post("/detection/idea", async (request, reply) => {
    const input = parseRequest(DetectionIdeaInputSchema, request.body, reply);
    if (!input) return;
    try {
      fastify.log.info({ route: "/detection/idea", name: input.name }, "Generating detection idea");
      const result = await detectionAssistant.generateDetectionIdea(input);
      fastify.log.info({ route: "/detection/idea", name: input.name }, "Detection idea generated");
      return result;
    } catch (error) {
      fastify.log.error({ route: "/detection/idea", error }, "Failed to generate detection idea");
      reply.status(500).send({ error: "Failed to generate detection idea" });
      return;
    }
  });

  fastify.post("/detection/mitre", async (request, reply) => {
    const input = parseRequest(MitreMappingInputSchema, request.body, reply);
    if (!input) return;
    try {
      fastify.log.info({ route: "/detection/mitre", technique: input.technique }, "Mapping to MITRE");
      const result = await detectionAssistant.mapToMitre(input);
      fastify.log.info({ route: "/detection/mitre", technique: input.technique }, "MITRE mapping completed");
      return result;
    } catch (error) {
      fastify.log.error({ route: "/detection/mitre", error }, "Failed to map to MITRE");
      reply.status(500).send({ error: "Failed to map to MITRE" });
      return;
    }
  });

  fastify.post("/detection/tests", async (request, reply) => {
    const input = parseRequest(DetectionIdeaInputSchema, request.body, reply);
    if (!input) return;
    try {
      fastify.log.info({ route: "/detection/tests", name: input.name }, "Generating detection tests");
      const result = await detectionAssistant.generateTestCases(input);
      fastify.log.info({ route: "/detection/tests", name: input.name, count: result.length }, "Detection tests generated");
      return result;
    } catch (error) {
      fastify.log.error({ route: "/detection/tests", error }, "Failed to generate detection tests");
      reply.status(500).send({ error: "Failed to generate detection tests" });
      return;
    }
  });

  fastify.post("/detection/review", async (request, reply) => {
    const input = parseRequest(DetectionReviewInputSchema, request.body, reply);
    if (!input) return;
    try {
      fastify.log.info({ route: "/detection/review", name: input.name }, "Reviewing detection logic");
      const result = await detectionAssistant.reviewDetectionLogic(input);
      fastify.log.info({ route: "/detection/review", name: input.name }, "Detection logic reviewed");
      return result;
    } catch (error) {
      fastify.log.error({ route: "/detection/review", error }, "Failed to review detection logic");
      reply.status(500).send({ error: "Failed to review detection logic" });
      return;
    }
  });

  fastify.post("/detection/work-items", async (request, reply) => {
    const input = parseRequest(DetectionWorkItemInputSchema, request.body, reply);
    if (!input) return;
    try {
      fastify.log.info({ route: "/detection/work-items", assignToJira: input.assignToJira }, "Creating detection work items");
      const result = await detectionAssistant.createDetectionWorkItems(input);
      fastify.log.info({ route: "/detection/work-items", count: result.length }, "Detection work items created");
      return { created: result };
    } catch (error) {
      fastify.log.error({ route: "/detection/work-items", error }, "Failed to create detection work items");
      reply.status(500).send({ error: "Failed to create detection work items" });
      return;
    }
  });

  fastify.get("/detection/coverage-gaps", async (request, reply) => {
    const input = parseRequest(CoverageGapInputSchema, request.query, reply);
    if (!input) return;
    try {
      fastify.log.info({ route: "/detection/coverage-gaps" }, "Summarizing coverage gaps");
      const result = await detectionAssistant.summarizeCoverageGaps(input);
      fastify.log.info({ route: "/detection/coverage-gaps", coveragePercentage: result.coveragePercentage }, "Coverage gaps summarized");
      return result;
    } catch (error) {
      fastify.log.error({ route: "/detection/coverage-gaps", error }, "Failed to summarize coverage gaps");
      reply.status(500).send({ error: "Failed to summarize coverage gaps" });
      return;
    }
  });
}
