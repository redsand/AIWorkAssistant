import { FastifyInstance } from "fastify";
import { entityMemory } from "../memory/entity-memory";
import { ENTITY_TYPES } from "../memory/entity-types";
import type { EntityType, FindEntitiesQuery } from "../memory/entity-types";
import { z } from "zod";

const entityTypeEnum = z.enum([...ENTITY_TYPES] as [EntityType, ...EntityType[]]);

const findSchema = z.object({
  query: z.string().max(500).optional(),
  type: entityTypeEnum.optional(),
  source: z.string().max(100).optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const addFactSchema = z.object({
  fact: z.string().min(1).max(2000),
  source: z.string().max(100).optional(),
  sourceId: z.string().max(500).optional(),
  confidence: z.number().min(0).max(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const linkSchema = z.object({
  fromEntityId: z.string().uuid(),
  toEntityId: z.string().uuid(),
  relation: z.string().min(1).max(100),
  source: z.string().max(100).optional(),
  confidence: z.number().min(0).max(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export async function memoryRoutes(fastify: FastifyInstance) {
  // GET /api/memory/entities — search or list entities
  fastify.get("/entities", async (req, reply) => {
    const parsed = findSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
    }
    const q = parsed.data as FindEntitiesQuery;
    const entities = q.query || q.type || q.source || q.minConfidence !== undefined
      ? entityMemory.findEntities(q)
      : entityMemory.listRecentEntities(q.limit ?? 20);
    return reply.send({ entities });
  });

  // GET /api/memory/entities/context — get entity context by type + name
  fastify.get("/entities/context", async (req, reply) => {
    const { type, name } = req.query as { type?: string; name?: string };
    if (!type || !name) {
      return reply.status(400).send({ error: "type and name query params are required" });
    }
    const typeCheck = entityTypeEnum.safeParse(type);
    if (!typeCheck.success) {
      return reply.status(400).send({ error: `Unknown entity type: ${type}` });
    }
    const context = entityMemory.getEntityContext(typeCheck.data, name);
    if (!context) return reply.status(404).send({ error: "Entity not found" });
    return reply.send(context);
  });

  // GET /api/memory/entities/:id — get entity by ID
  fastify.get("/entities/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const entity = entityMemory.getEntity(id);
    if (!entity) return reply.status(404).send({ error: "Entity not found" });
    const facts = entityMemory.getEntityFacts(id);
    return reply.send({ entity, facts });
  });

  // POST /api/memory/entities/:id/facts — add a fact to an entity
  fastify.post("/entities/:id/facts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const entity = entityMemory.getEntity(id);
    if (!entity) return reply.status(404).send({ error: "Entity not found" });

    const parsed = addFactSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
    }
    const fact = entityMemory.addFact(id, parsed.data.fact, {
      source: parsed.data.source,
      sourceId: parsed.data.sourceId,
      confidence: parsed.data.confidence,
      metadata: parsed.data.metadata,
    });
    return reply.status(201).send(fact);
  });

  // POST /api/memory/entities/link — link two entities
  fastify.post("/entities/link", async (req, reply) => {
    const parsed = linkSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
    }
    const { fromEntityId, toEntityId, relation, source, confidence, metadata } = parsed.data;

    if (!entityMemory.getEntity(fromEntityId)) {
      return reply.status(404).send({ error: `fromEntityId ${fromEntityId} not found` });
    }
    if (!entityMemory.getEntity(toEntityId)) {
      return reply.status(404).send({ error: `toEntityId ${toEntityId} not found` });
    }

    const link = entityMemory.linkEntities(fromEntityId, toEntityId, relation, { source, confidence, metadata });
    return reply.status(201).send(link);
  });
}
