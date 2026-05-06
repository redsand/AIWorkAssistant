import { FastifyInstance } from "fastify";
import { z } from "zod";
import { personalOsBriefGenerator } from "../personal-os/brief-generator";

const booleanQuery = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean().optional());

const briefQuerySchema = z.object({
  userId: z.string().min(1).default("tim"),
  date: z.string().optional(),
  daysBack: z.coerce.number().int().min(1).max(30).optional(),
  includeCalendar: booleanQuery,
  includeJira: booleanQuery,
  includeGitLab: booleanQuery,
  includeGitHub: booleanQuery,
  includeWorkItems: booleanQuery,
  includeJitbit: booleanQuery,
  includeRoadmap: booleanQuery,
  includeMemory: booleanQuery,
});

const openLoopsQuerySchema = z.object({
  userId: z.string().min(1).default("tim"),
});

const patternsQuerySchema = z.object({
  userId: z.string().min(1).default("tim"),
  daysBack: z.coerce.number().int().min(7).max(90).optional(),
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
    status: z.enum(["proposed", "planned", "active", "blocked", "waiting", "done", "archived"]).optional(),
    priority: z.enum(["low", "medium", "high", "critical"]).optional(),
    owner: z.string().max(200).optional(),
    source: z.enum(["chat", "jira", "github", "gitlab", "jitbit", "calendar", "manual", "roadmap"]).optional(),
    sourceUrl: z.string().url().optional(),
    sourceExternalId: z.string().max(500).optional(),
    dueAt: z.string().optional(),
    tags: z.array(z.string().max(100)).max(20).optional(),
  })).max(25),
});

export async function personalOsRoutes(fastify: FastifyInstance) {
  // GET /api/personal-os/brief
  fastify.get("/brief", async (request, reply) => {
    const parsed = briefQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }
    return personalOsBriefGenerator.generatePersonalBrief(parsed.data);
  });

  // GET /api/personal-os/open-loops
  fastify.get("/open-loops", async (request, reply) => {
    const parsed = openLoopsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }
    // Open loops require a full brief data collection
    const brief = await personalOsBriefGenerator.generatePersonalBrief({
      userId: parsed.data.userId,
      includeMemory: false,
    });
    return {
      openLoops: brief.openLoops,
      decisionsWaiting: brief.decisionsWaiting,
      sources: brief.sources,
    };
  });

  // GET /api/personal-os/patterns
  fastify.get("/patterns", async (request, reply) => {
    const parsed = patternsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }
    // Patterns require a full brief data collection
    const brief = await personalOsBriefGenerator.generatePersonalBrief({
      userId: parsed.data.userId,
      daysBack: parsed.data.daysBack,
      includeMemory: false,
    });
    return {
      recurringPatterns: brief.recurringPatterns,
      sources: brief.sources,
    };
  });

  // POST /api/personal-os/work-items
  fastify.post("/work-items", async (request, reply) => {
    const parsed = createWorkItemsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }
    const created = personalOsBriefGenerator.createSuggestedWorkItems(parsed.data.items);
    return reply.status(201).send({ created });
  });
}