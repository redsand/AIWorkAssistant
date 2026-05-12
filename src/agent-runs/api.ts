import { FastifyInstance } from "fastify";
import { agentRunDatabase, AgentRunDatabase } from "./database";
import type { AgentRunStep } from "./types";

/** Fields safe to expose in stripped step responses (no prompts, responses, or params) */
type SafeStepFields = Pick<
  AgentRunStep,
  "id" | "runId" | "stepType" | "toolName" | "success" | "errorMessage" | "durationMs" | "stepOrder" | "createdAt"
>;

/** Strip sensitive step content (prompts, responses, params) for non-owner responses */
function stripStepContent(steps: AgentRunStep[]): SafeStepFields[] {
  return steps.map((step) => ({
    id: step.id,
    runId: step.runId,
    stepType: step.stepType,
    toolName: step.toolName,
    success: step.success,
    errorMessage: step.errorMessage,
    durationMs: step.durationMs,
    stepOrder: step.stepOrder,
    createdAt: step.createdAt,
  }));
}

function safeParseInt(value: string | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

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

    // IDOR prevention: always scope runs to the requesting user
    // - Authenticated users see their own runs only (plus aicoder system runs)
    // - Unauthenticated requests are denied — no access to any user's runs
    const requestUserId = request.userId;
    if (!requestUserId) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const filterUserId =
      query.userId === "aicoder" ? "aicoder" : requestUserId;

    const limit = safeParseInt(query.limit, 1, 100, 50);
    const offset = safeParseInt(query.offset, 0, Number.MAX_SAFE_INTEGER, 0);

    return db.listRuns({
      status: query.status,
      userId: filterUserId,
      limit,
      offset,
    });
  });

  fastify.get("/agent-runs/stats", async () => {
    return db.getStats();
  });

  fastify.get("/agent-runs/aicoder", async () => {
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

    // Return run metadata only — exclude step content for security
    const runWithSteps = db.getRunWithSteps(targetRun.id);
    return {
      runs: runs.runs,
      current: runWithSteps
        ? {
            ...runWithSteps,
            steps: stripStepContent(runWithSteps.steps),
          }
        : null,
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

      // Only allow viewing your own runs (aicoder runs are publicly viewable as metadata-only)
      if (result.userId !== userId && result.userId !== "aicoder") {
        return reply.code(403).send({ error: "Not authorized to view this run" });
      }

      // Strip sensitive step content for aicoder runs (which anyone can see)
      if (result.userId === "aicoder") {
        return { ...result, steps: stripStepContent(result.steps) };
      }

      // Owner sees full content including steps
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

      // Only allow viewing your own run steps (aicoder steps are metadata-only)
      if (run.userId !== userId && run.userId !== "aicoder") {
        return reply.code(403).send({ error: "Not authorized to view this run's steps" });
      }

      const steps = db.getRunSteps(request.params.id);

      // Strip sensitive content for aicoder runs
      if (run.userId === "aicoder") {
        return stripStepContent(steps);
      }

      return steps;
    },
  );
}