/**
 * Checkpoint resumers. Extracted from src/aicoder.ts (2026-06-26).
 *
 * `resumeFromCheckpoint` is the single entrypoint: given a persisted
 * RunState, it dispatches to whichever `continueFromXxx` step matches the
 * `checkpoint` field, and each step chains forward by saving a new
 * checkpoint and calling the next step. The chain mirrors the happy-path
 * pipeline that `processWorkItem` would run end-to-end:
 *
 *   branch_checked_out
 *     -> baseline_tests_pass
 *     -> agent_complete
 *     -> changes_committed
 *     -> tests_passed
 *     -> branch_pushed
 *     -> pr_created / review_polling / rework_pushed
 *     -> rework_agent_complete
 *     -> rework_committed
 *     -> rework_tests_passed
 *
 * Everything the resumers touch (workspace I/O, agent runtime,
 * persistence, platform clients) is injected via CheckpointResumerDeps so
 * this module never reaches back into aicoder.ts. The internal
 * continueFromXxx helpers stay private — only `resumeFromCheckpoint` is
 * exported.
 */
import type { RunState, ServerConfig, WorkItem } from "../autonomous-loop/types";

export interface CheckpointResumerLogger {
  logConfig(message: string): void;
  logError(message: string): void;
  logGit(action: string, detail?: string): void;
  logPR(message: string): void;
  logWork(message: string): void;
}

export interface CheckpointResumerAgentResult {
  finDetected: boolean;
  exitCode: number | null;
  sessionId?: string;
  ranTests?: boolean;
  stderr?: string;
}

export interface CheckpointResumerTestResult {
  passed: boolean;
  kind: string;
  output?: string;
}

export interface CheckpointResumerDeps {
  logger: CheckpointResumerLogger;
  workspace: string;
  agent: string;
  skipTests: boolean;
  enableBaseline: boolean;

  // Workspace ops
  ensureCleanWorkspace: () => boolean;
  forceCheckout: (branch: string, cwd: string) => boolean;
  stageAndCommit: (message: string) => boolean;
  pushBranch: (
    branch: string,
    options?: { forceWithLease?: boolean },
  ) => boolean;
  gitRun: (args: string[], cwd: string) => boolean;

  // Test gate
  fixBaselineTests: (cfg: ServerConfig, item: WorkItem) => Promise<boolean>;
  fixCoverageGap: (item: WorkItem, output: string) => Promise<unknown>;
  runTestSuite: (kind: "unit" | "integration") => CheckpointResumerTestResult;
  checkCoverage: () => CheckpointResumerTestResult;

  // Agent
  runAgent: (
    prompt: string,
    resumeSessionId?: string,
  ) => Promise<CheckpointResumerAgentResult>;
  generatePrompt: (
    cfg: ServerConfig,
    item: WorkItem,
  ) => Promise<{ skipped: boolean; skipReason?: string | null; prompt?: string }>;
  buildAgentPrompt: (prompt: string, item: WorkItem) => Promise<string>;

  // Platform
  createPR: (
    cfg: ServerConfig,
    item: WorkItem,
    branch: string,
  ) => Promise<{ prNumber: number; url: string } | null>;
  detectRemotePlatform: (workspace: string) => string;

