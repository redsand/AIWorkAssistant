import { FastifyInstance } from "fastify";
import { z } from "zod";
import { productChiefOfStaff } from "../product/product-chief-of-staff";

const workflowBriefSchema = z.object({
  idea: z.string().min(1).max(5000),
  context: z.string().max(5000).optional(),
});

const roadmapProposalSchema = z.object({
  theme: z.string().min(1).max(1000),
  customerEvidence: z.string().max(5000).optional(),
  engineeringConstraints: z.string().max(5000).optional(),
  timeHorizon: z.string().max(100).optional(),
});

const roadmapDriftQuerySchema = z.object({
  roadmapId: z.string().uuid().optional(),
});

const customerSignalsQuerySchema = z.object({
  daysBack: z.coerce.number().int().min(1).max(90).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const createWorkItemsSchema = z.object({
  items: z.array(z.object({
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
    title: z.string().min(1).max(500),
    description: z.string().max(10000).optional(),
    priority: z.enum(["low", "medium", "high", "critical"]).optional(),
    tags: z.array(z.string().max(100)).max(20).optional(),
  })).max(25),
  source: z.enum(["chat", "jira", "github", "gitlab", "jitbit", "calendar", "manual", "roadmap"]).optional(),
});

const weeklyUpdateQuerySchema = z.object({
  weekStart: z.string().optional(),
  daysBack: z.coerce.number().int().min(1).max(30).optional(),
});

export async function productRoutes(fastify: FastifyInstance) {
  // POST /api/product/workflow-brief
  fastify.post("/workflow-brief", async (request, reply) => {
    const parsed = workflowBriefSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }

    const brief = await productChiefOfStaff.turnIdeaIntoWorkflowBrief(parsed.data);
    return { success: true, brief };
  });

  // POST /api/product/roadmap-proposal
  fastify.post("/roadmap-proposal", async (request, reply) => {
    const parsed = roadmapProposalSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }

    const proposal = await productChiefOfStaff.buildRoadmapProposal(parsed.data);
    return { success: true, proposal };
  });

  // GET /api/product/roadmap-drift
  fastify.get("/roadmap-drift", async (request, reply) => {
    const parsed = roadmapDriftQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }

    const drift = await productChiefOfStaff.analyzeRoadmapDrift(parsed.data);
    return { success: true, drift };
  });

  // GET /api/product/customer-signals
  fastify.get("/customer-signals", async (request, reply) => {
    const parsed = customerSignalsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }

    const signals = await productChiefOfStaff.extractCustomerSignalsFromJitbit(parsed.data);
    return { success: true, signals };
  });

  // POST /api/product/weekly-update
  fastify.post("/weekly-update", async (request, reply) => {
    const parsed = weeklyUpdateQuerySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }

    const update = await productChiefOfStaff.generateWeeklyProductUpdate(parsed.data);
    return { success: true, update };
  });

  // POST /api/product/work-items
  fastify.post("/work-items", async (request, reply) => {
    const parsed = createWorkItemsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }

    const created = productChiefOfStaff.createRoadmapWorkItems(parsed.data);
    return reply.status(201).send({ success: true, created });
  });
}