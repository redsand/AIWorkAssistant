export interface AgentRun {
  id: string;
  sessionId: string | null;
  userId: string;
  mode: string;
  provider: string | null;
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
  issueId: string | null;
  issuePlatform: string | null;
  issueRepo: string | null;
  worktreePath: string | null;
  branch: string | null;
  agentType: string | null;
  /**
   * OS process id that created this run. Used to detect zombies on startup:
   * any 'running' row whose pid != current process.pid is, by definition, dead
   * — the prior process is gone and so is its in-memory ProcessingJob and
   * aiRequestLimiter slot. Older rows (pre-pid migration) are pid=null and
   * also treated as zombies on the next startup.
   */
  pid: number | null;
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
  provider?: string | null;
  model?: string | null;
  issueId?: string | null;
  issuePlatform?: string | null;
  issueRepo?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  agentType?: string | null;
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
