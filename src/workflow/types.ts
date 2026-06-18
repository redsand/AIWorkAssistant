export interface WorkflowActionParam {
  name: string;
  description: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  defaultValue?: unknown;
  allowedValues?: string[];
}

export interface WorkflowActionStep {
  tool: string;
  params: Record<string, unknown>;
  condition?: string;
  onError: "continue" | "stop" | "retry";
  maxRetries?: number;
  outputKey?: string;
}

export interface WorkflowAction {
  id: string;
  name: string;
  description: string;
  category:
    | "triage"
    | "investigation"
    | "response"
    | "reporting"
    | "maintenance"
    | "productivity";
  riskLevel: "low" | "medium" | "high";
  params: WorkflowActionParam[];
  steps: WorkflowActionStep[];
  tags: string[];
  version: string;
  approvalRequired: boolean;
}

export interface WorkflowExecution {
  id: string;
  actionId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  stepResults: Array<{
    stepIndex: number;
    tool: string;
    status: "completed" | "failed" | "skipped";
    result?: unknown;
    error?: string;
    duration?: number;
  }>;
  params: Record<string, unknown>;
  /** Authenticated identity that triggered the execution. */
  triggeredBy?: string;
  /** Authenticated identity that approved an approval-gated execution. */
  approvedBy?: string;
}

export interface WorkflowListOutput {
  actions: Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    riskLevel: string;
    approvalRequired: boolean;
    tags: string[];
  }>;
}
