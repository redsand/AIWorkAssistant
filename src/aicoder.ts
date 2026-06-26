#!/usr/bin/env tsx
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { OllamaLauncher } from "./integrations/ollama-launcher";
import { RunLogger } from "./integrations/ollama-launcher/run-logger";
import { prioritizeItems } from "./integrations/ollama-launcher/priority-sorter";
import { type TicketSourceType, SourceResolver } from "./integrations/source-resolver";
import { jiraClient } from "./integrations/jira/jira-client";
import { gitlabClient } from "./integrations/gitlab/gitlab-client";
// githubClient imported dynamically where needed via github-client module
import { agentRunDatabase } from "./agent-runs/database";
import { createAgentRunsClient } from "./agent-runs/client";
import { conversationManager } from "./memory/conversation-manager";
import type { AgentRunStepCreate } from "./agent-runs/types";
import type { AgentRun as AgentRunRecord } from "./agent-runs/types";
// ── Module imports ─────────────────────────────────────────────────────────────
import type {
  ServerConfig, WorkItem,
  TestSuiteKind, RunState,
} from "./autonomous-loop/types";
import {
  ARGV, WORKSPACE, AGENT, LABEL, SPRINT, PRIORITY, SOURCE, LOOKUP,
  USE_OLLAMA, DEBUG, ENABLE_BASELINE, SKIP_AGENT, SKIP_TESTS, SKIP_PROMPT_CHECK,
  RESUME_RUN, DISCARD_RUN, FORCE_REPROCESS, WATCH_ISSUE, MODEL, OLLAMA_URL,
  TARGET_ISSUE_KEY, PUBLISH_BRANCH, BASE_BRANCH_CANDIDATES, FOCUSED_MODE,
  SKIP_POLL, MAX_REWORK, REVIEW_POLL_MS, WAIT_FOR_DEPS, DRY_RUN_PUSH, FORCE_DONE,
  CLEANUP_MERGED,
  POLL_MS, MAX_CYCLES, UNIT_TEST_TIMEOUT, INTEGRATION_TEST_TIMEOUT, API_PROVIDER,
  AUTOREPAIR_STATUS_KEY, AUTOREPAIR_RELEASE_KEY, AUTOREPAIR_CLEAR_KEY, AUTOREPAIR_DISABLED,
} from "./autonomous-loop/arg-parser";
import { getProjectConfig as _getProjectConfig } from "./autonomous-loop/project-detect";
import { parseDependencies } from "./autonomous-loop/dependency-parser";
import {
  gitRun as _gitRun,
  gitRunWithOutput as _gitRunWithOutput,
  getCurrentBranch as _getCurrentBranch,
  isRebaseInProgress,
  recoverFromRebase as _recoverFromRebase,
  stageAndCommit as _stageAndCommit,
  pushBranch as _pushBranch,
  getBaseBranch as _getBaseBranch,
  getConflictFiles as _getConflictFiles,
  getBranchModifiedFiles as _getBranchModifiedFiles,
  pullAndUpdateBase as _pullAndUpdateBase,
  cleanupAllMergedBranches,
  type PushBranchOptions,
} from "./autonomous-loop/git-ops";
import { runTestSuite as _runTestSuite, checkCoverage as _checkCoverage } from "./autonomous-loop/test-runner";
import { runAgent as _runAgent } from "./autonomous-loop/agent-runner";
import type { AgentConfig } from "./autonomous-loop/agent-runner";
import { ProcessRetryCircuit } from "./autonomous-loop/process-retry-circuit";
import { RunStateStore } from "./aicoder/run-state";
import {
  jiraDescriptionToText,
} from "./aicoder/jira-helpers";
import {
  getUnresolvedJiraDependencies as _getUnresolvedJiraDependencies,
  fetchJiraIssueDirectly as _fetchJiraIssueDirectly,
} from "./aicoder/jira-deps";
import {
  fetchIssueBody,
  findPRForIssue,
  fetchIssueDirectly as _fetchIssueDirectly,
} from "./aicoder/github-helpers";
import { findMRForIssue as _findMRForIssue } from "./aicoder/gitlab-helpers";
// review-polling + rework-prompts + semantic-helpers now consumed only
// by review-loop.ts / other modules — no aicoder.ts call sites remain.
import {
  buildAgentPrompt as _buildAgentPrompt,
} from "./aicoder/prompt-builder";
import {
  trackStep as _trackStep,
  completeRunTrack as _completeRunTrack,
  failRunTrack as _failRunTrack,
  isAgentInfrastructureFailure,
  resetStepOrder,
  getStepOrder,
} from "./aicoder/run-tracking";
// fix-prompts (buildBaselineFixPrompt, buildCoverageFixPrompt,
// buildConflictResolutionPrompt) are consumed inside test-fix-loop.ts and
// rebase-loop.ts respectively — no aicoder.ts call sites remain.
import {
  detectPackageManager as _detectPackageManager,
  runPackageInstall as _runPackageInstall,
} from "./aicoder/package-manager";
import type { PackageManager } from "./aicoder/package-manager";
import {
  getChangedFiles as _getChangedFiles,
  summarizeDiffStat,
} from "./aicoder/git-diff-helpers";
import { classifyTestFailure as _classifyTestFailure } from "./aicoder/test-failure-classifier";
import { expandWithDependencies as _expandWithDependencies } from "./aicoder/dep-expander";
import { resolveDependencyBranch as _resolveDependencyBranch } from "./aicoder/dep-branch-resolver";
import { escalateAgentInfrastructureFailure as _escalateAgentInfrastructureFailure } from "./aicoder/infra-failure";
import { ProcessedIssuesStore } from "./aicoder/processed-issues";
import { fetchWorkItemDirectly as _fetchWorkItemDirectly } from "./aicoder/work-items";
import {
  fetchWork as _fetchWork,
  generatePrompt as _generatePrompt,
} from "./aicoder/work-source";
import {
  fixBaselineTests as _fixBaselineTests,
  fixCoverageGap as _fixCoverageGap,
  fixReworkTests as _fixReworkTests,
} from "./aicoder/test-fix-loop";
import type { TestFixDeps } from "./aicoder/test-fix-loop";
import {
  forceCheckout as _forceCheckout,
  safeStashPop as _safeStashPop,
} from "./aicoder/git-recovery";
import type { GitRecoveryDeps } from "./aicoder/git-recovery";
// resolveConflictsInWorkingTree is used internally by git-recovery.ts and
// rebase-loop.ts only — no aicoder.ts call site.
import {
  rebaseAndResolveConflicts as _rebaseAndResolveConflicts,
  resolveRebaseConflictsInPlace as _resolveRebaseConflictsInPlace,
} from "./aicoder/rebase-loop";
import type { RebaseLoopDeps } from "./aicoder/rebase-loop";
import { runReviewLoop as _runReviewLoop } from "./aicoder/review-loop";
import type { ReviewLoopDeps } from "./aicoder/review-loop";
import { resumeFromCheckpoint as _resumeFromCheckpoint } from "./aicoder/checkpoint-resumers";
import type { CheckpointResumerDeps } from "./aicoder/checkpoint-resumers";
import { shouldSkipIssue } from "./aicoder/issue-precheck";
import type { IssuePrecheckDeps } from "./aicoder/issue-precheck";
import { transitionIssueToInProgress } from "./aicoder/issue-transition";
import type { IssueTransitionDeps } from "./aicoder/issue-transition";
import { resolveIssueDependencies } from "./aicoder/dep-resolution";
import type { DepResolutionDeps } from "./aicoder/dep-resolution";
import { publishBranch as _publishBranch } from "./aicoder/publish-branch";
import type { PublishBranchDeps } from "./aicoder/publish-branch";
import { checkoutBranch as _checkoutBranch } from "./aicoder/checkout-branch";
import type { CheckoutBranchDeps } from "./aicoder/checkout-branch";
import { ensureCleanWorkspace as _ensureCleanWorkspace } from "./aicoder/ensure-clean-workspace";
import type { EnsureCleanWorkspaceDeps } from "./aicoder/ensure-clean-workspace";
import { watchIssue as _watchIssue } from "./aicoder/watch-issue";
import type { WatchIssueDeps } from "./aicoder/watch-issue";
import {
  focusedLoop as _focusedLoop,
  pollLoop as _pollLoop,
} from "./aicoder/run-modes";
import type { RunModesDeps } from "./aicoder/run-modes";
import { applyProviderRouting, hasSecret } from "./autonomous-loop/provider-routing";
// enrichPrompt now used internally by src/aicoder/prompt-builder.ts
import {
  detectRemotePlatform,
  getGitLabProjectFromRemote,
  findExistingGitLabMR,
  createPR as _createPR,
  truncate,
  extractIssueKeyFromBranchName,
} from "./autonomous-loop/pr-creator";
import { notifyComplete as _notifyComplete, authHeaders } from "./autonomous-loop/notify";
import {
  validateOutputFromDiff,
  validateDiffBeforePush,
  EXIT_SUCCESS,
  EXIT_NO_CHANGES,
  EXIT_PLACEHOLDER_ONLY,
  EXIT_GIT_FAILURE,
  EXIT_TEST_FAILURE,
  EXIT_REVIEW_FAILED,
  EXIT_MAX_REWORK,
  EXIT_WHITESPACE_ONLY,
  EXIT_META_ONLY,
} from "./aicoder-pipeline";
// Most convergence helpers, prompt strategies, semantic review, review-
// gate state, autorepair, and rework prompts are consumed inside
// src/aicoder/review-loop.ts. processWorkItem still needs the
// pre-check trio (loadConvergenceState + checkConvergence +
// DEFAULT_CONVERGENCE_CONFIG) for the "issue already stuck — refuse
// to re-pickup" guard.
import { loadConvergenceState } from "./autonomous-loop/convergence-state";
import {
  checkConvergence,
  DEFAULT_CONVERGENCE_CONFIG,
} from "./autonomous-loop/convergence";
import { markForceDone } from "./autonomous-loop/review-gate-state";
import { ensureAgentsMdRules } from "./autonomous-loop/agents-md";
// hashUuidToNumber / parseWorkItemTagsJson / extractCodingPromptSection are
// now used inside src/aicoder/work-items.ts after the work-items extraction.
import {
  getAutorepairStatus,
  forceReleaseAutorepair,
  clearAutorepairGate,
  isGatePaused as _isAutorepairPaused,
  isGateEscalated as _isAutorepairEscalated,
} from "./autonomous-loop/ticket-autorepair";

