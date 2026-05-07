import { FastifyInstance } from "fastify";
import { z } from "zod";
import { weeklyDigestGenerator } from "../digests/weekly-digest";

const booleanQuery = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean().optional());

const querySchema = z.object({
  weekStart: z.string().optional(),
  includeJira: booleanQuery,
  includeGitLab: booleanQuery,
  includeGitHub: booleanQuery,
  includeJitbit: booleanQuery,
  includeHawkIr: booleanQuery,
  includeRoadmap: booleanQuery,
  includeWorkItems: booleanQuery,
  includeCalendar: booleanQuery,
  includeMemory: booleanQuery,
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
    source: z.enum(["chat", "jira", "github", "gitlab", "jitbit", "calendar", "manual", "roadmap", "hawk-ir"]).optional(),
    sourceUrl: z.string().url().optional(),
    sourceExternalId: z.string().max(500).optional(),
    dueAt: z.string().optional(),
    tags: z.array(z.string().max(100)).max(20).optional(),
    linkedResources: z.array(z.object({
      type: z.enum(["jira", "github", "gitlab", "jitbit", "calendar", "roadmap", "url"]),
      url: z.string().url(),
      label: z.string().max(500),
    })).max(20).optional(),
    metadata: z.record(z.unknown()).optional(),
  })).max(25),
});

export async function digestRoutes(fastify: FastifyInstance) {
  fastify.get("/weekly", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }
    return weeklyDigestGenerator.generateWeeklyDigest(parsed.data);
  });

  fastify.post("/weekly/create-work-items", async (request, reply) => {
    const parsed = createWorkItemsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }
    const created = weeklyDigestGenerator.createSuggestedWorkItems(parsed.data.items);
    return reply.status(201).send({ created });
  });
}