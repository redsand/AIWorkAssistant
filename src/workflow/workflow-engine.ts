import type {
  WorkflowAction,
  WorkflowExecution,
  WorkflowListOutput,
} from "./types.js";
import { builtinActions } from "./builtin-actions.js";
import { v4 as uuidv4 } from "uuid";
import { auditLogger } from "../audit/logger.js";

/**
 * Thrown when an action with `approvalRequired: true` is executed without an
 * explicit approval. Callers (the HTTP route) map this to a 403 so the failure
 * is distinguishable from a 400 parameter-validation error.
 */
export class ApprovalRequiredError extends Error {
  constructor(actionId: string) {
    super(`Action requires approval before execution: ${actionId}`);
    this.name = "ApprovalRequiredError";
  }
}

// Cap retained executions so the in-memory store cannot grow unbounded.
const MAX_EXECUTIONS = 1000;

export interface ExecuteOptions {
  approved?: boolean;
  /** Authenticated identity invoking (and, when approved, approving) the action. */
  actor?: string;
}

export class WorkflowEngine {
  private actions: Map<string, WorkflowAction> = new Map();
  private executions: Map<string, WorkflowExecution> = new Map();

  constructor() {
    for (const action of builtinActions) {
      this.actions.set(action.id, action);
    }
  }

  listActions(): WorkflowListOutput {
    return {
      actions: Array.from(this.actions.values()).map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        category: a.category,
        riskLevel: a.riskLevel,
        approvalRequired: a.approvalRequired,
        tags: a.tags,
      })),
    };
  }

  getAction(id: string): WorkflowAction | undefined {
    return this.actions.get(id);
  }

  async execute(
    actionId: string,
    params: Record<string, unknown>,
    options: ExecuteOptions = {},
  ): Promise<WorkflowExecution> {
    const action = this.actions.get(actionId);
    if (!action) {
      throw new Error(`Workflow action not found: ${actionId}`);
    }

    // Work on a copy so applying defaults never mutates the caller's object
    // (the route passes request.body straight through) and the stored
    // execution record is not aliased to a reference the caller still holds.
    params = { ...params };

    const actor = options.actor ?? "unknown";

    // Enforce the approval guardrail before doing any work. Actions flagged
    // with `approvalRequired` (e.g. the medium-risk security escalation) must
    // not run unless the caller has supplied an explicit approval.
    if (action.approvalRequired && !options.approved) {
      void auditLogger.log({
        id: uuidv4(),
        timestamp: new Date(),
        action: "workflow.execute.denied",
        actor,
        details: { actionId, riskLevel: action.riskLevel, reason: "approval-required" },
        severity: "warn",
      });
      throw new ApprovalRequiredError(actionId);
    }

    for (const p of action.params) {
      // Apply a default when the parameter was not supplied.
      if (!(p.name in params)) {
        if (p.defaultValue !== undefined) {
          params[p.name] = p.defaultValue;
        } else if (p.required) {
          throw new Error(`Missing required parameter: ${p.name}`);
        }
      }
      // Validate the declared type when the parameter is present.
      if (p.name in params) {
        const value = params[p.name];
        if (value !== undefined && value !== null) {
          const actualType = typeof value;
          if (actualType !== p.type) {
            throw new Error(
              `Invalid type for ${p.name}: expected ${p.type}, got ${actualType}`,
            );
          }
        }
      }
      // Validate allowed values when the parameter is present.
      if (p.allowedValues && p.name in params) {
        const value = params[p.name];
        if (!p.allowedValues.includes(String(value))) {
          throw new Error(
            `Invalid value for ${p.name}: ${value}. Allowed: ${p.allowedValues.join(", ")}`,
          );
        }
      }
    }

    const execution: WorkflowExecution = {
      id: uuidv4(),
      actionId,
      status: "running",
      startedAt: new Date().toISOString(),
      stepResults: [],
      params,
      triggeredBy: actor,
      approvedBy: action.approvalRequired ? actor : undefined,
    };

    this.pruneExecutions();
    this.executions.set(execution.id, execution);

    void auditLogger.log({
      id: uuidv4(),
      timestamp: new Date(),
      action: "workflow.execute.started",
      actor,
      details: {
        executionId: execution.id,
        actionId,
        riskLevel: action.riskLevel,
        approvalRequired: action.approvalRequired,
      },
      severity: action.riskLevel === "low" ? "info" : "warn",
    });

    // Actual step execution is handled by the agent orchestration layer, which
    // drives the execution to a terminal state via completeExecution /
    // failExecution. The engine validates, plans, and tracks execution.

    return execution;
  }

  /**
   * Transition a running execution to "completed". Called by the orchestration
   * layer once all steps have finished.
   */
  completeExecution(
    executionId: string,
    stepResults: WorkflowExecution["stepResults"] = [],
  ): WorkflowExecution | undefined {
    const execution = this.executions.get(executionId);
    if (!execution) {
      return undefined;
    }
    execution.status = "completed";
    execution.completedAt = new Date().toISOString();
    if (stepResults.length > 0) {
      execution.stepResults = stepResults;
    }
    void auditLogger.log({
      id: uuidv4(),
      timestamp: new Date(),
      action: "workflow.execute.completed",
      actor: execution.triggeredBy ?? "unknown",
      details: { executionId, actionId: execution.actionId },
      severity: "info",
    });
    return execution;
  }

  /**
   * Transition a running execution to "failed". Called by the orchestration
   * layer when a step fails terminally.
   */
  failExecution(
    executionId: string,
    error: string,
  ): WorkflowExecution | undefined {
    const execution = this.executions.get(executionId);
    if (!execution) {
      return undefined;
    }
    execution.status = "failed";
    execution.completedAt = new Date().toISOString();
    execution.stepResults = [
      ...execution.stepResults,
      {
        stepIndex: execution.stepResults.length,
        tool: "engine",
        status: "failed",
        error,
      },
    ];
    void auditLogger.log({
      id: uuidv4(),
      timestamp: new Date(),
      action: "workflow.execute.failed",
      actor: execution.triggeredBy ?? "unknown",
      details: { executionId, actionId: execution.actionId, error },
      severity: "error",
    });
    return execution;
  }

  getExecution(executionId: string): WorkflowExecution | undefined {
    return this.executions.get(executionId);
  }

  // Evict the oldest executions once the store reaches its cap. Map preserves
  // insertion order, so the first keys are the oldest.
  private pruneExecutions(): void {
    while (this.executions.size >= MAX_EXECUTIONS) {
      const oldest = this.executions.keys().next().value;
      if (oldest === undefined) break;
      this.executions.delete(oldest);
    }
  }
}

export const workflowEngine = new WorkflowEngine();
