import { FastifyInstance } from "fastify";
import {
  workflowEngine,
  ApprovalRequiredError,
  SelfApprovalError,
} from "../workflow/workflow-engine";
import { requireAuth } from "../middleware/auth";

// Registered under the /api/workflow prefix (see server.ts), matching the
// prefix-registration pattern used by the other route modules.
export async function workflowRoutes(fastify: FastifyInstance) {
  // GET /actions — list all built-in workflow actions.
  // Authenticated: action definitions expose internal tool names and step
  // sequences, so they must not be readable by unauthenticated callers.
  fastify.get("/actions", { preHandler: requireAuth }, async () => {
    return workflowEngine.listActions();
  });

  // GET /actions/:id — fetch a single action definition
  fastify.get(
    "/actions/:id",
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

  // POST /actions/:id/execute — start an approved action.
  // Authenticated: triggers workflow side effects (incl. security escalation).
  fastify.post(
    "/actions/:id/execute",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      // Reject non-object bodies (string/array/null) so the engine's parameter
      // validation always operates on a plain key/value map.
      const body = request.body;
      if (
        body !== undefined &&
        (typeof body !== "object" || Array.isArray(body))
      ) {
        return reply
          .status(400)
          .send({ error: "Invalid body", message: "Body must be a JSON object" });
      }
      const params = (body ?? {}) as Record<string, unknown>;

      // The triggering identity comes from the authenticated session/API key.
      // Approval for approval-gated actions must come from a *different*
      // identity supplied via the x-approver header — enforcing separation of
      // duties so a caller cannot approve their own escalation. The engine
      // rejects a missing or self-matching approver.
      const actor = request.userId ?? "unknown";
      const approver = (request.headers["x-approver"] as string | undefined)?.trim();

      if (!workflowEngine.getAction(id)) {
        return reply.status(404).send({ error: "Action not found" });
      }

      try {
        return await workflowEngine.execute(id, params, { actor, approver });
      } catch (err) {
        if (err instanceof SelfApprovalError) {
          return reply.status(403).send({
            error: "Self-approval not allowed",
            message: err.message,
          });
        }
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

  // GET /executions/:executionId — track a started execution.
  // Authenticated: execution records carry params that may include sensitive
  // case data (e.g. HAWK IR case IDs and escalation reasons).
  fastify.get(
    "/executions/:executionId",
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