// Re-export so callers and the orchestrator can import from either module.
export {
  EXIT_SUCCESS,
  EXIT_NO_CHANGES,
  EXIT_PLACEHOLDER_ONLY,
  EXIT_GIT_FAILURE,
  EXIT_TEST_FAILURE,
  EXIT_REVIEW_FAILED,
  EXIT_MAX_REWORK,
  EXIT_WHITESPACE_ONLY,
  EXIT_META_ONLY,
};


// Tracks the exit code for the most recent pipeline run so --issue paths
// can call process.exit() with a meaningful code instead of always exiting 0.
let lastPipelineExitCode: number = EXIT_SUCCESS;

// Semantic-finding helpers + extractFilesFromText moved to
// src/aicoder/semantic-helpers.ts

// buildAgentPrompt moved to src/aicoder/prompt-builder.ts. enrichPromptWithMemory
// is no longer called from aicoder.ts directly — work-items.ts uses it internally.
const buildAgentPrompt = (prompt: string, item?: WorkItem) =>
  _buildAgentPrompt(conversationManager, WORKSPACE, prompt, item);

// Review result markers (must match reviewer.ts comment headers)
// Review marker constants moved to src/aicoder/review-polling.ts.

process.env.AICODER_AGENT = AGENT;
process.env.AICODER_MODEL = MODEL;
process.env.AICODER_OLLAMA = USE_OLLAMA ? "true" : "false";

const providerRouting = applyProviderRouting({
  apiProvider: API_PROVIDER,
  agent: AGENT,
  model: MODEL,
  env: process.env,
});
if (providerRouting) {
  console.log(`[aicoder] provider routing openaiBase=${providerRouting.base} anthropicBase=${AGENT === "claude" ? providerRouting.anthropicBase : "n/a"} key=${hasSecret(process.env.OPENAI_API_KEY)} codexKey=${hasSecret(process.env.CODEX_API_KEY)}`);
}

console.log(`[aicoder] agent=${AGENT} model=${MODEL} api=${API_PROVIDER ?? "default"} ollama=${USE_OLLAMA} workspace=${WORKSPACE}`);
const ollamaLauncher = USE_OLLAMA ? new OllamaLauncher({ ollamaUrl: OLLAMA_URL }) : null;
const runLogger = new RunLogger(WORKSPACE);

// If --force-done is set, mark the review gate as overridden (audited)
if (FORCE_DONE) {
  markForceDone();
  console.log("[Review Gate] --force-done flag set: review gate will be bypassed for Done transitions (audited)");
}

// ── Workspace-bound bridges ──────────────────────────────────────────────────
// Bind extracted module functions to the local WORKSPACE + runLogger so all
// existing call sites continue to work without signature changes.
const getProjectConfig = () => _getProjectConfig(WORKSPACE, runLogger);
const gitRun = (args: string[], cwd: string) => _gitRun(args, cwd, runLogger);
const gitRunWithOutput = (args: string[], cwd: string) => _gitRunWithOutput(args, cwd, runLogger);
const getCurrentBranch = () => _getCurrentBranch(WORKSPACE);
const recoverFromRebase = (cwd: string) => _recoverFromRebase(cwd, runLogger);
const stageAndCommit = (message: string) => _stageAndCommit(message, WORKSPACE, runLogger);
const pushBranch = (branchName: string, options: PushBranchOptions = {}) => _pushBranch(branchName, WORKSPACE, runLogger, options);
const getBaseBranch = () => _getBaseBranch(WORKSPACE, BASE_BRANCH_CANDIDATES, runLogger);
const getConflictFiles = () => _getConflictFiles(WORKSPACE);
const getBranchModifiedFiles = () => _getBranchModifiedFiles(WORKSPACE, getBaseBranch(), runLogger);
// pullAndUpdateBase needs forceCheckout (declared below) — works via function hoisting
const pullAndUpdateBase = () => _pullAndUpdateBase(WORKSPACE, BASE_BRANCH_CANDIDATES, runLogger, (b: string, d: string) => forceCheckout(b, d));
const runTestSuite = (suiteKind: TestSuiteKind = "all") => _runTestSuite(suiteKind, getProjectConfig(), WORKSPACE, runLogger, UNIT_TEST_TIMEOUT, INTEGRATION_TEST_TIMEOUT);
const checkCoverage = () => _checkCoverage(getProjectConfig(), WORKSPACE, runLogger);
const agentCfg: AgentConfig = { agent: AGENT, workspace: WORKSPACE, model: MODEL, apiProvider: API_PROVIDER, debug: DEBUG, ollamaUrl: OLLAMA_URL };
let activeChild: import("child_process").ChildProcess | null = null;
function runAgent(prompt: string, resumeSessionId?: string, runId?: string) {
  const cfg: AgentConfig = {
    ...agentCfg,
    onHeartbeat: runId ? () => { agentRunDatabase.touchRun(runId); } : undefined,
  };
  return _runAgent(prompt, cfg, ollamaLauncher, resumeSessionId, runLogger, (child) => { activeChild = child; });
}
const createPR = (cfg: ServerConfig, item: WorkItem, branchName: string) => _createPR(cfg, item, branchName, WORKSPACE, getBaseBranch(), runLogger);
const notifyComplete = (cfg: ServerConfig, item: WorkItem, prNumber: number, branchName: string, exitCode: number | null) => _notifyComplete(cfg, item, prNumber, branchName, exitCode, WORKSPACE, runLogger);



const BASELINE_MAX_FIX_ATTEMPTS = parseInt(process.env.AICODER_BASELINE_MAX_FIX || "2", 10);

function loadServerConfig(): ServerConfig {
  const apiUrl = (process.env.AIWORKASSISTANT_URL || "http://localhost:3050").replace(/\/$/, "");
  const apiKey = process.env.AIWORKASSISTANT_API_KEY || "";

  if (!apiKey) {
    const logger = new RunLogger(WORKSPACE);
    logger.logError("AIWORKASSISTANT_API_KEY is required");
    process.exit(1);
  }

  return {
    apiUrl,
    apiKey,
    owner: ARGV.owner || process.env.AICODER_OWNER || "",
    repo: ARGV.repo || process.env.AICODER_REPO || "",
    source: SOURCE,
  };
}

// fetchWork moved to src/aicoder/work-source.ts
const fetchWork = (cfg: ServerConfig) =>
  _fetchWork(cfg, { label: LABEL, sprint: SPRINT, skipPromptCheck: SKIP_PROMPT_CHECK });

/** Minimal ADF → text conversion for dep-expansion (mirrors server-side extractJiraBodyText). */
// Jira helpers (adfToText, extractJiraSprint, jiraDescriptionToText,
// isDoneStatus) live in src/aicoder/jira-helpers.ts as of 2026-06-25.
// Pure functions with no aicoder globals — extracted alongside RunStateStore
// as part of the staged aicoder.ts split.

