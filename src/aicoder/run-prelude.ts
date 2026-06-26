/**
 * Initialize per-issue run state + the agent-runs DB/API record at the
 * top of processWorkItem. Extracted from src/aicoder.ts (2026-06-26).
 *
 * Returns both:
 *   - initialState:  the seed RunState (checkpoint = "issue_transitioned")
 *                    that the rest of processWorkItem mutates as each
 *                    pipeline stage saves a new checkpoint
 *   - run:           the AgentRunRecord that surfaces this run in the
 *                    /agent-runs API — prefer the API record when the
 *                    agent-runs HTTP client is available, fall back to a
 *                    direct DB insert otherwise
 *
 * Also calls `resetStepOrder()` and writes the opening "Starting work
 * on …" trackStep entry — both are baked in here so the caller doesn't
 * have to remember them.
 */
import type { AgentRun as AgentRunRecord } from "../agent-runs/types";
import type { RunState, ServerConfig, WorkItem } from "../autonomous-loop/types";

export interface RunPreludeAgentRunsClient {
  startRun: (
    params: AgentRunRunParams,
  ) => Promise<AgentRunRecord | null>;
}

export interface RunPreludeAgentRunDatabase {
  startRun: (params: AgentRunRunParams) => AgentRunRecord;
}

export type AgentRunRunParams = {
  userId: string;
  mode: string;
  model: string | null;
  provider: string;
  issuePlatform: "github" | "gitlab" | "jira" | "work_items";
  issueId: string;
  issueRepo: string;
  issueSprint: string | null;
  worktreePath: string;
  branch: string;
  agentType: string;
};

export interface RunPreludeLogger {
  startRun(issueNumber: number, title: string): void;
  logWork(message: string): void;
}

export interface RunPreludeDeps {
  logger: RunPreludeLogger;
  workspace: string;
  agent: string;
  model: string | null;
  apiProvider: string | null;

  agentRunsClient: RunPreludeAgentRunsClient | null;
  agentRunDatabase: RunPreludeAgentRunDatabase;
  resetStepOrder: () => void;
  trackStep: (
    runId: string,
    kind: "note",
    message: string,
  ) => void;
}

function platformFromSource(
  source: string | undefined,
): "github" | "gitlab" | "jira" | "work_items" {
  if (source === "gitlab") return "gitlab";
  if (source === "jira") return "jira";
  if (source === "work_items") return "work_items";
  return "github";
}

export async function startRunPrelude(
  deps: RunPreludeDeps,
  cfg: ServerConfig,
  item: WorkItem,
  issueKey: string,
): Promise<{ initialState: RunState; run: AgentRunRecord }> {
  deps.logger.startRun(item.number, item.title);
  deps.logger.logWork(`Starting issue ${issueKey}: ${item.title}`);

  const now = new Date().toISOString();
  const platform = platformFromSource(cfg.source);

  const initialState: RunState = {
    issueKey,
    issueNumber: item.number,
    title: item.title,
    url: item.url,
    owner: item.owner,
    repo: item.repo,
    suggestedBranch: item.suggestedBranch,
    labels: item.labels,
    source: platform as RunState["source"],
    checkpoint: "issue_transitioned",
    apiUrl: cfg.apiUrl,
    apiKey: cfg.apiKey,
    startedAt: now,
    updatedAt: now,
  };

  deps.resetStepOrder();
  const runParams: AgentRunRunParams = {
    userId: "aicoder",
    mode: `issue:${issueKey}`,
    model: deps.model,
    provider: deps.apiProvider || deps.agent,
    issuePlatform: platform,
    issueId: issueKey,
    issueRepo: cfg.repo || item.repo || process.env.AICODER_REPO || "",
    issueSprint: item.sprint ?? null,
    worktreePath: deps.workspace,
    branch: item.suggestedBranch,
    agentType: deps.agent,
  };

  let run: AgentRunRecord;
  if (deps.agentRunsClient) {
    const apiRun = await deps.agentRunsClient.startRun(runParams);
    run = apiRun ?? deps.agentRunDatabase.startRun(runParams);
  } else {
    run = deps.agentRunDatabase.startRun(runParams);
  }
  deps.trackStep(run.id, "note", `Starting work on ${issueKey}: ${item.title}`);

  return { initialState, run };
}
