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
  /**
   * Sprint name (e.g. "Sprint 12") when the source provides one, fetched
   * by aicoder when it picks up the issue. Lets the runner UI show the
   * live issue's sprint without round-tripping to Jira. Null when unknown.
   */
  issueSprint: string | null;
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
  issueSprint?: string | null;
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

// ─── Runners (UI-configured persistent aicoder / reviewer loops) ────────────

export type RunnerKind = "aicoder" | "reviewer";
export type RunnerStatus =
  | "idle"
  | "running"
  | "paused"
  | "stopping"
  | "error";

export interface Runner {
  id: string;
  name: string;
  kind: RunnerKind;
  enabled: boolean;

  // Project / repo
  repoUrl: string | null;
  baseBranch: string | null;
  workspacePath: string | null;

  // Source / scope
  source: string;        // 'jira' | 'gitlab' | 'github' | 'work_items'
  owner: string | null;
  repo: string | null;
  label: string | null;
  sprint: string | null;
  targetIssue: string | null;

  // Agent config
  agent: string;         // 'claude' | 'codex' | 'opencode'
  model: string | null;
  apiProvider: string | null;
  /**
   * Optional saved provider-host (see {@link ProviderHost}). When set, the
   * runner-loop overrides the per-provider base URL / API key when spawning
   * the child process — that's how a runner can target a remote Ollama box
   * instead of localhost.
   */
  apiProviderHostId: string | null;

  // Loop control
  pollIntervalMs: number;
  maxCycles: number;     // 0 = unlimited

  // Lifecycle
  status: RunnerStatus;
  currentRunId: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastError: string | null;

  createdAt: string;
  updatedAt: string;
}

export interface RunnerCreateParams {
  name: string;
  kind: RunnerKind;
  enabled?: boolean;
  repoUrl?: string | null;
  baseBranch?: string | null;
  workspacePath?: string | null;
  source: string;
  owner?: string | null;
  repo?: string | null;
  label?: string | null;
  sprint?: string | null;
  targetIssue?: string | null;
  agent: string;
  model?: string | null;
  apiProvider?: string | null;
  apiProviderHostId?: string | null;
  pollIntervalMs?: number;
  maxCycles?: number;
}

export type RunnerUpdateParams = Partial<RunnerCreateParams>;

// ─── Provider hosts (saved remote endpoints, e.g. a LAN Ollama box) ─────────

/**
 * A user-saved remote endpoint for an API provider. Today only Ollama is
 * remoteable in practice (run a model on another box, point clients at it),
 * but the table is shaped per-provider so we can extend later without a
 * second migration.
 *
 * `baseUrl` overrides the provider's default `*_API_URL` env var when a
 * runner references this host. `apiKey` overrides `*_API_KEY`. `notes` is
 * a free-text reminder shown in the picker hint (e.g. "16GB Zotac 4060 Ti").
 */
export interface ProviderHost {
  id: string;
  name: string;
  provider: string;       // 'ollama' (for now; 'openai' etc later)
  baseUrl: string;
  apiKey: string | null;
  notes: string | null;
  /**
   * Per-host request timeout in seconds. Used for chat inference, model
   * listing, probe, and delete on this host. Null = fall back to the
   * provider default (300s for ollama). Useful when a slow local box (e.g.
   * a single-GPU rig serving a 13B+ model) needs more than 5 minutes for a
   * long reply, or when a fast box should fail faster than the default.
   */
  timeoutSeconds: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderHostCreateParams {
  name: string;
  provider: string;
  baseUrl: string;
  apiKey?: string | null;
  notes?: string | null;
  timeoutSeconds?: number | null;
}

export type ProviderHostUpdateParams = Partial<ProviderHostCreateParams>;
