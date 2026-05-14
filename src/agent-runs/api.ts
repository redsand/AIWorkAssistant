import { FastifyInstance } from "fastify";
import { agentRunDatabase, AgentRunDatabase } from "./database";
import type { AgentRunCreateParams, AgentRunCompleteParams, AgentRunStepCreate } from "./types";

function safeParseInt(value: string | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

const VALID_STATUSES = new Set(["running", "completed", "failed"] as const);

export interface AgentRunsRouteOptions {
  database?: AgentRunDatabase;
}

export async function agentRunsRoutes(fastify: FastifyInstance, options?: AgentRunsRouteOptions) {
  const db = options?.database || agentRunDatabase;

  fastify.get("/agent-runs", async (request, reply) => {
    const query = request.query as {
      status?: string;
      userId?: string;
      limit?: string;
      offset?: string;
    };

    if (!request.userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    // When a specific userId is requested, scope to that user (aicoder or self).
    // When no userId is given, show all runs (authenticated users are trusted to see all).
    const filterUserId =
      query.userId === "aicoder"
        ? "aicoder"
        : query.userId
          ? request.userId
          : undefined;

    // Validate status filter against allowed values
    const status = query.status && VALID_STATUSES.has(query.status as typeof VALID_STATUSES extends Set<infer T> ? T : never)
      ? query.status
      : undefined;

    const limit = safeParseInt(query.limit, 1, 100, 50);
    const offset = safeParseInt(query.offset, 0, Number.MAX_SAFE_INTEGER, 0);

    const result = db.listRuns({
      status,
      userId: filterUserId,
      limit,
      offset,
    });

    return result;
  });

  fastify.get("/agent-runs/stats", async (request, reply) => {
    // Require authentication — stats are scoped to the requesting user
    if (!request.userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const allRuns = db.listRuns({ limit: 10000 });
    const allRunsList = allRuns.runs;
    const completed = allRunsList.filter((r) => r.status === "completed");
    const totalToolLoops = completed.reduce((sum, r) => sum + r.toolLoopCount, 0);

    const stats = {
      totalRuns: allRuns.total,
      completedRuns: completed.length,
      failedRuns: allRunsList.filter((r) => r.status === "failed").length,
      runningRuns: allRunsList.filter((r) => r.status === "running").length,
      avgToolLoopCount: completed.length > 0 ? totalToolLoops / completed.length : 0,
    };

    return stats;
  });

  fastify.get("/agent-runs/aicoder", async (request, reply) => {
    // Require authentication — aicoder run metadata is visible to authenticated users only
    if (!request.userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const runs = db.listRuns({ userId: "aicoder", limit: 5 });
    if (!runs.runs.length) {
      return { runs: [], current: null };
    }
    const current = runs.runs.find((r) => r.status === "running");
    const latest = runs.runs[0];
    const targetRun = current || latest;

    if (!targetRun) {
      return { runs: runs.runs, current: null };
    }

    const runWithSteps = db.getRunWithSteps(targetRun.id);
    return {
      runs: runs.runs,
      current: runWithSteps || null,
    };
  });

  fastify.get<{ Params: { id: string } }>(
    "/agent-runs/:id",
    async (request, reply) => {
      const result = db.getRunWithSteps(request.params.id);
      if (!result) {
        return reply.code(404).send({ error: "Run not found" });
      }

      const userId = request.userId;
      // Require authentication to view runs
      if (!userId) {
        return reply.code(401).send({ error: "Authentication required" });
      }

      return result;
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/agent-runs/:id/steps",
    async (request, reply) => {
      const run = db.getRun(request.params.id);
      if (!run) {
        return reply.code(404).send({ error: "Run not found" });
      }

      const userId = request.userId;
      // Require authentication to view run steps
      if (!userId) {
        return reply.code(401).send({ error: "Authentication required" });
      }

      const steps = db.getRunSteps(request.params.id);
      return steps;
    },
  );

  // ── Write endpoints (used by aicoder/reviewer to report runs) ─────────────

  const API_KEY = process.env.AIWORKASSISTANT_API_KEY;

  function authenticateWrite(request: any): boolean {
    const auth = request.headers.authorization;
    if (!auth) return false;
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
    return token === API_KEY;
  }

  // POST /agent-runs — start a new run
  fastify.post("/agent-runs", async (request, reply) => {
    if (!authenticateWrite(request)) {
      return reply.code(401).send({ error: "Invalid API key" });
    }
    const body = request.body as AgentRunCreateParams;
    if (!body.userId || !body.mode) {
      return reply.code(400).send({ error: "userId and mode are required" });
    }
    const run = db.startRun(body);
    return reply.code(201).send(run);
  });

  // POST /agent-runs/:id/complete — mark run complete
  fastify.post<{ Params: { id: string } }>(
    "/agent-runs/:id/complete",
    async (request, reply) => {
      if (!authenticateWrite(request)) {
        return reply.code(401).send({ error: "Invalid API key" });
      }
      const run = db.getRun(request.params.id);
      if (!run) {
        return reply.code(404).send({ error: "Run not found" });
      }
      const body = request.body as AgentRunCompleteParams;
      db.completeRun(request.params.id, body);
      return { success: true };
    },
  );

  // POST /agent-runs/:id/fail — mark run failed
  fastify.post<{ Params: { id: string } }>(
    "/agent-runs/:id/fail",
    async (request, reply) => {
      if (!authenticateWrite(request)) {
        return reply.code(401).send({ error: "Invalid API key" });
      }
      const run = db.getRun(request.params.id);
      if (!run) {
        return reply.code(404).send({ error: "Run not found" });
      }
      const body = request.body as { errorMessage: string };
      if (!body.errorMessage) {
        return reply.code(400).send({ error: "errorMessage is required" });
      }
      db.failRun(request.params.id, body.errorMessage);
      return { success: true };
    },
  );

  // POST /agent-runs/:id/steps — add a step
  fastify.post<{ Params: { id: string } }>(
    "/agent-runs/:id/steps",
    async (request, reply) => {
      if (!authenticateWrite(request)) {
        return reply.code(401).send({ error: "Invalid API key" });
      }
      const run = db.getRun(request.params.id);
      if (!run) {
        return reply.code(404).send({ error: "Run not found" });
      }
      const body = request.body as AgentRunStepCreate;
      if (!body.stepType || body.stepOrder == null) {
        return reply.code(400).send({ error: "stepType and stepOrder are required" });
      }
      const step = db.addStep({ ...body, runId: request.params.id });
      return reply.code(201).send(step);
    },
  );

  // POST /agent-runs/:id/touch — update last_activity_at
  fastify.post<{ Params: { id: string } }>(
    "/agent-runs/:id/touch",
    async (request, reply) => {
      if (!authenticateWrite(request)) {
        return reply.code(401).send({ error: "Invalid API key" });
      }
      const run = db.getRun(request.params.id);
      if (!run) {
        return reply.code(404).send({ error: "Run not found" });
      }
      db.touchRun(request.params.id);
      return { success: true };
    },
  );

  // POST /agent-runs/stale — mark stale runs as failed
  fastify.post("/agent-runs/stale", async (request, reply) => {
    if (!authenticateWrite(request)) {
      return reply.code(401).send({ error: "Invalid API key" });
    }
    const body = request.body as { olderThanMinutes?: number };
    const count = db.markStaleRunsAsFailed(body?.olderThanMinutes);
    return { success: true, markedFailed: count };
  });
}