import { FastifyInstance } from "fastify";
import {
  workflowEngine,
  ApprovalRequiredError,
} from "../workflow/workflow-engine";
import { requireAuth } from "../middleware/auth";

export async function workflowRoutes(fastify: FastifyInstance) {
  // GET /api/workflow/actions — list all built-in workflow actions.
  // Authenticated: action definitions expose internal tool names and step
  // sequences, so they must not be readable by unauthenticated callers.
  fastify.get(
    "/api/workflow/actions",
    { preHandler: requireAuth },
    async () => {
      return workflowEngine.listActions();
    },
  );

  // GET /api/workflow/actions/:id — fetch a single action definition
  fastify.get(
    "/api/workflow/actions/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const action = workflowEngine.getAction(id);
      if (!action) {
        return reply.status(404).send({ error: "Action not found" });
      }
      return action;
    },
  );

  // POST /api/workflow/actions/:id/execute — start an approved action.
  // Authenticated: triggers workflow side effects (incl. security escalation).
  fastify.post(
    "/api/workflow/actions/:id/execute",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const params = (request.body ?? {}) as Record<string, unknown>;
      const approved =
        (request.query as Record<string, string>)?.approve === "true";
      // Bind approval/trigger to the authenticated identity so the audit trail
      // records who ran (and self-approved) the action rather than an anonymous
      // query-string flag. requireAuth populates request.userId.
      const actor = request.userId ?? "unknown";

      if (!workflowEngine.getAction(id)) {
        return reply.status(404).send({ error: "Action not found" });
      }

      try {
        return await workflowEngine.execute(id, params, { approved, actor });
      } catch (err) {
        if (err instanceof ApprovalRequiredError) {
          return reply.status(403).send({
            error: "Approval required",
            message: err.message,
          });
        }
        return reply.status(400).send({
          error: "Execution failed",
          message: err instanceof Error ? err.message : "Invalid parameters",
        });
      }
    },
  );

  // GET /api/workflow/executions/:executionId — track a started execution.
  // Authenticated: execution records carry params that may include sensitive
  // case data (e.g. HAWK IR case IDs and escalation reasons).
  fastify.get(
    "/api/workflow/executions/:executionId",
    { preHandler: requireAuth },
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