// expandWithDependencies moved to src/aicoder/dep-expander.ts. The wrapper
// below preserves the existing call signature; remove once all call sites
// adopt the new positional/options interface.
const expandWithDependencies = (
  items: WorkItem[],
  source: string,
  ghToken: string,
  owner: string,
  repo: string,
) =>
  _expandWithDependencies({
    jiraClient,
    gitlabClient,
    logger: runLogger,
    items,
    source,
    ghToken,
    owner,
    repo,
  });


// generatePrompt moved to src/aicoder/work-source.ts
const generatePrompt = (cfg: ServerConfig, item: WorkItem) =>
  _generatePrompt(conversationManager, runLogger, cfg, item);

/**
 * Detect whether the git remote origin points to GitHub, GitLab, or unknown.
 * Returns "github" for github.com URLs, "gitlab" for gitlab.* URLs, "unknown" otherwise.
 */

/**
 * Extract the GitLab project path from the git remote URL.
 * Handles both HTTPS (https://gitlab.example.com/group/project) and
 * SSH (git@gitlab.example.com:group/project.git) formats.
 * Returns the URL-encoded path suitable for GitLab API calls (e.g. "siem%2Fhawk-soard").
 */

/** Find an existing open MR for the given source branch. */

/** Find an existing open GitHub PR for the given source branch. */



// ---------------------------------------------------------------------------
// Extract issue key from branch name
// Jira: ai/issue-ir-82-fix-thing → IR-82
// Numeric: ai/issue-51-fix-thing → 51
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Publish an existing branch as a PR/MR with full reviewer context
// ---------------------------------------------------------------------------




/**
 * Validate agent output by diffing the feature branch against its base.
 * Wraps validateOutputFromDiff with real git calls.
 * Returns { valid: true } on git infrastructure errors so a transient git
 * problem doesn't false-positive as EXIT_NO_CHANGES.
 */
function validateOutput(baseBranch: string): ReturnType<typeof validateOutputFromDiff> {
  const statResult = gitRunWithOutput(["diff", `${baseBranch}...HEAD`, "--stat"], WORKSPACE);
  if (!statResult.ok) {
    runLogger.logGit("git diff --stat failed — skipping output validation", statResult.stderr);
    return { valid: true, exitCode: EXIT_SUCCESS, reason: "git diff unavailable — skipped" };
  }
  const diffResult = gitRunWithOutput(["diff", `${baseBranch}...HEAD`], WORKSPACE);
  return validateOutputFromDiff(statResult.stdout, diffResult.stdout, SKIP_AGENT);
}

// getChangedFiles + summarizeDiffStat moved to src/aicoder/git-diff-helpers.ts
const getChangedFiles = (fromRef: string, toRef: string = "HEAD") =>
  _getChangedFiles(WORKSPACE, fromRef, toRef);



/**
 * Recover from a stuck rebase state. Tries git rebase --abort first,
 * then removes blocking files and retries, then manually cleans up
 * .git/rebase-merge/ and .git/rebase-apply/ as a last resort.
 * Never uses git reset --hard — always preserves working tree changes.
 */

/**
 * Ensure the workspace is in a clean, usable state. Fixes:
 * 1. Mid-rebase states
 * 2. Unmerged paths from failed merges/stash pops
 * 3. Dirty working tree (uncommitted changes)
 * 4. Detached HEAD state
 * Returns true if the workspace is clean, false if recovery failed.
 */
// ensureCleanWorkspace moved to src/aicoder/ensure-clean-workspace.ts
function ensureCleanWorkspaceDeps(): EnsureCleanWorkspaceDeps {
  return {
    logger: runLogger,
    workspace: WORKSPACE,
    isRebaseInProgress,
    recoverFromRebase,
    gitRun,
    gitRunWithOutput: (args, cwd) => _gitRunWithOutput(args, cwd),
    stageAndCommit,
    getCurrentBranch,
    getBaseBranch,
    forceCheckout,
    summarizeDiffStat,
  };
}
const ensureCleanWorkspace = () =>
  _ensureCleanWorkspace(ensureCleanWorkspaceDeps());

/**
 * Resolve the actual default branch by checking git remote HEAD,
 * then falling back to trying each candidate branch that exists locally.
 */
/**
 * Force-checkout a branch, handling untracked file conflicts.
 * If checkout fails because untracked files would be overwritten,
 * stages and commits those files to preserve them, then retries.
 * Falls back to git stash --include-untracked if staging fails.
 */
// forceCheckout + safeStashPop moved to src/aicoder/git-recovery.ts
function gitRecoveryDeps(): GitRecoveryDeps {
  return {
    logger: runLogger,
    workspace: WORKSPACE,
    getCurrentBranch,
    stageAndCommit,
    getBranchModifiedFiles,
  };
}
const forceCheckout = (branch: string, cwd: string) =>
  _forceCheckout(gitRecoveryDeps(), branch, cwd);
const safeStashPop = (cwd: string) => _safeStashPop(gitRecoveryDeps(), cwd);

/**
 * Get the list of files modified by the current branch compared to the base branch.
 * Used to determine which files the AI changed, so we can decide conflict resolution strategy.
 */

/**
 * Resolve git conflicts in the working tree. For files modified by the AI branch,
 * accept the AI's version. For files NOT modified by the AI branch,
 * accept the base branch version.
 *
 * IMPORTANT: During rebase, git's --ours/--theirs semantics are INVERTED:
 *   --ours = base branch (the branch being rebased onto)
 *   --theirs = feature branch (the commits being replayed)
 * So during rebase, we use --theirs for AI files and --ours for base files.
 */
// resolveConflictsInWorkingTree moved to src/aicoder/git-recovery.ts.
// rebase-loop.ts consumes it internally — no top-level alias needed here.

// rebaseAndResolveConflicts moved to src/aicoder/rebase-loop.ts
function rebaseLoopDeps(): RebaseLoopDeps {
  return {
    logger: runLogger,
    workspace: WORKSPACE,
    baseBranch: getBaseBranch(),
    getBranchModifiedFiles,
    getConflictFiles,
    stageAndCommit,
    runAgent: (prompt) => runAgent(prompt) as Promise<{ finDetected: boolean; exitCode: number | null }>,
    gitRecoveryDeps: gitRecoveryDeps(),
  };
}
const rebaseAndResolveConflicts = (branchName: string) =>
  _rebaseAndResolveConflicts(rebaseLoopDeps(), branchName);



// resolveRebaseConflictsInPlace moved to src/aicoder/rebase-loop.ts
const resolveRebaseConflictsInPlace = (branchName: string) =>
  _resolveRebaseConflictsInPlace(rebaseLoopDeps(), branchName);

// checkoutBranch + syncRemoteBranch moved to src/aicoder/checkout-branch.ts
function checkoutBranchDeps(): CheckoutBranchDeps {
  return {
    logger: runLogger,
    workspace: WORKSPACE,
    gitRun,
    gitRunWithOutput: (args, cwd) => _gitRunWithOutput(args, cwd),
    isRebaseInProgress,
    recoverFromRebase,
    safeStashPop,
    getCurrentBranch,
    stageAndCommit,
    pullAndUpdateBase,
    getBaseBranch,
    forceCheckout,
    resolveRebaseConflictsInPlace,
  };
}
const checkoutBranch = (branchName: string, fromBranch?: string) =>
  _checkoutBranch(checkoutBranchDeps(), branchName, fromBranch);



// buildConflictResolutionPrompt is consumed by src/aicoder/rebase-loop.ts.
// buildBaselineFixPrompt + buildCoverageFixPrompt are consumed by
// src/aicoder/test-fix-loop.ts. Both modules import from fix-prompts
// directly; no aicoder.ts call sites remain.

/** Detect which package manager to use in the workspace. */
// detectPackageManager + runPackageInstall moved to src/aicoder/package-manager.ts
const detectPackageManager = () => _detectPackageManager(WORKSPACE);
const runPackageInstall = (pm: PackageManager) =>
  _runPackageInstall(runLogger, WORKSPACE, pm);

// Test-fix orchestrators moved to src/aicoder/test-fix-loop.ts. Each wrapper
// resolves the deps from this file's singletons + module-level config and
// delegates. Keeping the original signatures avoids touching every caller.
const COVERAGE_MAX_FIX_ATTEMPTS = parseInt(process.env.AICODER_COVERAGE_MAX_FIX || "2", 10);
const MAX_REWORK_FIX_ATTEMPTS = 10;

