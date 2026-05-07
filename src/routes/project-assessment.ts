import { FastifyInstance } from "fastify";
import { z } from "zod";
import { projectAssessor } from "../project-assessment/project-assessment";

const booleanQuery = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean().optional());

const querySchema = z.object({
  includeGitHub: booleanQuery,
  includeGitLab: booleanQuery,
  includeJira: booleanQuery,
  includeJitbit: booleanQuery,
  includeRoadmap: booleanQuery,
  includeWorkItems: booleanQuery,
  includeAgentRuns: booleanQuery,
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
    linkedResources: z.array(z.object({
      type: z.enum(["jira", "github", "gitlab", "jitbit", "calendar", "roadmap", "url"]),
      url: z.string().url(),
      label: z.string().max(500),
    })).max(20).optional(),
    metadata: z.record(z.unknown()).optional(),
  })).max(25),
});

export async function projectAssessmentRoutes(fastify: FastifyInstance) {
  fastify.get("/", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }
    return projectAssessor.assessProgress(parsed.data);
  });

  fastify.post("/create-work-items", async (request, reply) => {
    const parsed = createWorkItemsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }
    const created = projectAssessor.createSuggestedWorkItems(parsed.data.items);
    return reply.status(201).send({ created });
  });
}