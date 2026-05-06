export interface AgentRun {
  id: string;
  sessionId: string | null;
  userId: string;
  mode: string;
  model: string | null;
  status: "running" | "completed" | "failed";
  errorMessage: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  toolLoopCount: number;
  startedAt: string;
  lastActivityAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface AgentRunStep {
  id: string;
  runId: string;
  stepType:
    | "model_request"
    | "model_response"
    | "thinking"
    | "content"
    | "tool_call"
    | "tool_result"
    | "approval_requested"
    | "error"
    | "note";
  toolName: string | null;
  content: unknown | null;
  sanitizedParams: unknown | null;
  success: boolean | null;
  errorMessage: string | null;
  durationMs: number | null;
  stepOrder: number;
  createdAt: string;
}

export interface AgentRunWithSteps extends AgentRun {
  steps: AgentRunStep[];
}

export interface AgentRunStats {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  runningRuns: number;
  avgToolLoopCount: number;
  runsLast24h: number;
  totalStepsLast24h: number;
}

export interface AgentRunCreateParams {
  sessionId?: string | null;
  userId: string;
  mode: string;
}

export interface AgentRunCompleteParams {
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  toolLoopCount: number;
}

export interface AgentRunListResult {
  runs: AgentRun[];
  total: number;
}

export interface AgentRunStepCreate {
  runId: string;
  stepType: AgentRunStep["stepType"];
  toolName?: string | null;
  content?: unknown | null;
  sanitizedParams?: unknown | null;
  success?: boolean | null;
  errorMessage?: string | null;
  durationMs?: number | null;
  stepOrder: number;
}