function buildTestFixDeps(): TestFixDeps {
  const cfg = getProjectConfig();
  return {
    logger: runLogger,
    hasTests: cfg.hasTests,
    testCommand: cfg.testCommand.join(" "),
    coverageCommand: cfg.coverageCommand.join(" "),
    skipTests: SKIP_TESTS,
    baselineMaxFixAttempts: BASELINE_MAX_FIX_ATTEMPTS,
    coverageMaxFixAttempts: COVERAGE_MAX_FIX_ATTEMPTS,
    reworkMaxFixAttempts: MAX_REWORK_FIX_ATTEMPTS,
    maxRework: MAX_REWORK,
    runAgent,
    stageAndCommit,
    runTestSuite,
    checkCoverage,
    classifyTestFailure: (out) => _classifyTestFailure(runLogger, WORKSPACE, out),
    detectPackageManager,
    runPackageInstall,
  };
}

const fixBaselineTests = (_cfg: ServerConfig, item: WorkItem) =>
  _fixBaselineTests(buildTestFixDeps(), item);
const fixCoverageGap = (item: WorkItem, coverageOutput: string) =>
  _fixCoverageGap(buildTestFixDeps(), item, coverageOutput);
const fixReworkTests = (item: WorkItem, reworkCount: number) =>
  _fixReworkTests(buildTestFixDeps(), item, reworkCount);
// attemptTestFix is used internally by test-fix-loop.ts (via fixReworkTests)
// and no longer needs a top-level alias here.
// classifyTestFailure (formerly llmEvaluateTestFailure) is consumed via
// deps.classifyTestFailure inside the same module.



// --- Dependency resolution ---

// jiraDescriptionToText / isDoneStatus moved to src/aicoder/jira-helpers.ts

// getUnresolvedJiraDependencies moved to src/aicoder/jira-deps.ts
const getUnresolvedJiraDependencies = (issueKeys: string[]) =>
  _getUnresolvedJiraDependencies(jiraClient, issueKeys);

// fetchIssueBody + findPRForIssue moved to src/aicoder/github-helpers.ts

// findMRForIssue moved to src/aicoder/gitlab-helpers.ts
const findMRForIssue = (projectId: string, issueNumber: number) =>
  _findMRForIssue(gitlabClient, projectId, issueNumber);

// resolveDependencyBranch moved to src/aicoder/dep-branch-resolver.ts
const resolveDependencyBranch = (
  ghToken: string,
  owner: string,
  repo: string,
  depIssueRefs: string[],
) =>
  _resolveDependencyBranch(
    {
      logger: runLogger,
      platform: detectRemotePlatform(WORKSPACE) as "github" | "gitlab" | "unknown",
      baseBranch: getBaseBranch(),
      gitlabProjectId: repo || process.env.GITLAB_DEFAULT_PROJECT || "",
      ghOwner: owner,
      ghRepo: repo,
      findPRForIssue: (n) => findPRForIssue(ghToken, owner, repo, n),
      findMRForIssue,
    },
    depIssueRefs,
  );

// pollForReviewResult, pollForGitLabReviewResult, fetchReworkPrompt,
// fetchGitLabReworkPrompt — all consumed inside src/aicoder/review-loop.ts.
// No top-level wrappers in aicoder.ts anymore.





const infrastructureBlockedIssues = new Set<string>();
const MAX_FAILED_ATTEMPTS = 3;
// Items dep-blocked in the current poll cycle — cleared each cycle, used by focusedLoop
// to skip past blocked items and try the next one rather than stalling the whole cycle.
const depBlockedThisCycle = new Set<string>();

// Process-local crash-loop circuit. The DB-backed blacklist works for normal
// flow but FORCE_REPROCESS bypasses it, which let one issue (#50, 2026-06-18)
// burn through 103 retries in 3h when the agent crashed immediately each
// time. The circuit below tracks failures inside the CURRENT aicoder process
// — regardless of --force — so a tight-loop crash pattern can never racket
// through more than AICODER_PROCESS_RETRY_MAX (default 3) attempts inside
// AICODER_PROCESS_RETRY_WINDOW_MS (default 10 min). Operator clears it by
// restarting the process or waiting out the window.
const processRetryCircuit = new ProcessRetryCircuit({
  maxFailures: (() => {
    const n = parseInt(process.env.AICODER_PROCESS_RETRY_MAX || "3", 10);
    return Number.isFinite(n) && n > 0 ? n : 3;
  })(),
  windowMs: (() => {
    const n = parseInt(process.env.AICODER_PROCESS_RETRY_WINDOW_MS || "600000", 10);
    return Number.isFinite(n) && n > 0 ? n : 600_000;
  })(),
});

// Combined processed-issues ledger + crash-loop circuit. See
// src/aicoder/processed-issues.ts. `processedIssues` proxy preserves the
// existing call sites that read `.has(...)` / `.add(...)` directly.
const _processedIssuesStore = new ProcessedIssuesStore({
  workspace: WORKSPACE,
  db: agentRunDatabase,
  circuit: processRetryCircuit,
  logger: runLogger,
});
const processedIssues = {
  has: (key: string) => _processedIssuesStore.has(key),
  add: (key: string) => _processedIssuesStore.save(key),
  delete: (key: string) => _processedIssuesStore.delete(key),
  get size() {
    return _processedIssuesStore.size();
  },
};
const recordProcessFailure = (issueKey: string) =>
  _processedIssuesStore.recordFailure(issueKey);
const clearProcessFailures = (issueKey: string) =>
  _processedIssuesStore.clearFailures(issueKey);
const checkProcessRetryCircuit = (issueKey: string) =>
  _processedIssuesStore.checkRetryCircuit(issueKey);
const loadProcessedIssues = () => _processedIssuesStore.load();
const saveProcessedIssue = (issueKey: string) => _processedIssuesStore.save(issueKey);

function issuePrecheckDeps(): IssuePrecheckDeps {
  return {
    logger: runLogger,
    workspace: WORKSPACE,
    force: FORCE_REPROCESS,
    maxFailedAttempts: MAX_FAILED_ATTEMPTS,
    infrastructureBlockedIssues,
    processedIssues,
    checkProcessRetryCircuit,
    agentRunDatabase,
    saveProcessedIssue,
    convergence: {
      loadConvergenceState,
      checkConvergence,
      config: DEFAULT_CONVERGENCE_CONFIG,
    },
  };
}

function issueTransitionDeps(): IssueTransitionDeps {
  return {
    logger: runLogger,
    workspace: WORKSPACE,
    jiraClient,
    gitlabClient,
    getGitLabProjectFromRemote,
    authHeaders,
    trackStep,
    saveProcessedIssue,
    clearFailedAttempt: (issueKey, workspace) =>
      agentRunDatabase.clearFailedAttempt(issueKey, workspace),
  };
}

function depResolutionDeps(): DepResolutionDeps {
  return {
    logger: runLogger,
    workspace: WORKSPACE,
    waitForDeps: WAIT_FOR_DEPS,
    jiraClient,
    jiraDescriptionToText,
    parseDependencies,
    fetchIssueBody,
    getUnresolvedJiraDependencies,
    resolveDependencyBranch,
    getBaseBranch,
    trackStep,
    completeRunTrack,
    clearFailedAttempt: (issueKey, workspace) =>
      agentRunDatabase.clearFailedAttempt(issueKey, workspace),
    markDepBlockedThisCycle: (issueKey) => depBlockedThisCycle.add(issueKey),
    model: MODEL,
  };
}

function publishBranchDeps(): PublishBranchDeps {
  return {
    logger: runLogger,
    workspace: WORKSPACE,
    dryRunPush: DRY_RUN_PUSH,
    targetIssueKey: TARGET_ISSUE_KEY,
    source: SOURCE,
    exitSuccess: EXIT_SUCCESS,
    gitRun,
    gitRunWithOutput: (args, cwd) => _gitRunWithOutput(args, cwd),
    getBaseBranch,
    pushBranch,
    validateDiffBeforePush,
    extractIssueKeyFromBranchName,
    detectRemotePlatform,
    getGitLabProjectFromRemote,
    truncate,
    authHeaders,
    jiraClient,
    fetchWorkItemDirectly,
    fetchJiraIssueDirectly,
    fetchIssueDirectly,
  };
}
const publishBranch = (cfg: ServerConfig, branchName: string) =>
  _publishBranch(publishBranchDeps(), cfg, branchName);

// ─── Run state persistence ──────────────────────────────────────────────────
// Logic lives in src/aicoder/run-state.ts (extracted 2026-06-25 as proof-of-
// pattern for the larger aicoder.ts split). The thin wrappers below preserve
// the existing call sites so callers don't have to plumb the store through.

