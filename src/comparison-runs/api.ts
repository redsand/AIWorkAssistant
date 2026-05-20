import { FastifyInstance } from "fastify";
import { comparisonRunDatabase, ComparisonRunDatabase } from "./database";
import type { SaveComparisonInput } from "./types";

function safeParseInt(
  value: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

export interface ComparisonRoutesOptions {
  database?: ComparisonRunDatabase;
}

export async function comparisonRoutes(
  fastify: FastifyInstance,
  options?: ComparisonRoutesOptions,
) {
  const db = options?.database ?? comparisonRunDatabase;

  // ── Dashboard stats ──────────────────────────────────────────────

  fastify.get("/stats", async (_request, _reply) => {
    return db.getDashboardStats();
  });

  // ── Confidence trend ──────────────────────────────────────────────

  fastify.get("/trends", async (request, _reply) => {
    const query = request.query as { days?: string };
    const days = safeParseInt(query.days, 1, 365, 30);
    return db.getConfidenceOverTime(days);
  });

  // ── Run listing ───────────────────────────────────────────────────

  fastify.get("/runs", async (request, _reply) => {
    const query = request.query as {
      source?: string;
      limit?: string;
      offset?: string;
    };
    const limit = safeParseInt(query.limit, 1, 100, 25);
    const offset = safeParseInt(query.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    return db.listRuns({
      source: query.source,
      limit,
      offset,
    });
  });

  // ── Single run ────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
    const result = db.getRun(request.params.id);
    if (!result) {
      return reply.code(404).send({ error: "Run not found" });
    }
    return result;
  });

  // ── Save run (internal — used by auto-capture) ────────────────────

  const API_KEY = process.env.AIWORKASSISTANT_API_KEY;

  fastify.post("/runs", async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth && API_KEY) {
      return reply.code(401).send({ error: "API key required" });
    }
    if (API_KEY) {
      const token = auth!.startsWith("Bearer ") ? auth!.slice(7) : auth!;
      if (token !== API_KEY) {
        return reply.code(401).send({ error: "Invalid API key" });
      }
    }

    const body = request.body as SaveComparisonInput;
    if (!body.source || !body.cases?.length) {
      return reply
        .code(400)
        .send({ error: "source and cases are required" });
    }

    const run = db.createRun(body);
    return reply.code(201).send(run);
  });
}
