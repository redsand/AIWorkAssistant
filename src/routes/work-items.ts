import { FastifyInstance } from "fastify";
import { workItemDatabase } from "../work-items/database";
import type { WorkItemCreateParams, WorkItemUpdateParams, WorkItemListFilters } from "../work-items/types";
import { z } from "zod";

const createSchema = z.object({
  type: z.enum([
    "task", "decision", "code_review", "roadmap", "customer_followup",
    "detection", "research", "personal", "support", "release",
  ]),
  title: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  status: z.enum([
    "proposed", "planned", "active", "blocked", "waiting", "done", "archived",
  ]).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  owner: z.string().max(200).optional(),
  source: z.enum([
    "chat", "jira", "github", "gitlab", "jitbit", "calendar", "manual", "roadmap",
  ]).optional(),
  sourceUrl: z.string().url().optional().nullable(),
  sourceExternalId: z.string().max(500).optional().nullable(),
  dueAt: z.string().optional().nullable(),
  tags: z.array(z.string().max(100)).max(20).optional(),
  linkedResources: z.array(z.object({
    type: z.string(),
    url: z.string().url(),
    label: z.string().max(500),
  })).max(20).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateSchema = z.object({
  type: z.enum([
    "task", "decision", "code_review", "roadmap", "customer_followup",
    "detection", "research", "personal", "support", "release",
  ]).optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  status: z.enum([
    "proposed", "planned", "active", "blocked", "waiting", "done", "archived",
  ]).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  owner: z.string().max(200).optional(),
  source: z.enum([
    "chat", "jira", "github", "gitlab", "jitbit", "calendar", "manual", "roadmap",
  ]).optional(),
  sourceUrl: z.string().url().optional().nullable(),
  sourceExternalId: z.string().max(500).optional().nullable(),
  dueAt: z.string().optional().nullable(),
  tags: z.array(z.string().max(100)).max(20).optional(),
  linkedResources: z.array(z.object({
    type: z.string(),
    url: z.string().url(),
    label: z.string().max(500),
  })).max(20).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const noteSchema = z.object({
  author: z.string().min(1).max(200),
  content: z.string().min(1).max(10000),
});

const linkSchema = z.object({
  type: z.string().max(50),
  url: z.string().url(),
  label: z.string().max(500),
});

export async function workItemRoutes(fastify: FastifyInstance) {
  fastify.get("/", async (request) => {
    const query = request.query as Record<string, string>;
    return workItemDatabase.listWorkItems({
      status: query.status as WorkItemListFilters["status"],
      type: query.type as WorkItemListFilters["type"],
      priority: query.priority as WorkItemListFilters["priority"],
      source: query.source as WorkItemListFilters["source"],
      owner: query.owner,
      search: query.search,
      includeArchived: query.includeArchived === "true",
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      offset: query.offset ? parseInt(query.offset, 10) : undefined,
    });
  });

  fastify.post("/", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }
    const item = workItemDatabase.createWorkItem(
      parsed.data as WorkItemCreateParams,
    );
    return reply.status(201).send(item);
  });

  fastify.get("/stats", async () => {
    return workItemDatabase.getStats();
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const item = workItemDatabase.getWorkItem(request.params.id);
    if (!item) return reply.status(404).send({ error: "Work item not found" });
    return item;
  });

  fastify.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }
    const item = workItemDatabase.updateWorkItem(
      request.params.id,
      parsed.data as WorkItemUpdateParams,
    );
    if (!item) return reply.status(404).send({ error: "Work item not found" });
    return item;
  });

  fastify.post<{ Params: { id: string } }>(
    "/:id/notes",
    async (request, reply) => {
      const parsed = noteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.issues,
        });
      }
      const item = workItemDatabase.addNote(
        request.params.id,
        parsed.data.author,
        parsed.data.content,
      );
      if (!item)
        return reply.status(404).send({ error: "Work item not found" });
      return item;
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/links",
    async (request, reply) => {
      const parsed = linkSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.issues,
        });
      }
      const item = workItemDatabase.addLinkedResource(
        request.params.id,
        parsed.data,
      );
      if (!item)
        return reply.status(404).send({ error: "Work item not found" });
      return item;
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/complete",
    async (request, reply) => {
      const item = workItemDatabase.completeWorkItem(request.params.id);
      if (!item)
        return reply.status(404).send({ error: "Work item not found" });
      return item;
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/archive",
    async (request, reply) => {
      const item = workItemDatabase.archiveWorkItem(request.params.id);
      if (!item)
        return reply.status(404).send({ error: "Work item not found" });
      return item;
    },
  );
}