const runStateStore = new RunStateStore({
  workspace: WORKSPACE,
  targetIssueKey: TARGET_ISSUE_KEY,
  logger: runLogger,
});

function loadRunState(issueKey?: string): RunState | null {
  return runStateStore.load(issueKey);
}
function findExistingRunState(): RunState | null {
  return runStateStore.findExisting();
}
function saveRunState(state: RunState, issueKey?: string): void {
  runStateStore.save(state, issueKey);
}
function clearRunState(issueKey?: string): void {
  runStateStore.clear(issueKey);
}

// Agent-runs tracking: record aicoder steps via API (preferred) or direct DB (fallback)
const agentRunsClient = createAgentRunsClient();

// trackStep / completeRunTrack / failRunTrack / isAgentInfrastructureFailure
// moved to src/aicoder/run-tracking.ts
const trackStep = (
  runId: string,
  stepType: AgentRunStepCreate["stepType"],
  content: string,
  extra?: Partial<Pick<AgentRunStepCreate, "toolName" | "success" | "errorMessage" | "durationMs">>,
) => _trackStep(agentRunsClient, agentRunDatabase, runId, stepType, content, extra);

const completeRunTrack = (
  runId: string,
  data: { model: string; toolLoopCount: number; totalTokens: number },
) => _completeRunTrack(agentRunsClient, agentRunDatabase, runId, data);

const failRunTrack = (runId: string, errorMessage: string) =>
  _failRunTrack(agentRunsClient, agentRunDatabase, runId, errorMessage);

// escalateAgentInfrastructureFailure moved to src/aicoder/infra-failure.ts
const escalateAgentInfrastructureFailure = (
  issueKey: string,
  stderr: string | undefined,
) =>
  _escalateAgentInfrastructureFailure(
    jiraClient,
    {
      markBlocked: (key) => infrastructureBlockedIssues.add(key),
      markProcessed: saveProcessedIssue,
    },
    issueKey,
    stderr,
  );