  // Forward into review loop (already extracted in review-loop.ts)
  runReviewLoop: (
    cfg: ServerConfig,
    item: WorkItem,
    ghToken: string | undefined,
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<void>;

  // Persistence
  saveRunState: (state: RunState, issueKey?: string) => void;
  loadRunState: (issueKey?: string) => RunState | null;
  clearRunState: (issueKey?: string) => void;

  // Processed-issue ledger
  processedIssuesDelete: (issueKey: string) => void;
  unmarkIssueProcessedInDb: (issueKey: string) => void;

  // Failure handling
  isAgentInfrastructureFailure: (stderr: string | undefined) => boolean;
  escalateAgentInfrastructureFailure: (
    issueKey: string,
    stderr: string | undefined,
  ) => Promise<void>;
  recordProcessFailure: (issueKey: string) => void;
}

export async function resumeFromCheckpoint(
  deps: CheckpointResumerDeps,
  state: RunState,
): Promise<void> {
  const item: WorkItem = {
    id: state.issueKey,
    number: state.issueNumber,
    title: state.title,
    url: state.url,
    owner: state.owner,
    repo: state.repo,
    suggestedBranch: state.suggestedBranch,
    labels: state.labels,
  };

  const cfg: ServerConfig = {
    owner: state.owner,
    repo: state.repo,
    source: state.source,
    apiUrl: state.apiUrl,
    apiKey: state.apiKey,
  };

  deps.logger.logWork(
    `Resuming from checkpoint '${state.checkpoint}' for issue ${state.issueKey}`,
  );

  // Remove from processed issues so processWorkItem won't skip it
  deps.processedIssuesDelete(state.issueKey);
  deps.unmarkIssueProcessedInDb(state.issueKey);

  // Ensure workspace is clean and on the correct branch
  deps.ensureCleanWorkspace();

  switch (state.checkpoint) {
    case "issue_transitioned":
    case "branch_checked_out":
      await continueFromBranchCheckout(deps, cfg, item, state);
      break;
    case "baseline_tests_pass":
      await continueFromBaselineTestsPass(deps, cfg, item, state);
      break;
    case "agent_complete":
      await continueFromAgentComplete(deps, cfg, item, state);
      break;
    case "changes_committed":
      await continueFromChangesCommitted(deps, cfg, item, state);
      break;
    case "tests_passed":
      await continueFromTestsPassed(deps, cfg, item, state);
      break;
    case "branch_pushed":
      await continueFromBranchPushed(deps, cfg, item, state);
      break;
    case "pr_created":
    case "review_polling":
    case "rework_pushed":
      await continueFromReviewLoop(deps, cfg, item, state);
      break;
    case "rework_agent_complete":
      await continueFromReworkAgentComplete(deps, cfg, item, state);
      break;
    case "rework_committed":
      await continueFromReworkCommitted(deps, cfg, item, state);
      break;
    case "rework_tests_passed":
      await continueFromReworkTestsPassed(deps, cfg, item, state);
      break;
    default:
      deps.logger.logError(
        `Unknown checkpoint: ${state.checkpoint} — starting fresh`,
      );
      deps.clearRunState(state.issueKey);
  }
}

// Re-run from branch checkout: run baseline tests, agent, test gate, push, PR
async function continueFromBranchCheckout(
  deps: CheckpointResumerDeps,
  cfg: ServerConfig,
  item: WorkItem,
  state: RunState,
): Promise<void> {
  if (!deps.forceCheckout(item.suggestedBranch, deps.workspace)) {
    deps.logger.logError(
      `Cannot checkout branch ${item.suggestedBranch} for resume`,
    );
    deps.clearRunState(state.issueKey);
    return;
  }

  if (deps.enableBaseline && !(await deps.fixBaselineTests(cfg, item))) {
    deps.logger.logError(
      "Baseline tests could not be fixed on resume — aborting",
    );
    deps.clearRunState(state.issueKey);
    return;
  }
  deps.saveRunState({ ...state, checkpoint: "baseline_tests_pass" });
  await continueFromBaselineTestsPass(deps, cfg, item, state);
}

async function continueFromBaselineTestsPass(
  deps: CheckpointResumerDeps,
  cfg: ServerConfig,
  item: WorkItem,
  state: RunState,
): Promise<void> {
  const generated = await deps.generatePrompt(cfg, item);
  if (generated.skipped || !generated.prompt) {
    deps.logger.logError(
      `Cannot generate prompt on resume: ${generated.skipReason ?? "no prompt"}`,
    );
    deps.clearRunState(state.issueKey);
    return;
  }

  const resumeId =
    state.sessionId && deps.agent === "claude" ? state.sessionId : undefined;
  const agentResult = await deps.runAgent(
    await deps.buildAgentPrompt(generated.prompt, item),
    resumeId,
  );

  if (!agentResult.finDetected && agentResult.exitCode !== 0) {
    if (resumeId) {
      deps.logger.logWork(
        "Resume session failed — restarting agent from scratch",
      );
      const freshResult = await deps.runAgent(
        await deps.buildAgentPrompt(generated.prompt, item),
      );
      if (!freshResult.finDetected && freshResult.exitCode !== 0) {
        deps.logger.logError(
          `Agent exited with code ${freshResult.exitCode} on retry — aborting`,
        );
        if (freshResult.stderr) {
          deps.logger.logError(
            `Agent stderr: ${freshResult.stderr.slice(-1000)}`,
          );
        }
        if (deps.isAgentInfrastructureFailure(freshResult.stderr)) {
          await deps.escalateAgentInfrastructureFailure(
            state.issueKey,
            freshResult.stderr,
          );
        }
        deps.recordProcessFailure(state.issueKey);
        deps.clearRunState(state.issueKey);
        return;
      }
      deps.saveRunState({
        ...state,
        checkpoint: "agent_complete",
        sessionId: freshResult.sessionId,
        agentRanTests: freshResult.ranTests,
      });
    } else {
      deps.logger.logError(
        `Agent exited with code ${agentResult.exitCode} — aborting`,
      );
      if (agentResult.stderr) {
        deps.logger.logError(
          `Agent stderr: ${agentResult.stderr.slice(-1000)}`,
        );
      }
      if (deps.isAgentInfrastructureFailure(agentResult.stderr)) {
        await deps.escalateAgentInfrastructureFailure(
          state.issueKey,
          agentResult.stderr,
        );
      }
      deps.recordProcessFailure(state.issueKey);
      deps.clearRunState(state.issueKey);
      return;
    }
  } else {
    deps.saveRunState({
      ...state,
      checkpoint: "agent_complete",
      sessionId: agentResult.sessionId,
      agentRanTests: agentResult.ranTests,
    });
  }

  await continueFromAgentComplete(deps, cfg, item, deps.loadRunState(state.issueKey)!);
}

async function continueFromAgentComplete(
  deps: CheckpointResumerDeps,
  cfg: ServerConfig,
  item: WorkItem,
  state: RunState,
): Promise<void> {
  deps.forceCheckout(item.suggestedBranch, deps.workspace);
  if (!deps.stageAndCommit(`[AI] ${item.title}`)) {
    deps.logger.logError("Stage/commit failed on resume — aborting");
    deps.clearRunState(state.issueKey);
    return;
  }
  deps.saveRunState({ ...state, checkpoint: "changes_committed" });
  await continueFromChangesCommitted(
    deps,
    cfg,
    item,
    deps.loadRunState(state.issueKey)!,
  );
}

async function continueFromChangesCommitted(
  deps: CheckpointResumerDeps,
  cfg: ServerConfig,
  item: WorkItem,
  state: RunState,
): Promise<void> {
  const agentRanTests = state.agentRanTests ?? false;
  if (deps.skipTests) {
    deps.logger.logConfig(
      "Skipping all tests and coverage checks (--skip-tests)",
    );
  } else if (agentRanTests) {
    deps.logger.logConfig(
      "Agent already ran tests — skipping manual test gate",
    );
  } else {
    const unitResult = deps.runTestSuite("unit");
    if (unitResult.kind === "spawn_error") {
      deps.logger.logConfig(
        "Unit tests could not start on resume — proceeding without tests",
      );
    } else if (!unitResult.passed) {
      deps.logger.logError(
        `Unit tests ${unitResult.kind} on resume — aborting`,
      );
      deps.clearRunState(state.issueKey);
      return;
    }
    const integrationResult = deps.runTestSuite("integration");
    if (integrationResult.kind === "spawn_error") {
      deps.logger.logConfig(
        "Integration tests could not start on resume — skipping",
      );
    } else if (!integrationResult.passed) {
      deps.logger.logError(
        `Integration tests ${integrationResult.kind} on resume — aborting`,
      );
      deps.clearRunState(state.issueKey);
      return;
    }
    const coverageResult = deps.checkCoverage();
    if (!coverageResult.passed && coverageResult.kind !== "spawn_error") {
      await deps.fixCoverageGap(
        item,
        coverageResult.output || "coverage check failed",
      );
    }
  }
  deps.saveRunState({ ...state, checkpoint: "tests_passed" });
  await continueFromTestsPassed(
    deps,
    cfg,
    item,
    deps.loadRunState(state.issueKey)!,
  );
}

async function continueFromTestsPassed(
  deps: CheckpointResumerDeps,
  cfg: ServerConfig,
  item: WorkItem,
  state: RunState,
): Promise<void> {
  if (!deps.pushBranch(item.suggestedBranch)) {
    deps.logger.logGit("Push rejected — rebasing on remote and retrying");
    if (
      !deps.gitRun(
        ["pull", "--rebase", "origin", item.suggestedBranch],
        deps.workspace,
      ) ||
      !deps.pushBranch(item.suggestedBranch)
    ) {
      deps.logger.logError("Push failed after rebase on resume — aborting");
      deps.clearRunState(state.issueKey);
      return;
    }
  }
  deps.saveRunState({ ...state, checkpoint: "branch_pushed" });
  await continueFromBranchPushed(
    deps,
    cfg,
    item,
    deps.loadRunState(state.issueKey)!,
  );
}

async function continueFromBranchPushed(
  deps: CheckpointResumerDeps,
  cfg: ServerConfig,
  item: WorkItem,
  state: RunState,
): Promise<void> {
  const pr = await deps.createPR(cfg, item, item.suggestedBranch);
  if (pr) {
    const platform = deps.detectRemotePlatform(deps.workspace);
    const label = platform === "gitlab" ? "MR" : "PR";
    deps.logger.logPR(`Opened ${label} #${pr.prNumber}: ${pr.url}`);
    deps.saveRunState({
      ...state,
      checkpoint: "pr_created",
      prNumber: pr.prNumber,
    });
    await continueFromReviewLoop(
      deps,
      cfg,
      item,
      deps.loadRunState(state.issueKey)!,
    );
  } else {
    deps.logger.logError("PR/MR creation failed on resume — aborting");
    deps.clearRunState(state.issueKey);
  }
}

async function continueFromReviewLoop(
  deps: CheckpointResumerDeps,
  cfg: ServerConfig,
  item: WorkItem,
  state: RunState,
): Promise<void> {
  const ghToken = process.env.GITHUB_TOKEN;
  const owner = cfg.owner || process.env.GITHUB_DEFAULT_OWNER || "redsand";
  const repo = cfg.repo || process.env.AICODER_REPO || "";

  if (!state.prNumber) {
    deps.logger.logError(
      "Run state has no prNumber — cannot resume review loop",
    );
    deps.clearRunState(state.issueKey);
    return;
  }

  await deps.runReviewLoop(cfg, item, ghToken, owner, repo, state.prNumber);
}

async function continueFromReworkAgentComplete(
  deps: CheckpointResumerDeps,
  cfg: ServerConfig,
  item: WorkItem,
  state: RunState,
): Promise<void> {
  deps.forceCheckout(item.suggestedBranch, deps.workspace);
  if (!deps.stageAndCommit(`[AI] rework: ${item.title}`)) {
    deps.logger.logError("Rework stage/commit failed on resume — aborting");
    deps.clearRunState(state.issueKey);
    return;
  }
  deps.saveRunState({ ...state, checkpoint: "rework_committed" });
  await continueFromReworkCommitted(
    deps,
    cfg,
    item,
    deps.loadRunState(state.issueKey)!,
  );
}

async function continueFromReworkCommitted(
  deps: CheckpointResumerDeps,
  cfg: ServerConfig,
  item: WorkItem,
  state: RunState,
): Promise<void> {
  if (deps.skipTests) {
    deps.logger.logConfig("Skipping tests on resume (--skip-tests)");
  } else {
    const unitResult = deps.runTestSuite("unit");
    if (!unitResult.passed) {
      deps.logger.logError(
        `Rework unit tests ${unitResult.kind} on resume — aborting`,
      );
      deps.clearRunState(state.issueKey);
      return;
    }
    const integrationResult = deps.runTestSuite("integration");
    if (!integrationResult.passed) {
      deps.logger.logError(
        `Rework integration tests ${integrationResult.kind} on resume — aborting`,
      );
      deps.clearRunState(state.issueKey);
      return;
    }
    const coverageResult = deps.checkCoverage();
    if (!coverageResult.passed && coverageResult.kind !== "spawn_error") {
      await deps.fixCoverageGap(
        item,
        coverageResult.output || "coverage check failed",
      );
    }
  }
  deps.saveRunState({ ...state, checkpoint: "rework_tests_passed" });
  await continueFromReworkTestsPassed(
    deps,
    cfg,
    item,
    deps.loadRunState(state.issueKey)!,
  );
}

async function continueFromReworkTestsPassed(
  deps: CheckpointResumerDeps,
  cfg: ServerConfig,
  item: WorkItem,
  state: RunState,
): Promise<void> {
  if (!deps.pushBranch(item.suggestedBranch, { forceWithLease: true })) {
    deps.logger.logError("Rework push failed on resume — aborting");
    deps.clearRunState(state.issueKey);
    return;
  }
  const sinceTimestamp = new Date().toISOString();
  const reworkCount = state.reworkCount ?? 0;
  deps.saveRunState({
    ...state,
    checkpoint: "rework_pushed",
    sinceTimestamp,
    reworkCount,
  });
  await continueFromReviewLoop(
    deps,
    cfg,
    item,
    deps.loadRunState(state.issueKey)!,
  );
}
