import type {
  WorkflowAction,
  WorkflowExecution,
  WorkflowListOutput,
} from "./types.js";
import { builtinActions } from "./builtin-actions.js";
import { v4 as uuidv4 } from "uuid";
import { auditLogger } from "../audit/logger.js";

/**
 * Thrown when an action with `approvalRequired: true` is executed without a
 * named approver. Callers (the HTTP route) map this to a 403 so the failure
 * is distinguishable from a 400 parameter-validation error.
 */
export class ApprovalRequiredError extends Error {
  constructor(actionId: string) {
    super(`Action requires approval before execution: ${actionId}`);
    this.name = "ApprovalRequiredError";
  }
}

/**
 * Thrown when the approver of an approval-required action is the same identity
 * that triggered it. Approval-gated actions enforce separation of duties: the
 * caller cannot approve their own request. Mapped to a 403 by the HTTP route.
 */
export class SelfApprovalError extends Error {
  constructor(actionId: string) {
    super(`Approval must come from a different identity than the requester: ${actionId}`);
    this.name = "SelfApprovalError";
  }
}

// Cap retained executions so the in-memory store cannot grow unbounded.
const MAX_EXECUTIONS = 1000;

export interface ExecuteOptions {
  /** Authenticated identity invoking the action. */
  actor?: string;
  /**
   * Identity that approves an approval-gated action. Must be present and
   * distinct from {@link ExecuteOptions.actor} for `approvalRequired` actions
   * (separation of duties); ignored for actions that do not require approval.
   */
  approver?: string;
}

// Deep clone so callers never receive a reference to the live stored execution
// and cannot mutate tracked engine state. structuredClone is available on the
// Node runtime this service targets.
function snapshot(execution: WorkflowExecution): WorkflowExecution {
  return structuredClone(execution);
}

// Map an action's risk level to an audit severity so high-risk actions are
// distinguishable from medium ones in the audit trail.
function riskSeverity(riskLevel: WorkflowAction["riskLevel"]): "info" | "warn" | "error" {
  switch (riskLevel) {
    case "high":
      return "error";
    case "medium":
      return "warn";
    default:
      return "info";
  }
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
    const approver = options.approver?.trim() || undefined;

    // Enforce the approval guardrail before doing any work. Actions flagged
    // with `approvalRequired` (e.g. the medium-risk security escalation) must
    // not run unless a distinct approver has signed off — separation of duties
    // means the triggering identity cannot approve its own request.
    if (action.approvalRequired) {
      if (!approver) {
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
      if (approver === actor) {
        void auditLogger.log({
          id: uuidv4(),
          timestamp: new Date(),
          action: "workflow.execute.denied",
          actor,
          details: { actionId, riskLevel: action.riskLevel, reason: "self-approval", approver },
          severity: "warn",
        });
        throw new SelfApprovalError(actionId);
      }
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
          // typeof NaN === "number"; reject non-finite numbers so a NaN value
          // cannot slip through the number type check.
          if (p.type === "number" && !Number.isFinite(value as number)) {
            throw new Error(
              `Invalid value for ${p.name}: expected a finite number`,
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
      approvedBy: action.approvalRequired ? approver : undefined,
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
        approvedBy: execution.approvedBy,
      },
      severity: riskSeverity(action.riskLevel),
    });

    // Actual step execution is handled by the agent orchestration layer, which
    // drives the execution to a terminal state via completeExecution /
    // failExecution. The engine validates, plans, and tracks execution. Return a
    // snapshot so the caller cannot mutate the tracked record.
    return snapshot(execution);
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
    return snapshot(execution);
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
    return snapshot(execution);
  }

  getExecution(executionId: string): WorkflowExecution | undefined {
    const execution = this.executions.get(executionId);
    return execution ? snapshot(execution) : undefined;
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