async function processWorkItem(cfg: ServerConfig, item: WorkItem): Promise<{ prNumber: number } | null> {
  const issueKey = item.id || String(item.number);

  // All pre-flight skip checks moved to src/aicoder/issue-precheck.ts.
  if (shouldSkipIssue(issuePrecheckDeps(), issueKey).skip) {
    return null;
  }

  runLogger.startRun(item.number, item.title);
  runLogger.logWork(`Starting issue ${issueKey}: ${item.title}`);

  // Initialize run state for checkpoint persistence
  let currentState: RunState = {
    issueKey,
    issueNumber: item.number,
    title: item.title,
    url: item.url,
    owner: item.owner,
    repo: item.repo,
    suggestedBranch: item.suggestedBranch,
    labels: item.labels,
    source: (cfg.source === "gitlab" ? "gitlab" : cfg.source === "jira" ? "jira" : cfg.source === "work_items" ? "work_items" : "github") as RunState["source"],
    checkpoint: "issue_transitioned",
    apiUrl: cfg.apiUrl,
    apiKey: cfg.apiKey,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Create agent-runs record for API visibility
  resetStepOrder();
  const runParams = {
    userId: "aicoder",
    mode: `issue:${issueKey}`,
    model: MODEL || null,
    provider: API_PROVIDER || AGENT,
    issuePlatform: (cfg.source === "gitlab" ? "gitlab" : cfg.source === "jira" ? "jira" : cfg.source === "work_items" ? "work_items" : "github"),
    issueId: issueKey,
    issueRepo: cfg.repo || item.repo || process.env.AICODER_REPO || "",
    issueSprint: item.sprint ?? null,
    worktreePath: WORKSPACE,
    branch: item.suggestedBranch,
    agentType: AGENT,
  };
  let run: AgentRunRecord;
  if (agentRunsClient) {
    const apiRun = await agentRunsClient.startRun(runParams);
    if (apiRun) {
      run = apiRun;
    } else {
      run = agentRunDatabase.startRun(runParams);
    }
  } else {
    run = agentRunDatabase.startRun(runParams);
  }
  trackStep(run.id, "note", `Starting work on ${issueKey}: ${item.title}`);

  const startTime = Date.now();

  const ghToken = process.env.GITHUB_TOKEN;
  const owner = cfg.owner || process.env.GITHUB_DEFAULT_OWNER || "redsand";
  const repo = cfg.repo || process.env.AICODER_REPO || "";

  // Resolve dependencies before changing source status or starting the agent.
  // Logic lives in src/aicoder/dep-resolution.ts.
  const depResolution = await resolveIssueDependencies(depResolutionDeps(), {
    issueKey,
    item,
    runId: run.id,
    ghToken,
    owner,
    repo,
  });
  if (depResolution.kind === "blocked") {
    return null;
  }
  const fromBranch: string | undefined = depResolution.fromBranch;

  // Mark issue as "In Progress" so escalation doesn't pick it up.
  // Logic lives in src/aicoder/issue-transition.ts (4 provider branches).
  const transitionResult = await transitionIssueToInProgress(
    issueTransitionDeps(),
    cfg,
    item,
    run.id,
    ghToken,
  );
  if (transitionResult.alreadyDone) {
    return null;
  }

  // Checkpoint: issue transitioned
  saveRunState({ ...currentState, checkpoint: "issue_transitioned" });

  const generated = await generatePrompt(cfg, item);
  if (generated.skipped) {
    runLogger.logSkip(`Issue #${item.number}: ${generated.skipReason}`);
    runLogger.endRun(null);
    return null;
  }

  // Show a summary of the prompt so the user can verify what the agent is working on
  const promptPreview = generated.prompt.length > 500
    ? generated.prompt.slice(0, 500) + `\n... (${generated.prompt.length} chars total)`
    : generated.prompt;
  runLogger.logWork(`Agent prompt:\n${promptPreview}`);

  const branchName = item.suggestedBranch;
  if (!await checkoutBranch(branchName, fromBranch)) {
    runLogger.logError(`Could not create branch ${branchName} — skipping`);
    runLogger.endRun(1);
    trackStep(run.id, "tool_call", `Branch checkout failed: ${branchName}`, { toolName: "git_checkout", success: false });
    failRunTrack(run.id, `Could not create branch ${branchName}`);
    return null;
  }
  trackStep(run.id, "tool_call", `Checked out branch: ${branchName}${fromBranch ? ` (from ${fromBranch})` : ""}`, { toolName: "git_checkout" });

  // Checkpoint: branch checked out
  currentState = { ...currentState, fromBranch, checkpoint: "branch_checked_out" };
  saveRunState(currentState);

  // Ensure the workspace has targeted prompt rules to reduce LLM errors
  if (ensureAgentsMdRules(WORKSPACE)) {
    trackStep(run.id, "note", "Ensured AGENTS.md contains targeted prompt rules for this workspace");
  }

  // TDD: Run baseline tests first when explicitly enabled; if they fail, try to fix before starting work
  if (!ENABLE_BASELINE) {
    runLogger.logConfig("Skipping baseline test check (enable with --enable-baseline)");
  } else if (!(await fixBaselineTests(cfg, item))) {
    runLogger.logError("Baseline tests could not be fixed — aborting. Issue will be retried.");
    runLogger.endRun(1);
    // Don't save to processedIssues — allow retry on next aicoder cycle
    trackStep(run.id, "tool_call", "Baseline tests failed", { toolName: "test_baseline", success: false });
    failRunTrack(run.id, "Baseline tests could not be fixed");
    return null;
  }

  // Checkpoint: baseline tests passed
  saveRunState({ ...currentState, checkpoint: "baseline_tests_pass" });

  const agentStartTime = Date.now();
  let finDetected: boolean;
  let exitCode: number | null;
  let agentRanTests: boolean;
  let agentSessionId: string | undefined;
  let agentStderr: string | undefined;
  if (SKIP_AGENT) {
    runLogger.logConfig("Skipping agent execution (--skip-agent) — using existing changes");
    finDetected = true;
    exitCode = 0;
    agentRanTests = false;
  } else {
    trackStep(run.id, "note", `Running ${AGENT} agent...`);
    const agentResult = await runAgent(await buildAgentPrompt(generated.prompt, item), undefined, run.id);
    finDetected = agentResult.finDetected;
    exitCode = agentResult.exitCode;
    agentRanTests = agentResult.ranTests ?? false;
    agentSessionId = agentResult.sessionId;
    agentStderr = agentResult.stderr;
  }

  // Checkpoint: agent complete
  currentState = { ...currentState, checkpoint: "agent_complete", sessionId: agentSessionId, agentRanTests };
  saveRunState(currentState);
  const agentDuration = Date.now() - agentStartTime;
  trackStep(run.id, "model_response", `Agent finished (FIN=${finDetected}, exit=${exitCode}, ${agentDuration}ms)`, { toolName: AGENT, durationMs: agentDuration, success: finDetected || exitCode === 0 });

  if (!finDetected && exitCode !== 0) {
    runLogger.log(`WARN`, `Agent exited with code ${exitCode} and no FIN signal — skipping push`);
    if (agentStderr) runLogger.logError(`Agent stderr: ${agentStderr.slice(-1000)}`);
    if (isAgentInfrastructureFailure(agentStderr)) {
      runLogger.logError("Agent infrastructure failure detected — escalating and suppressing retries for this process");
      await escalateAgentInfrastructureFailure(issueKey, agentStderr);
      lastPipelineExitCode = EXIT_REVIEW_FAILED;
    }
    // Feed the process-local circuit so a tight crash loop can't keep
    // burning compute. Independent of the persistent DB blacklist so the
    // two limits compose; --force bypasses the DB blacklist but not this.
    recordProcessFailure(issueKey);
    runLogger.endRun(exitCode);
    failRunTrack(run.id, `Agent exited with code ${exitCode}, no FIN signal`);
    return null;
  }

  if (!stageAndCommit(`[AI] ${item.title}`)) {
    runLogger.logError("Stage/commit failed — skipping push");
    lastPipelineExitCode = EXIT_GIT_FAILURE;
    runLogger.endRun(EXIT_GIT_FAILURE);
    // Don't save to processedIssues — allow retry on next aicoder cycle
    trackStep(run.id, "tool_call", "Stage & commit failed", { toolName: "git_commit", success: false });
    failRunTrack(run.id, "Stage/commit failed");
    return null;
  }
  trackStep(run.id, "tool_call", "Staged and committed changes", { toolName: "git_commit" });

  // Validate output — catch empty diffs and placeholder-only changes before
  // spending time on tests, a push, and a PR that would be a false positive.
  if (!SKIP_AGENT) {
    const validation = validateOutput(getBaseBranch());
    if (!validation.valid) {
      lastPipelineExitCode = validation.exitCode;
      runLogger.logError(`Output validation failed (exit ${validation.exitCode}): ${validation.reason}`);
      runLogger.endRun(validation.exitCode);
      trackStep(run.id, "tool_call", `Output validation failed: ${validation.reason}`, { toolName: "validate_output", success: false });
      failRunTrack(run.id, `Output validation failed: ${validation.reason}`);
      return null;
    }

    // Extended validation: reject whitespace-only and meta-only changes
    const baseBranch = getBaseBranch();
    const diffStatResult = gitRunWithOutput(["diff", `${baseBranch}...HEAD`, "--stat"], WORKSPACE);
    const diffContentResult = gitRunWithOutput(["diff", `${baseBranch}...HEAD`], WORKSPACE);
    const diffValidation = validateDiffBeforePush(
      diffStatResult.ok ? diffStatResult.stdout : "",
      diffContentResult.ok ? diffContentResult.stdout : "",
    );
    if (!diffValidation.valid) {
      lastPipelineExitCode = diffValidation.exitCode;
      runLogger.logError(`Pre-push validation failed (${diffValidation.reason}): ${diffValidation.stats.filesChanged} files, ${diffValidation.stats.insertions} insertions, ${diffValidation.stats.deletions} deletions`);
      runLogger.endRun(diffValidation.exitCode);
      trackStep(run.id, "tool_call", `Pre-push validation failed: ${diffValidation.reason}`, { toolName: "validate_diff", success: false });
      failRunTrack(run.id, `Pre-push validation failed: ${diffValidation.reason}`);
      return null;
    }
    runLogger.logWork(`Diff validation passed: ${diffValidation.stats.filesChanged} files, ${diffValidation.stats.insertions} insertions, ${diffValidation.stats.deletions} deletions`);
  }

  // Checkpoint: changes committed
  saveRunState({ ...currentState, checkpoint: "changes_committed" });

  // TDD: Run unit tests first (fast fail)
  // If the agent already ran tests during its session, skip the manual test gate
  // as it would be redundant — the agent's test run is sufficient.
  if (SKIP_TESTS) {
    runLogger.logConfig("Skipping all tests and coverage checks (--skip-tests)");
  } else if (agentRanTests) {
    runLogger.logConfig("Agent already ran tests during its session — skipping manual test gate");
  } else {
    const unitResult = runTestSuite("unit");
    if (unitResult.kind === "spawn_error") {
      runLogger.logConfig("Unit tests could not start — proceeding without test verification");
    } else if (!unitResult.passed) {
      runLogger.logError(`Unit tests ${unitResult.kind} — skipping integration tests and push. Issue will be retried.`);
      lastPipelineExitCode = EXIT_TEST_FAILURE;
      runLogger.endRun(EXIT_TEST_FAILURE);
      // Don't save to processedIssues — allow retry on next aicoder cycle
      trackStep(run.id, "tool_call", `Unit tests ${unitResult.kind}`, { toolName: "test_unit", success: false, errorMessage: unitResult.kind });
      failRunTrack(run.id, `Unit tests ${unitResult.kind}`);
      return null;
    }
    trackStep(run.id, "tool_call", "Unit tests passed", { toolName: "test_unit" });

    // TDD: Run integration tests (only if unit tests passed)
    const integrationResult = runTestSuite("integration");
    if (integrationResult.kind === "spawn_error") {
      runLogger.logConfig("Integration tests could not start — skipping");
    } else if (!integrationResult.passed) {
      runLogger.logError(`Integration tests ${integrationResult.kind} — skipping push. Issue will be retried.`);
      lastPipelineExitCode = EXIT_TEST_FAILURE;
      runLogger.endRun(EXIT_TEST_FAILURE);
      // Don't save to processedIssues — allow retry on next aicoder cycle
      trackStep(run.id, "tool_call", `Integration tests ${integrationResult.kind}`, { toolName: "test_integration", success: false, errorMessage: integrationResult.kind });
      failRunTrack(run.id, `Integration tests ${integrationResult.kind}`);
      return null;
    }
    trackStep(run.id, "tool_call", "Integration tests passed", { toolName: "test_integration" });

    // TDD: Check coverage thresholds — use the LLM to fix gaps.
    const coverageResult = checkCoverage();
    if (!coverageResult.passed) {
      if (coverageResult.kind === "spawn_error") {
        runLogger.logConfig(`Coverage tool not available — skipping coverage check`);
      } else {
        await fixCoverageGap(item, coverageResult.output || "coverage check failed");
      }
    }
  }

  // Checkpoint: tests passed
  saveRunState({ ...currentState, checkpoint: "tests_passed" });

  if (!pushBranch(branchName)) {
    // Non-force push may fail if remote has commits from a previous rework
    // Attempt rebase on top of remote and retry
    runLogger.logGit(`Push rejected — rebasing on remote and retrying`);
    if (gitRun(["pull", "--rebase", "origin", branchName], WORKSPACE)) {
      if (pushBranch(branchName)) {
        trackStep(run.id, "tool_call", `Pushed branch after rebase: ${branchName}`, { toolName: "git_push" });
      } else {
        runLogger.logError(`Push failed after rebase — PR not created`);
        lastPipelineExitCode = EXIT_GIT_FAILURE;
        runLogger.endRun(EXIT_GIT_FAILURE);
        trackStep(run.id, "tool_call", "Push failed after rebase", { toolName: "git_push", success: false });
        failRunTrack(run.id, "Push failed after rebase");
        return null;
      }
    } else {
      // Rebase failed — stale commits from a previous run are on the remote branch.
      // The aicoder owns ai/issue-* branches exclusively, so force push is safe.
      runLogger.logGit(`Rebase failed — aborting and force pushing to replace stale remote branch`);
      gitRun(["rebase", "--abort"], WORKSPACE);
      if (pushBranch(branchName, { forceWithLease: true })) {
        trackStep(run.id, "tool_call", `Force pushed branch after rebase failure: ${branchName}`, { toolName: "git_push" });
      } else {
        runLogger.logError(`Force push failed after rebase failure — PR not created`);
        lastPipelineExitCode = EXIT_GIT_FAILURE;
        runLogger.endRun(EXIT_GIT_FAILURE);
        trackStep(run.id, "tool_call", "Force push failed after rebase failure", { toolName: "git_push", success: false });
        failRunTrack(run.id, "Force push failed after rebase failure");
        return null;
      }
    }
  }
  trackStep(run.id, "tool_call", `Pushed branch: ${branchName}`, { toolName: "git_push" });

  // Checkpoint: branch pushed
  saveRunState({ ...currentState, checkpoint: "branch_pushed" });

  const pr = await createPR(cfg, item, branchName);
  if (pr) {
    const platform = detectRemotePlatform(WORKSPACE);
    const label = platform === "gitlab" ? "MR" : "PR";
    runLogger.logPR(`Opened ${label} #${pr.prNumber}: ${pr.url}`);
    trackStep(run.id, "tool_call", `Created PR #${pr.prNumber}: ${pr.url}`, { toolName: "create_pr" });
    await notifyComplete(cfg, item, pr.prNumber, branchName, exitCode);

    // Checkpoint: PR created
    currentState = { ...currentState, checkpoint: "pr_created", prNumber: pr.prNumber };
    saveRunState(currentState);
  }

  const totalDuration = Date.now() - startTime;
  completeRunTrack(run.id, { model: MODEL, toolLoopCount: getStepOrder(), totalTokens: 0 });
  trackStep(run.id, "note", `Completed in ${(totalDuration / 1000).toFixed(1)}s${pr ? ` — PR #${pr.prNumber}` : ""}`);
  if (pr) lastPipelineExitCode = EXIT_SUCCESS;
  runLogger.endRun(pr ? EXIT_SUCCESS : exitCode);
  // Only mark as processed if PR/MR was successfully created
  if (pr) {
    saveProcessedIssue(issueKey);
    agentRunDatabase.clearFailedAttempt(issueKey, WORKSPACE); // Clear failure counter on success
    clearProcessFailures(issueKey); // Reset the process-local circuit on success
    try {
      const changedFiles = getChangedFiles(getBaseBranch(), "HEAD");
      conversationManager.saveMemory("aicoder", `[AI] ${item.title}`, `Completed issue ${issueKey}: created PR/MR #${pr.prNumber}. Files changed: ${changedFiles.join(", ") || "none"}.`, [issueKey, ...changedFiles.slice(0, 5)]);
    } catch {
      // Memory writeback is best-effort
    }
  } else {
    runLogger.logError("PR/MR creation failed — not marking issue as processed so it can be retried");
  }
  return pr ? { prNumber: pr.prNumber } : null;
}

// ─── Session resumption ──────────────────────────────────────────────────────
// Resumes an interrupted aicoder run from the last saved checkpoint.
// Each checkpoint maps to a pipeline stage; resume picks up from that point.

// resumeFromCheckpoint + the 11 continueFromXxx step helpers moved to
// src/aicoder/checkpoint-resumers.ts. Below is the deps factory that
// captures the local workspace/runtime singletons and the thin wrapper.
function checkpointResumerDeps(): CheckpointResumerDeps {
  return {
    logger: runLogger,
    workspace: WORKSPACE,
    agent: AGENT,
    skipTests: SKIP_TESTS,
    enableBaseline: ENABLE_BASELINE,
    ensureCleanWorkspace,
    forceCheckout,
    stageAndCommit,
    pushBranch,
    gitRun,
    fixBaselineTests,
    fixCoverageGap,
    runTestSuite,
    checkCoverage,
    runAgent: (prompt, resumeId) =>
      runAgent(prompt, resumeId) as Promise<{
        finDetected: boolean;
        exitCode: number | null;
        sessionId?: string;
        ranTests?: boolean;
        stderr?: string;
      }>,
    generatePrompt,
    buildAgentPrompt: (prompt, item) => buildAgentPrompt(prompt, item),
    createPR,
    detectRemotePlatform,
    runReviewLoop,
    saveRunState,
    loadRunState,
    clearRunState,
    processedIssuesDelete: (issueKey) => processedIssues.delete(issueKey),
    unmarkIssueProcessedInDb: (issueKey) =>
      agentRunDatabase.unmarkIssueProcessed(issueKey),
    isAgentInfrastructureFailure,
    escalateAgentInfrastructureFailure,
    recordProcessFailure,
  };
}
async function resumeFromCheckpoint(state: RunState): Promise<void> {
  return _resumeFromCheckpoint(checkpointResumerDeps(), state);
}


// focusedLoop moved to src/aicoder/run-modes.ts
const focusedLoop = (cfg: ServerConfig) =>
  _focusedLoop(runModesDeps(), cfg);

/**
 * Resolves an issue key to the correct source system and fetches it.
 * Uses SourceResolver for smart routing — Jira-style keys (IR-82, PROJ-123)
 * go to Jira, numeric keys go to GitHub, and the resolver's memory/cache
 * is consulted for anything ambiguous.
 */
// ---------------------------------------------------------------------------
// Watch an existing PR/MR for review feedback and rework (no agent run)
// ---------------------------------------------------------------------------
// watchIssue moved to src/aicoder/watch-issue.ts
function watchIssueDeps(): WatchIssueDeps {
  return {
    logger: runLogger,
    workspace: WORKSPACE,
    gitRun,
    gitRunWithOutput: (args, cwd) => _gitRunWithOutput(args, cwd),
    detectRemotePlatform,
    getGitLabProjectFromRemote,
    fetchIssueByKey,
    findExistingGitLabMR,
    clearRunState,
    runReviewLoop,
  };
}
const watchIssue = (cfg: ServerConfig, issueKey: string) =>
  _watchIssue(watchIssueDeps(), cfg, issueKey);

async function fetchIssueByKey(cfg: ServerConfig, key: string): Promise<WorkItem | null> {
  const resolver = new SourceResolver(WORKSPACE, LOOKUP, cfg.apiUrl, cfg.apiKey);

  // If --source is explicitly set (not "auto"), trust it; otherwise resolve
  const source = cfg.source !== "auto"
    ? (cfg.source as TicketSourceType)
    : await resolver.resolve(key, "");

  runLogger.logConfig(`Resolved issue ${key} → source: ${source}`);

  if (source === "jira") {
    return fetchJiraIssueDirectly(key);
  }

  // Default: treat as a numeric GitHub issue number
  const num = parseInt(key, 10);
  if (Number.isNaN(num)) {
    runLogger.logError(`Issue key "${key}" resolved to GitHub but is not a number. Use --source jira for Jira keys.`);
    return null;
  }
  return fetchIssueDirectly(cfg, num);
}

// fetchWorkItemDirectly moved to src/aicoder/work-items.ts.
// generatePromptFromWorkItem is called from src/aicoder/work-source.ts only
// (the local aicoder.ts code path goes through generatePrompt now).
const fetchWorkItemDirectly = (cfg: ServerConfig, workItemId: string) =>
  _fetchWorkItemDirectly(runLogger, cfg, workItemId);

// fetchJiraIssueDirectly moved to src/aicoder/jira-deps.ts
const fetchJiraIssueDirectly = (key: string) =>
  _fetchJiraIssueDirectly(jiraClient, runLogger, key);

// fetchIssueDirectly moved to src/aicoder/github-helpers.ts
const fetchIssueDirectly = (cfg: ServerConfig, issueNumber: number) =>
  _fetchIssueDirectly(runLogger, cfg, issueNumber);

// focusedProcessWorkItem + focusedProcessWorkItemInner moved to
// src/aicoder/run-modes.ts

/**
 * After an MR/PR is merged, close the originating issue on the source platform.
 * Jira: transition to Done + post completion comment.
 * GitLab/GitHub: close the issue + post completion comment.
 * Failures are non-fatal — logged but do not abort the run.
 */

// runReviewLoop moved to src/aicoder/review-loop.ts
function reviewLoopDeps(): ReviewLoopDeps {
  return {
    logger: runLogger,
    workspace: WORKSPACE,
    gitlabReviewClient: gitlabClient,
    gitlabReworkClient: gitlabClient,
    jiraClient,
    reviewPollMs: REVIEW_POLL_MS,
    maxRework: MAX_REWORK,
    autorepairDisabled: AUTOREPAIR_DISABLED,
    exits: {
      reviewFailed: EXIT_REVIEW_FAILED,
      maxRework: EXIT_MAX_REWORK,
      noChanges: EXIT_NO_CHANGES,
    },
    runAgent: (prompt) => runAgent(prompt) as Promise<{ finDetected: boolean; exitCode: number | null; sessionId?: string }>,
    buildAgentPrompt: (prompt, item) => buildAgentPrompt(prompt, item),
    forceCheckout,
    stageAndCommit,
    pushBranch,
    rebaseAndResolveConflicts,
    fixReworkTests,
    getBaseBranch,
    saveRunState,
    loadRunState,
    clearRunState,
    saveProcessedIssue,
    setLastPipelineExitCode: (code) => { lastPipelineExitCode = code; },
  };
}
const runReviewLoop = (
  cfg: ServerConfig,
  item: WorkItem,
  ghToken: string | undefined,
  owner: string,
  repo: string,
  prNumber: number,
) => _runReviewLoop(reviewLoopDeps(), cfg, item, ghToken, owner, repo, prNumber);

// pollLoop moved to src/aicoder/run-modes.ts
const pollLoop = (cfg: ServerConfig) => _pollLoop(runModesDeps(), cfg);

function runModesDeps(): RunModesDeps {
  return {
    logger: runLogger,
    workspace: WORKSPACE,
    agent: AGENT,
    useOllama: USE_OLLAMA,
    debug: DEBUG,
    targetIssueKey: TARGET_ISSUE_KEY,
    label: LABEL,
    source: SOURCE,
    priority: PRIORITY,
    lookup: LOOKUP,
    sprint: SPRINT,
    maxCycles: MAX_CYCLES,
    pollMs: POLL_MS,
    skipPoll: SKIP_POLL,
    reviewPollMs: REVIEW_POLL_MS,
    getBaseBranch,
    fetchIssueByKey,
    fetchWork,
    expandWithDependencies,
    prioritizeItems,
    processWorkItem,
    ensureCleanWorkspace,
    detectRemotePlatform,
    runReviewLoop,
    depBlockedThisCycle,
    getLastPipelineExitCode: () => lastPipelineExitCode,
  };
}

function cleanup() {
  if (activeChild && !activeChild.killed) {
    activeChild.kill("SIGTERM");
  }
}

process.on("SIGINT", () => { cleanup(); ensureCleanWorkspace(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); ensureCleanWorkspace(); process.exit(143); });

/**
 * Ensure `nul` is in .gitignore for the workspace.
 * On Windows, `nul` is a reserved device name — if it exists as a file,
 * `git add --all` fails. Adding it to .gitignore prevents this.
 * Commits the change immediately so it doesn't block branch switches.
 */
function ensureNulInGitignore(workspace: string): void {
  // Kept for backward compatibility — now delegates to ensureGitignoreEntries
  ensureGitignoreEntries(workspace, ["nul", "*.log.bak", ".aicoder/"]);
}

function ensureGitignoreEntries(workspace: string, entries: string[]): void {
  const gitignorePath = path.join(workspace, ".gitignore");
  try {
    let content = "";
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, "utf-8");
    }
    const lines = content.split(/\r?\n/);
    const missing = entries.filter(e => !lines.some(line => line.trim() === e));
    if (missing.length > 0) {
      const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
      const addition = missing.join("\n") + "\n";
      fs.writeFileSync(gitignorePath, content + separator + addition, "utf-8");
      runLogger.logConfig(`Added ${missing.join(", ")} to .gitignore`);
      // Commit the .gitignore change so it doesn't block later branch switches
      gitRun(["add", ".gitignore"], workspace);
      gitRun(["commit", "-m", `[AI] update .gitignore: add ${missing.join(", ")}`], workspace);
    }
  } catch (err) {
    runLogger.logError(`Failed to update .gitignore: ${(err as Error).message}`);
  }
}
ensureNulInGitignore(WORKSPACE);

