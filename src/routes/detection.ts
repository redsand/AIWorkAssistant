import { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { detectionAssistant } from "../detection/detection-assistant.js";
import type { DetectionWorkItemInput, DetectionIdeaOutput } from "../detection/types.js";

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
    const result = await detectionAssistant.generateDetectionIdea(input);
    return result;
  });

  fastify.post("/detection/mitre", async (request, reply) => {
    const input = parseRequest(MitreMappingInputSchema, request.body, reply);
    if (!input) return;
    const result = await detectionAssistant.mapToMitre(input);
    return result;
  });

  fastify.post("/detection/tests", async (request, reply) => {
    const input = parseRequest(DetectionIdeaInputSchema, request.body, reply);
    if (!input) return;
    const result = await detectionAssistant.generateTestCases(input);
    return result;
  });

  fastify.post("/detection/review", async (request, reply) => {
    const input = parseRequest(DetectionReviewInputSchema, request.body, reply);
    if (!input) return;
    const result = await detectionAssistant.reviewDetectionLogic(input);
    return result;
  });

  fastify.post("/detection/work-items", async (request, reply) => {
    const parsed = DetectionWorkItemInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }
    const input = parsed.data as DetectionWorkItemInput;
    const result = await detectionAssistant.createDetectionWorkItems(input);
    return { created: result };
  });

  fastify.get("/detection/coverage-gaps", async (request, reply) => {
    const input = parseRequest(CoverageGapInputSchema, request.query, reply);
    if (!input) return;
    const result = await detectionAssistant.summarizeCoverageGaps(input);
    return result;
  });
}
