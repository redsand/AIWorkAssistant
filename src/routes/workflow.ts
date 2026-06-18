import { FastifyInstance } from "fastify";
import {
  workflowEngine,
  ApprovalRequiredError,
  SelfApprovalError,
} from "../workflow/workflow-engine";
import { requireAuth, validateSessionToken } from "../middleware/auth";

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

      const action = workflowEngine.getAction(id);
      if (!action) {
        return reply.status(404).send({ error: "Action not found" });
      }

      // The triggering identity comes from the authenticated session/API key
      // resolved by requireAuth. When auth is configured, requireAuth always
      // populates request.userId before allowing the request through; an absent
      // actor therefore only occurs in fully unprotected dev mode.
      const actor = request.userId;

      // Approval must come from a *different* identity that proves ownership of
      // its own session — not a self-asserted name. The approver presents their
      // session token via x-approver-token; we validate it against the session
      // store and derive the verified approver identity. A raw header string is
      // unverifiable and trivially spoofable, so it is never trusted. The engine
      // then enforces that the approver differs from the actor.
      let approver: string | undefined;
      const approverToken = (
        request.headers["x-approver-token"] as string | undefined
      )?.trim();
      if (approverToken) {
        const approverSession = validateSessionToken(approverToken);
        if (!approverSession) {
          return reply.status(403).send({
            error: "Invalid approver credentials",
            message:
              "x-approver-token must be a valid, active session token for the approving identity.",
          });
        }
        approver = approverSession.userId;
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
  // case data (e.g. HAWK IR case IDs and escalation reasons), so access is
  // restricted to the identity that triggered or approved the execution.
  fastify.get(
    "/executions/:executionId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { executionId } = request.params as { executionId: string };
      const execution = workflowEngine.getExecution(executionId);
      if (!execution) {
        return reply.status(404).send({ error: "Execution not found" });
      }

      // Only the triggering actor or the approver may read the record. When auth
      // is disabled (no userId) the service is in unprotected dev mode and the
      // ownership check is skipped along with the rest of auth enforcement.
      const requester = request.userId;
      if (
        requester &&
        execution.triggeredBy !== requester &&
        execution.approvedBy !== requester
      ) {
        return reply.status(403).send({
          error: "Forbidden",
          message: "You may only read executions you triggered or approved.",
        });
      }
      return execution;
    },
  );
}