// Recover from any mid-rebase state left by a previous run BEFORE modifying git state
ensureCleanWorkspace();

// Ensure temp/build directories that commonly block git operations are also ignored
ensureGitignoreEntries(WORKSPACE, [
  ".build-tmp/",
  ".pip-tmp/",
  ".pytest_tmp/",
  "packaging-test-*/",
  "*.egg-info/",
]);

loadProcessedIssues();

// Mark any stale aicoder runs (from a previous crash) as failed
try {
  if (agentRunsClient) {
    agentRunsClient.markStaleRunsAsFailed().then((stale) => {
      if (stale > 0) runLogger.logConfig(`Marked ${stale} stale agent run(s) as failed (via API)`);
    }).catch(() => {});
  } else {
    const stale = agentRunDatabase.markStaleRunsAsFailed();
    if (stale > 0) {
      runLogger.logConfig(`Marked ${stale} stale agent run(s) as failed`);
    }
  }
} catch {
  // Non-fatal
}

// --cleanup-merged: one-shot sweep — delete every local ai/* branch already
// merged into origin/<base> and exit.  Runs before any other mode dispatch.
if (CLEANUP_MERGED) {
  const base = getBaseBranch();
  runLogger.logConfig(`Cleaning up merged ai/* branches against origin/${base}`);
  const sweep = cleanupAllMergedBranches(WORKSPACE, base, runLogger);
  runLogger.logConfig(
    `Cleanup complete — deleted ${sweep.cleaned.length}, skipped ${sweep.skipped.length}`,
  );
  if (sweep.cleaned.length) {
    runLogger.logConfig(`Deleted: ${sweep.cleaned.join(", ")}`);
  }
  for (const s of sweep.skipped) {
    runLogger.logConfig(`  skipped ${s.branch}: ${s.reason}`);
  }
  process.exit(EXIT_SUCCESS);
}

