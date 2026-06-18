import { FastifyInstance } from "fastify";
import { workflowEngine } from "../workflow/workflow-engine";

export async function workflowRoutes(fastify: FastifyInstance) {
  // GET /api/workflow/actions — list all built-in workflow actions
  fastify.get("/api/workflow/actions", async () => {
    return workflowEngine.listActions();
  });

  // GET /api/workflow/actions/:id — fetch a single action definition
  fastify.get("/api/workflow/actions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const action = workflowEngine.getAction(id);
    if (!action) {
      return reply.status(404).send({ error: "Action not found" });
    }
    return action;
  });

  // POST /api/workflow/actions/:id/execute — start an approved action
  fastify.post("/api/workflow/actions/:id/execute", async (request, reply) => {
    const { id } = request.params as { id: string };
    const params = (request.body ?? {}) as Record<string, unknown>;

    if (!workflowEngine.getAction(id)) {
      return reply.status(404).send({ error: "Action not found" });
    }

    try {
      return await workflowEngine.execute(id, params);
    } catch (err) {
      return reply.status(400).send({
        error: "Execution failed",
        message: err instanceof Error ? err.message : "Invalid parameters",
      });
    }
  });

  // GET /api/workflow/executions/:executionId — track a started execution
  fastify.get(
    "/api/workflow/executions/:executionId",
    async (request, reply) => {
      const { executionId } = request.params as { executionId: string };
      const execution = workflowEngine.getExecution(executionId);
      if (!execution) {
        return reply.status(404).send({ error: "Execution not found" });
      }
      return execution;
    },
  );
}
