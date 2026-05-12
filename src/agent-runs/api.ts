import { FastifyInstance } from "fastify";
import { agentRunDatabase, AgentRunDatabase } from "./database";

/** Strip sensitive step content (prompts, responses, params) for public/monitoring endpoints */
function stripStepContent(steps: Array<{ id: string; runId: string; stepType: string; toolName: string | null; success: boolean | null; errorMessage: string | null; durationMs: number | null; stepOrder: number; createdAt: string }>) {
  return steps.map(({ id, runId, stepType, toolName, success, errorMessage, durationMs, stepOrder, createdAt }) => ({
    id,
    runId,
    stepType,
    toolName,
    success,
    errorMessage,
    durationMs,
    stepOrder,
    createdAt,
  }));
}

export interface AgentRunsRouteOptions {
  database?: AgentRunDatabase;
}

export async function agentRunsRoutes(fastify: FastifyInstance, options?: AgentRunsRouteOptions) {
  const db = options?.database || agentRunDatabase;

  fastify.get("/agent-runs", async (request) => {
    const query = request.query as {
      status?: string;
      userId?: string;
      limit?: string;
      offset?: string;
    };

    // IDOR prevention: restrict userId filtering
    // - Authenticated users can only see their own runs (or aicoder system runs)
    // - Unauthenticated requests see all runs (backwards compatibility for monitoring)
    const requestUserId = request.userId;
    const filterUserId = requestUserId
      ? (query.userId === "aicoder" ? "aicoder" : requestUserId)
      : (query.userId === "aicoder" ? "aicoder" : undefined);

    const limit = query.limit ? Math.min(Math.max(parseInt(query.limit, 10), 1), 100) : undefined;
    const offset = query.offset ? Math.max(parseInt(query.offset, 10), 0) : undefined;

    return db.listRuns({
      status: query.status,
      userId: filterUserId,
      limit: limit ?? undefined,
      offset: offset ?? undefined,
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

      // Only allow viewing your own runs (unless viewing aicoder system runs)
      const userId = request.userId;
      if (userId && result.userId !== userId && result.userId !== "aicoder") {
        return reply.code(403).send({ error: "Not authorized to view this run" });
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

      // Only allow viewing your own run steps (unless viewing aicoder system runs)
      const userId = request.userId;
      if (userId && run.userId !== userId && run.userId !== "aicoder") {
        return reply.code(403).send({ error: "Not authorized to view this run's steps" });
      }

      return db.getRunSteps(request.params.id);
    },
  );
}