// --autorepair-status / --autorepair-release / --autorepair-clear:
// inspect or manipulate the autorepair gate for an issue and exit.
if (AUTOREPAIR_STATUS_KEY) {
  const status = getAutorepairStatus(AUTOREPAIR_STATUS_KEY);
  console.log(JSON.stringify(status, null, 2));
  process.exit(EXIT_SUCCESS);
}
if (AUTOREPAIR_RELEASE_KEY) {
  const rec = forceReleaseAutorepair(AUTOREPAIR_RELEASE_KEY, "manual --autorepair-release");
  console.log(`Released autorepair gate for ${AUTOREPAIR_RELEASE_KEY}. New state: ${rec.state}`);
  process.exit(EXIT_SUCCESS);
}
if (AUTOREPAIR_CLEAR_KEY) {
  clearAutorepairGate(AUTOREPAIR_CLEAR_KEY);
  console.log(`Cleared autorepair gate file for ${AUTOREPAIR_CLEAR_KEY}.`);
  process.exit(EXIT_SUCCESS);
}

// --discard-run: clear any saved run state and start fresh
if (DISCARD_RUN) {
  clearRunState();
  runLogger.logConfig("Discarded saved run state (--discard-run)");
}

// Check for interrupted run state and resume if appropriate
// Skip auto-resume when --watch or --publish is specified — these are explicit one-shot commands
const existingRunState = findExistingRunState();
if (existingRunState && !DISCARD_RUN && !WATCH_ISSUE && !PUBLISH_BRANCH) {
  const stateAge = Date.now() - new Date(existingRunState.updatedAt).getTime();
  const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

  if (stateAge > STALE_MS && !RESUME_RUN) {
    runLogger.logConfig(`Found stale run state (older than 24h) for issue ${existingRunState.issueKey} — clearing`);
    clearRunState(existingRunState.issueKey);
  } else {
    runLogger.logConfig(`Found interrupted run for issue ${existingRunState.issueKey} at checkpoint '${existingRunState.checkpoint}'`);
    runLogger.logConfig("Resuming from saved state...");
    resumeFromCheckpoint(existingRunState)
      .then(() => {
        clearRunState(existingRunState.issueKey);
        process.exit(lastPipelineExitCode);
      })
      .catch((err) => {
        console.error("Resume failed:", err);
        clearRunState(existingRunState.issueKey);
        process.exit(1);
      });
    // Do not fall through to focusedLoop/pollLoop — resume handles everything and exits
  }
}

// Only enter normal operating modes if we're not resuming from a checkpoint
if (!existingRunState || DISCARD_RUN || WATCH_ISSUE || PUBLISH_BRANCH) {
  // --watch: Enter the review loop for an existing PR/MR without running the agent
  if (WATCH_ISSUE) {
    // Clear any saved run state — watch is explicit control, don't auto-resume
    if (existingRunState) {
      runLogger.logConfig("Clearing saved run state (--watch takes priority over auto-resume)");
      clearRunState(existingRunState.issueKey);    }
    watchIssue(loadServerConfig(), WATCH_ISSUE)
      .then(() => process.exit(lastPipelineExitCode))
      .catch((err) => {
        console.error("Watch failed:", err);
        process.exit(1);
      });
  } else if (PUBLISH_BRANCH) {
    publishBranch(loadServerConfig(), PUBLISH_BRANCH)
      .then(() => process.exit(EXIT_SUCCESS))
      .catch((err) => {
        console.error("Publish failed:", err);
        process.exit(1);
      });
  } else if (FOCUSED_MODE) {
    focusedLoop(loadServerConfig());
  } else {
    pollLoop(loadServerConfig());
  }
}
