import type {
  WorkflowAction,
  WorkflowExecution,
  WorkflowListOutput,
} from "./types.js";
import { builtinActions } from "./builtin-actions.js";
import { v4 as uuidv4 } from "uuid";

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
  ): Promise<WorkflowExecution> {
    const action = this.actions.get(actionId);
    if (!action) {
      throw new Error(`Workflow action not found: ${actionId}`);
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
    };

    this.executions.set(execution.id, execution);

    // Actual step execution is handled by the agent orchestration layer.
    // The engine validates, plans, and tracks execution.

    return execution;
  }

  getExecution(executionId: string): WorkflowExecution | undefined {
    return this.executions.get(executionId);
  }
}

export const workflowEngine = new WorkflowEngine();
