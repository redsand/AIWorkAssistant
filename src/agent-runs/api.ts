import { FastifyInstance } from "fastify";
import { agentRunDatabase } from "./database";

export async function agentRunsRoutes(fastify: FastifyInstance) {
  fastify.get("/agent-runs", async (request) => {
    const query = request.query as {
      status?: string;
      userId?: string;
      limit?: string;
      offset?: string;
    };

    return agentRunDatabase.listRuns({
      status: query.status,
      userId: query.userId,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      offset: query.offset ? parseInt(query.offset, 10) : undefined,
    });
  });

  fastify.get("/agent-runs/stats", async () => {
    return agentRunDatabase.getStats();
  });

  fastify.get("/agent-runs/aicoder", async () => {
    const runs = agentRunDatabase.listRuns({ userId: "aicoder", limit: 5 });
    if (!runs.runs.length) {
      return { runs: [], current: null };
    }
    const current = runs.runs.find((r) => r.status === "running");
    const latest = runs.runs[0];
    const latestWithSteps = current
      ? agentRunDatabase.getRunWithSteps(current.id)
      : latest
        ? agentRunDatabase.getRunWithSteps(latest.id)
        : null;
    return {
      runs: runs.runs,
      current: latestWithSteps,
    };
  });

  fastify.get<{ Params: { id: string } }>(
    "/agent-runs/:id",
    async (request) => {
      const result = agentRunDatabase.getRunWithSteps(request.params.id);
      if (!result) {
        return { error: "Run not found" };
      }
      return result;
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/agent-runs/:id/steps",
    async (request) => {
      const run = agentRunDatabase.getRun(request.params.id);
      if (!run) {
        return { error: "Run not found" };
      }
      return agentRunDatabase.getRunSteps(request.params.id);
    },
  );
}