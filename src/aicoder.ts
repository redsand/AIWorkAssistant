#!/usr/bin/env tsx
import "dotenv/config";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import axios from "axios";
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
  TestSuiteKind, PipelineCheckpoint, RunState,
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
  cleanupMergedBranch,
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
import {
  pollForReviewResult as _pollForReviewResult,
  pollForGitLabReviewResult as _pollForGitLabReviewResult,
} from "./aicoder/review-polling";
import {
  fetchReworkPrompt,
  fetchGitLabReworkPrompt as _fetchGitLabReworkPrompt,
} from "./aicoder/rework-prompts";
import {
  isPromptStrategy,
  normalizeSemanticSeverity,
  normalizeSemanticCategory,
  extractFilesFromText,
} from "./aicoder/semantic-helpers";
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
import {
  recordRoundFindings,
  checkConvergence,
  formatConvergenceReport,
  createConvergencePromptDecision,
  DEFAULT_CONVERGENCE_CONFIG,
  type ConvergenceConfig,
  type ConvergenceState,
} from "./autonomous-loop/convergence";
import {
  detectFailurePatterns,
  generatePrompt as generateStrategyPrompt,
  selectStrategy,
  type PromptContext,
  type PromptStrategy,
} from "./autonomous-loop/prompt-strategies";
import type { SemanticFinding } from "./autonomous-loop/semantic-review";
import { loadConvergenceState, saveConvergenceState, serializeConvergence } from "./autonomous-loop/convergence-state";
import { loadReviewGateState, saveReviewGateState, clearReviewGateState, markForceDone } from "./autonomous-loop/review-gate-state";
import { ensureAgentsMdRules } from "./autonomous-loop/agents-md";
// hashUuidToNumber / parseWorkItemTagsJson / extractCodingPromptSection are
// now used inside src/aicoder/work-items.ts after the work-items extraction.
import {
  runAutorepair,
  getAutorepairStatus,
  forceReleaseAutorepair,
  clearAutorepairGate,
  isGatePaused as _isAutorepairPaused,
  isGateEscalated as _isAutorepairEscalated,
} from "./autonomous-loop/ticket-autorepair";
import type { TicketIdentifier } from "./autonomous-loop/ticket-autorepair/source-updater";

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
async function publishBranch(cfg: ServerConfig, branchName: string): Promise<void> {
  runLogger.logWork(`Publishing branch: ${branchName}`);

  // 1. Ensure we're on the right branch
  const currentBranchResult = gitRunWithOutput(["rev-parse", "--abbrev-ref", "HEAD"], WORKSPACE);
  const currentBranch = currentBranchResult.ok ? currentBranchResult.stdout.trim() : "";
  if (currentBranch !== branchName) {
    runLogger.logGit(`Switching to branch: ${branchName}`);
    if (!gitRun(["checkout", branchName], WORKSPACE)) {
      runLogger.logError(`Cannot checkout branch ${branchName} — does it exist?`);
      process.exit(1);
    }
  }

  // 2. Validate diff before push — reject empty, whitespace-only, or meta-only changes
  const baseBranch = getBaseBranch();
  const diffStatResult = gitRunWithOutput(["diff", `${baseBranch}...HEAD`, "--stat"], WORKSPACE);
  const diffContentResult = gitRunWithOutput(["diff", `${baseBranch}...HEAD`], WORKSPACE);

  const diffValidation = validateDiffBeforePush(
    diffStatResult.ok ? diffStatResult.stdout : "",
    diffContentResult.ok ? diffContentResult.stdout : "",
  );

  if (!diffValidation.valid) {
    runLogger.logError(`Pre-push validation failed (${diffValidation.reason}): ${diffValidation.stats.filesChanged} files, ${diffValidation.stats.insertions} insertions, ${diffValidation.stats.deletions} deletions`);
    runLogger.logError(`Exit code ${diffValidation.exitCode} — PR will not be created`);
    runLogger.endRun(diffValidation.exitCode);
    process.exit(diffValidation.exitCode);
  }

  runLogger.logWork(`Diff validation passed: ${diffValidation.stats.filesChanged} files, ${diffValidation.stats.insertions} insertions, ${diffValidation.stats.deletions} deletions`);

  // --dry-run-push: show what would be pushed without actually pushing
  if (DRY_RUN_PUSH) {
    runLogger.logConfig("Dry-run mode — skipping push and PR creation");
    console.log("\n=== DRY RUN: Diff Summary ===");
    console.log(`Base branch: ${baseBranch}`);
    console.log(`Feature branch: ${branchName}`);
    console.log(`Files changed: ${diffValidation.stats.filesChanged}`);
    console.log(`Insertions: ${diffValidation.stats.insertions}`);
    console.log(`Deletions: ${diffValidation.stats.deletions}`);
    if (diffStatResult.ok) {
      console.log("\n--- Diff Stat ---");
      console.log(diffStatResult.stdout.trim());
    }
    console.log("\n=== END DRY RUN ===");
    runLogger.endRun(EXIT_SUCCESS);
    process.exit(EXIT_SUCCESS);
  }

  // 3. Force-push branch to origin — AI branches are always authoritative
  if (!pushBranch(branchName, { forceWithLease: true })) {
    runLogger.logError(`Cannot push branch ${branchName} to origin`);
    process.exit(1);
  }

  // 4. Resolve issue key: --issue flag overrides branch-name extraction
  let issueKey: string | null = TARGET_ISSUE_KEY || extractIssueKeyFromBranchName(branchName);

  // If only a bare number was extracted and source is Jira, try to reconstruct
  // the full key (e.g. "110" → "IR-110") using the JIRA_PROJECT env var
  if (issueKey && /^\d+$/.test(issueKey) && SOURCE === "jira") {
    const project = process.env.JIRA_PROJECT || process.env.JIRA_DEFAULT_PROJECT || "";
    if (project) {
      issueKey = `${project.toUpperCase()}-${issueKey}`;
      runLogger.logWork(`Reconstructed Jira key: ${issueKey}`);
    }
  }

  if (!issueKey) {
    runLogger.logError(`Cannot extract issue key from branch name: ${branchName}`);
    runLogger.logError("Pass --issue IR-110 to specify it explicitly.");
    process.exit(1);
  }
  runLogger.logWork(`Extracted issue key: ${issueKey}`);

  // 5. Look up the issue
  const isWorkItemId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issueKey);
  const isJira = /^[A-Z]+-\d+$/.test(issueKey);
  let item: WorkItem | null = null;

  if (isWorkItemId) {
    item = await fetchWorkItemDirectly(cfg, issueKey);
  } else if (isJira) {
    item = await fetchJiraIssueDirectly(issueKey);
  } else {
    const num = parseInt(issueKey, 10);
    if (!isNaN(num)) {
      item = await fetchIssueDirectly(cfg, num);
    }
  }

  if (!item) {
    runLogger.logError(`Cannot find issue ${issueKey} — check --source flag and credentials`);
    process.exit(1);
  }

  runLogger.logWork(`Found issue: ${item.id} — ${item.title}`);

  // 5. Build enriched description
  let description = "";

  // Closes line for auto-merge
  if (item.url) {
    description += `Closes ${item.url}\n\n`;
  }

  // Issue key for reviewer routing
  description += `Issue: ${item.id}\n\n`;

  // Issue description for reviewer context
  if (isWorkItemId) {
    if (item.body) {
      description += `## Description\n\n${truncate(item.body, 2000)}\n\n`;
    }
  } else if (isJira && jiraClient.isConfigured()) {
    try {
      const jiraIssue = await jiraClient.getIssue(item.id);
      const fields = jiraIssue.fields as typeof jiraIssue.fields & { description?: any };
      // Jira description can be rich text (Atlassian Document Format) or plain string
      const desc = fields.description;
      if (desc) {
        const descText = typeof desc === "string"
          ? desc
          : Array.isArray(desc?.content)
            ? desc.content.map((block: any) => block.text || "").filter(Boolean).join("\n")
            : "";
        if (descText) {
          description += `## Description\n\n${truncate(descText, 2000)}\n\n`;
        }
      }
    } catch {
      // Non-fatal: description enrichment is best-effort
    }
  }

  description += "_Generated by AiRemoteCoder autonomous agent._";

  // 6. Create PR/MR
  const platform = detectRemotePlatform(WORKSPACE);
  runLogger.logGit(`Detected remote platform: ${platform}`);

  if (platform === "gitlab") {
    // Derive project path from git remote — more reliable than Jira project key
    const gitlabProject = getGitLabProjectFromRemote(WORKSPACE) || process.env.GITLAB_DEFAULT_PROJECT || cfg.repo || item.repo;
    try {
      const resp = await axios.post<{ success: boolean; mrIid?: number; url?: string; error?: string }>(
        `${cfg.apiUrl}/api/autonomous-loop/mr`,
        {
          project: gitlabProject,
          title: `[AI] ${item.title}`,
          sourceBranch: branchName,
          targetBranch: getBaseBranch(),
          description,
          removeSourceBranch: true,
        },
        { headers: authHeaders(cfg) },
      );
      if (resp.data.success) {
        const mrUrl = resp.data.url ?? "";
        runLogger.logPR(`Created MR !${resp.data.mrIid ?? ""}: ${mrUrl}`);
      } else {
        const errMsg = resp.data.error ?? "unknown error";
        if (/already exists/i.test(errMsg)) {
          runLogger.logWork(`MR already exists for this branch — branch pushed successfully, reviewer will pick it up`);
        } else {
          runLogger.logError(`GitLab MR creation failed: ${errMsg}`);
          process.exit(1);
        }
      }
    } catch (err) {
      runLogger.logError(`GitLab MR creation failed: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    // GitHub PR
    try {
      const resp = await axios.post<{ success: boolean; prNumber: number; url: string; error?: string }>(
        `${cfg.apiUrl}/api/autonomous-loop/pr`,
        {
          owner: item.owner || cfg.owner,
          repo: item.repo || cfg.repo,
          title: `[AI] ${item.title}`,
          head: branchName,
          base: "main",
          body: description,
          issueNumber: item.number,
        },
        { headers: authHeaders(cfg) },
      );
      if (resp.data.success) {
        runLogger.logPR(`Created PR #${resp.data.prNumber}: ${resp.data.url}`);
      } else {
        runLogger.logError(`GitHub PR creation failed: ${resp.data.error || "unknown error"}`);
        process.exit(1);
      }
    } catch (err) {
      runLogger.logError(`GitHub PR creation failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  runLogger.logWork("Publish complete");
}




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
function ensureCleanWorkspace(): boolean {
  // 1. Recover from mid-rebase
  if (isRebaseInProgress(WORKSPACE)) {
    runLogger.logGit("WARN", "Mid-rebase state detected during workspace cleanup");
    if (!recoverFromRebase(WORKSPACE)) {
      runLogger.logError("Could not recover from mid-rebase state");
      return false;
    }
  }

  // 2. Check for unmerged paths
  const statusResult = spawnSync("git", ["status", "--porcelain"], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  if (statusResult.status === 0) {
    const unmerged = statusResult.stdout.trim().split("\n")
      .filter(line => /^(DD|AU|UD|UA|DU|UU|AA)/.test(line))
      .map(line => line.slice(3).trim())
      .filter(Boolean);

    if (unmerged.length > 0) {
      runLogger.logGit("WARN", `Found ${unmerged.length} unmerged path(s) — resolving`);
      for (const file of unmerged) {
        // Accept whatever is in the working tree (likely partial resolution)
        if (!gitRun(["add", "--", file], WORKSPACE)) {
          // If add fails, the file may have been deleted — remove from index
          gitRun(["rm", "--", file], WORKSPACE);
        }
      }
      // Commit the resolution
      stageAndCommit("[AI] auto-resolved unmerged paths");
    }
  }

  // 3. Commit any dirty working tree changes
  const dirtyResult = spawnSync("git", ["diff", "--quiet"], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  const hasUncommittedChanges = dirtyResult.status !== 0;

  const cachedResult = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  const hasStagedChanges = cachedResult.status !== 0;

  if (hasUncommittedChanges || hasStagedChanges) {
    const stat = gitRunWithOutput(["diff", "--stat"], WORKSPACE);
    runLogger.logGit("WARN", `Preserving dirty workspace in git stash during cleanup${stat.ok && stat.stdout.trim() ? `: ${summarizeDiffStat(stat.stdout)}` : ""}`);
    if (!gitRun(["stash", "push", "--include-untracked", "-m", "[AI] auto-cleanup: pending changes preserved"], WORKSPACE)) {
      runLogger.logError("Could not preserve dirty workspace in stash during cleanup");
      return false;
    }
  }

  // 4. Check for detached HEAD
  const branch = getCurrentBranch();
  if (branch === "HEAD" || branch === null || branch.startsWith("(")) {
    runLogger.logGit("WARN", "Detached HEAD detected — switching to base branch");
    forceCheckout(getBaseBranch(), WORKSPACE);
  }

  return true;
}

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


/** Check if a remote branch exists and pull latest commits into the local branch.
 *  Only one aicoder runs per repo, so force-sync is safe — no concurrent push risk. */
function syncRemoteBranch(branchName: string): boolean {
  const result = spawnSync("git", ["ls-remote", "--heads", "origin", branchName], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  if (result.status !== 0 || !result.stdout.trim()) return false;
  runLogger.logGit("Fetching remote branch", branchName);
  if (!gitRun(["fetch", "origin", branchName], WORKSPACE)) return false;
  runLogger.logGit("Resetting to remote", `origin/${branchName}`);
  return gitRun(["reset", "--hard", `origin/${branchName}`], WORKSPACE);
}

async function checkoutBranch(branchName: string, fromBranch?: string): Promise<boolean> {
  // Recover from any stuck rebase state before doing anything
  if (isRebaseInProgress(WORKSPACE)) {
    runLogger.logGit("WARN", "Mid-rebase state detected — recovering");
    if (!recoverFromRebase(WORKSPACE)) {
      runLogger.logError("Could not recover from mid-rebase state");
      return false;
    }
  }

  // Delete stale local branches that were never pushed (left over from prior runs that died early).
  // If the branch exists locally but has no remote tracking ref, it is almost certainly stale.
  const localRef = gitRunWithOutput(["rev-parse", "--verify", `refs/heads/${branchName}`], WORKSPACE);
  if (localRef.ok) {
    const remoteRef = gitRunWithOutput(["rev-parse", "--verify", `refs/remotes/origin/${branchName}`], WORKSPACE);
    if (!remoteRef.ok) {
      runLogger.logGit("Deleting stale local branch (no remote tracking)", branchName);
      gitRun(["branch", "-D", branchName], WORKSPACE);
    }
  }

  // Already on the target branch — stage any pending changes, sync with remote,
  // then rebase onto base
  const current = getCurrentBranch();
  if (current === branchName) {
    runLogger.logGit("Already on branch", branchName);
    // Stage any leftover changes from a prior interrupted run
    stageAndCommit(`[AI] resume: staged pending changes`);
    // Sync with remote branch from prior PR/MR push (only 1 aicoder per repo, no conflicts)
    if (syncRemoteBranch(branchName)) {
      runLogger.logGit("Synced with remote branch", branchName);
    }
    // Pull latest base, then rebase this branch onto it
    if (!pullAndUpdateBase()) {
      runLogger.logGit("WARN", `Could not pull latest ${getBaseBranch()} before rebase`);
    }
    runLogger.logGit("Rebasing onto latest", getBaseBranch());
    if (!forceCheckout(branchName, WORKSPACE)) {
      runLogger.logGit("WARN", `Could not switch back to ${branchName} after pull`);
    }
    gitRun(["rebase", getBaseBranch()], WORKSPACE);
    if (!await resolveRebaseConflictsInPlace(branchName)) {
      return false;
    }
    return true;
  }

  // Stage/commit ALL uncommitted changes before switching branches.
  // This includes .gitignore edits, leftover agent output, etc.
  const dirtyResult = spawnSync("git", ["diff", "--quiet"], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  const hasUncommittedChanges = dirtyResult.status !== 0;

  if (hasUncommittedChanges) {
    runLogger.logGit("Committing uncommitted changes before branch switch", current || "(detached)");
    const saved = stageAndCommit(`[AI] auto-save before switching from ${current || "detached"}`);
    if (!saved) {
      runLogger.logGit("WARN", "Could not save all changes — some files may be left uncommitted");
    }
  }

  // Start from the specified branch or pull latest base
  if (fromBranch) {
    runLogger.logGit("Fetching and checking out base branch", fromBranch);
    if (!gitRun(["fetch", "origin", fromBranch], WORKSPACE)) {
      runLogger.logGit("WARN", `Could not fetch ${fromBranch} — trying local checkout`);
    }
    if (!forceCheckout(fromBranch, WORKSPACE)) {
      runLogger.logError(`Failed to checkout base branch ${fromBranch}`);
      return false;
    }
  } else {
    if (!pullAndUpdateBase()) {
      runLogger.logError(`Could not pull and update base branch — aborting`);
      return false;
    }
  }

  runLogger.logGit("Creating branch", branchName);
  const createResult = gitRunWithOutput(["checkout", "-b", branchName], WORKSPACE);
  if (!createResult.ok) {
    runLogger.logError(`git checkout -b failed: ${createResult.stderr || "unknown error"}`);
    // Branch already exists — checkout, sync with remote, then rebase onto base
    runLogger.logGit("Switching to existing branch", branchName);
    if (!forceCheckout(branchName, WORKSPACE)) {
      // Checkout failed even with force — try stash with untracked files included
      runLogger.logGit("Stashing all changes (including untracked) before checkout");
      gitRun(["stash", "--include-untracked"], WORKSPACE);
      if (!forceCheckout(branchName, WORKSPACE)) {
        runLogger.logError(`Could not checkout branch ${branchName}`);
        safeStashPop(WORKSPACE);
        return false;
      }
      // Sync with remote branch from prior PR/MR push, then stage any changes
      syncRemoteBranch(branchName);
      stageAndCommit(`[AI] resume: staged pending changes on ${branchName}`);
      runLogger.logGit("Rebasing existing branch onto latest", getBaseBranch());
      gitRun(["rebase", getBaseBranch()], WORKSPACE);
      if (!await resolveRebaseConflictsInPlace(branchName)) {
        safeStashPop(WORKSPACE);
        return false;
      }
      safeStashPop(WORKSPACE);
    } else {
      // Successfully checked out — sync with remote, stage any dirty changes, then rebase
      syncRemoteBranch(branchName);
      stageAndCommit(`[AI] resume: staged pending changes on ${branchName}`);
      runLogger.logGit("Rebasing existing branch onto latest", getBaseBranch());
      gitRun(["rebase", getBaseBranch()], WORKSPACE);
      if (!await resolveRebaseConflictsInPlace(branchName)) {
        return false;
      }
    }
  }
  return true;
}

// resolveRebaseConflictsInPlace moved to src/aicoder/rebase-loop.ts
const resolveRebaseConflictsInPlace = (branchName: string) =>
  _resolveRebaseConflictsInPlace(rebaseLoopDeps(), branchName);



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

// --- Review polling --- (logic in src/aicoder/review-polling.ts)
const pollForReviewResult = (
  ghToken: string,
  owner: string,
  repo: string,
  prNumber: number,
  pollMs: number = REVIEW_POLL_MS,
  sinceIso?: string,
) => _pollForReviewResult(ghToken, owner, repo, prNumber, pollMs, sinceIso);

const pollForGitLabReviewResult = (
  projectId: string,
  mrIid: number,
  pollMs: number = REVIEW_POLL_MS,
  sinceIso?: string,
) => _pollForGitLabReviewResult(gitlabClient, projectId, mrIid, pollMs, sinceIso);

// fetchReworkPrompt + fetchGitLabReworkPrompt moved to src/aicoder/rework-prompts.ts
const fetchGitLabReworkPrompt = (
  projectId: string,
  mrIid: number,
  sinceTimestamp?: string,
  issueKey?: string,
) => _fetchGitLabReworkPrompt(gitlabClient, jiraClient, projectId, mrIid, sinceTimestamp, issueKey);





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
  if (infrastructureBlockedIssues.has(issueKey)) {
    runLogger.logSkip(`Issue ${issueKey} has an agent infrastructure failure in this run — skipping to avoid a retry loop`);
    return null;
  }
  // Process-local circuit breaker — fires even with --force, so a tight
  // crash loop can't keep retrying forever in the same PID.
  const circuitReason = checkProcessRetryCircuit(issueKey);
  if (circuitReason) {
    runLogger.logSkip(circuitReason);
    return null;
  }
  if (processedIssues.has(issueKey) && !FORCE_REPROCESS) {
    runLogger.logSkip(`Issue ${issueKey} already processed (use --force to re-process)`);
    return null;
  }

  // Blacklist pre-check: permanently skip issues that failed too many times
  if (!FORCE_REPROCESS && agentRunDatabase.isIssueBlacklisted(issueKey, WORKSPACE)) {
    runLogger.logSkip(`Issue ${issueKey} is blacklisted after repeated failures — skipping (use --force to override)`);
    return null;
  }

  // Convergence pre-check: if a previous run already determined this issue is stuck
  // (no progress across multiple rounds), refuse to re-run even if the reviewer
  // re-added the ready-for-agent label. Use --force to override.
  if (!FORCE_REPROCESS) {
    const existingConvergence = loadConvergenceState(issueKey);
    if (existingConvergence.roundNumber > 0) {
      const convergenceCheck = checkConvergence(existingConvergence, DEFAULT_CONVERGENCE_CONFIG);
      if (convergenceCheck.shouldStop) {
        runLogger.logError(
          `Skipping ${issueKey} — convergence already fired (${convergenceCheck.reason}). ` +
          `Round ${existingConvergence.roundNumber}, no-progress count: ${existingConvergence.noProgressCount}. ` +
          `Use --force to override.`,
        );
        saveProcessedIssue(issueKey);
        return null;
      }
    }
  }

  // Track consecutive failures — after MAX_FAILED_ATTEMPTS, mark as processed to stop the loop
  const attempts = agentRunDatabase.incrementFailedAttempt(issueKey, WORKSPACE);
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    runLogger.logError(`Issue ${issueKey} failed ${attempts} times — blacklisting to stop retry loop`);
    saveProcessedIssue(issueKey);
    agentRunDatabase.blacklistIssue(issueKey, WORKSPACE, `Failed ${attempts} consecutive times`);
    agentRunDatabase.clearFailedAttempt(issueKey, WORKSPACE);
    return null;
  }
  if (FORCE_REPROCESS && processedIssues.has(issueKey)) {
    runLogger.logConfig(`Force re-processing issue ${issueKey} (--force)`);
    processedIssues.delete(issueKey);
    agentRunDatabase.unmarkIssueProcessed(issueKey);
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

  const isJiraIssue = /^[A-Z]+-\d+$/.test(item.id);
  const ghToken = process.env.GITHUB_TOKEN;
  const owner = cfg.owner || process.env.GITHUB_DEFAULT_OWNER || "redsand";
  const repo = cfg.repo || process.env.AICODER_REPO || "";

  // Resolve dependencies before changing source status or starting the agent.
  let fromBranch: string | undefined;
  let depBody = "";
  if (isJiraIssue && jiraClient.isConfigured()) {
    try {
      const jiraIssue = await jiraClient.getIssue(item.id);
      depBody = jiraDescriptionToText(jiraIssue?.fields?.description);
      const comments = await jiraClient.getComments(item.id).catch(() => []);
      depBody = [depBody, ...comments.map((comment) => comment.body)].filter(Boolean).join("\n");
    } catch { /* Jira fetch failed, skip dependency resolution */ }
  } else if (ghToken && repo) {
    depBody = await fetchIssueBody(ghToken, owner, repo, item.number);
  }

  const selfRefs = new Set([
    item.id?.toUpperCase(),
    issueKey.toUpperCase(),
    String(item.number),
  ].filter(Boolean));
  const allDeps = [...new Set(parseDependencies(depBody))]
    .filter((dep) => !selfRefs.has(dep.toUpperCase()));
  if (allDeps.length > 0) {
    runLogger.logGit("Found dependencies", allDeps.join(", "));
    const jiraDeps = allDeps.filter((dep) => /^[A-Z]+-\d+$/.test(dep));
    if (jiraDeps.length > 0 && jiraClient.isConfigured()) {
      const unresolved = await getUnresolvedJiraDependencies(jiraDeps);
      if (unresolved.length > 0) {
        const message = `Blocked by unresolved Jira dependencies: ${unresolved.join(", ")}`;
        runLogger.logSkip(`${issueKey}: ${message}`);
        trackStep(run.id, "note", message);
        runLogger.endRun(null);
        completeRunTrack(run.id, { model: MODEL, toolLoopCount: 0, totalTokens: 0 });
        agentRunDatabase.clearFailedAttempt(issueKey, WORKSPACE); // dep-blocked is not a failure — don't burn retry budget
        depBlockedThisCycle.add(issueKey);
        return null;
      }
    }

    const numericDeps = allDeps.filter((dep) => /^\d+$/.test(dep));
    if (numericDeps.length > 0) {
      const resolved = await resolveDependencyBranch(ghToken || "", owner, repo, numericDeps);
      if (!resolved) {
        agentRunDatabase.clearFailedAttempt(issueKey, WORKSPACE); // dep-blocked is not a failure — don't burn retry budget
        depBlockedThisCycle.add(issueKey);
        if (WAIT_FOR_DEPS) {
          runLogger.logGit("Waiting for dependencies", "will retry later");
          runLogger.endRun(null);
          completeRunTrack(run.id, { model: MODEL, toolLoopCount: 0, totalTokens: 0 });
          return null;
        }
        runLogger.logSkip(`${issueKey}: blocked by unresolved dependencies ${numericDeps.join(", ")}`);
        runLogger.endRun(null);
        completeRunTrack(run.id, { model: MODEL, toolLoopCount: 0, totalTokens: 0 });
        return null;
      }
      fromBranch = resolved.source === "open_pr" ? resolved.branch : undefined;
      runLogger.logGit("Base branch resolved", fromBranch || getBaseBranch());
    }
  }

  // Mark issue as "In Progress" so escalation doesn't pick it up
  if (cfg.source === "work_items") {
    try {
      const currentResp = await axios.get<{ status: string }>(
        `${cfg.apiUrl}/api/work-items/${item.id}`,
        { headers: authHeaders(cfg) },
      );
      if (currentResp.data?.status === "active") {
        runLogger.logWork(`${item.id} already active — keeping status`);
        trackStep(run.id, "note", `${item.id} already active`);
      } else if (currentResp.data?.status === "done" || currentResp.data?.status === "archived") {
        runLogger.logSkip(`${item.id} is already Done/Archived — skipping`);
        saveProcessedIssue(item.id);
        agentRunDatabase.clearFailedAttempt(item.id, WORKSPACE);
        return null;
      } else {
        await axios.patch(
          `${cfg.apiUrl}/api/work-items/${item.id}`,
          { status: "active" },
          { headers: { ...authHeaders(cfg), "Content-Type": "application/json" } },
        );
        runLogger.logWork(`Updated work item ${item.id} status → active`);
        trackStep(run.id, "note", `Work item ${item.id} status set to active`);
      }
    } catch (err) {
      runLogger.logWork(`Could not update work item ${item.id} status: ${err instanceof Error ? err.message : err}`);
      trackStep(run.id, "note", `Work item status update failed: ${err instanceof Error ? err.message : err}`, { success: false });
    }
  } else if (isJiraIssue && jiraClient.isConfigured()) {
    try {
      const currentIssue = await jiraClient.getIssue(item.id);
      const currentStatus = currentIssue.fields.status?.name?.toLowerCase() ?? "";
      const isDone = /done|closed|resolved|completed/i.test(currentStatus);
      if (isDone) {
        runLogger.logSkip(`${item.id} is already Done/Closed at source — skipping (use --force-reopen to override)`);
        saveProcessedIssue(item.id);
        agentRunDatabase.clearFailedAttempt(item.id, WORKSPACE);
        return null;
      }
      if (currentStatus === "in progress") {
        runLogger.logWork(`${item.id} already In Progress — keeping status`);
        trackStep(run.id, "note", `${item.id} already In Progress on Jira`);
      } else {
        const transitions = await jiraClient.getTransitions(item.id);
        const inProgress = transitions.find((t: any) =>
          t.name === "In Progress" || t.name === "in progress" || t.name === "Start Progress"
        );
        if (inProgress) {
          await jiraClient.transitionIssue(item.id, inProgress.id, "AiRemoteCoder started work on this issue.");
          runLogger.logWork(`Transitioned ${item.id} → In Progress`);
          trackStep(run.id, "note", `Transitioned ${item.id} to In Progress`);
        } else {
          runLogger.logWork(`No "In Progress" transition available for ${item.id} (available: ${transitions.map((t: any) => t.name).join(", ")})`);
        }
      }
    } catch (err) {
      runLogger.logWork(`Could not transition ${item.id} to In Progress: ${err instanceof Error ? err.message : err}`);
      trackStep(run.id, "note", `Jira transition failed: ${err instanceof Error ? err.message : err}`, { success: false });
    }
  } else if (cfg.source === "gitlab" && gitlabClient.isConfigured()) {
    try {
      const projectId = getGitLabProjectFromRemote(WORKSPACE) || item.repo || process.env.GITLAB_DEFAULT_PROJECT || "";
      const issueIid = item.number;
      if (projectId && issueIid) {
        const issue = await gitlabClient.getIssue(projectId, issueIid);
        if (issue?.state === "closed") {
          runLogger.logSkip(`${item.id} is already Closed at source — skipping`);
          saveProcessedIssue(item.id);
          agentRunDatabase.clearFailedAttempt(item.id, WORKSPACE);
          return null;
        }
        const rawLabels: string | string[] = issue?.labels || [];
        const labelArray: string[] = typeof rawLabels === "string" ? rawLabels.split(",").map((l: string) => l.trim()) : Array.isArray(rawLabels) ? rawLabels.map((l: any) => (typeof l === "string" ? l.trim() : String(l))) : [];
        if (labelArray.some((l: string) => l.toLowerCase() === "in progress" || l.toLowerCase() === "doing")) {
          runLogger.logWork(`${item.id} already has In Progress label — keeping label`);
          trackStep(run.id, "note", `${item.id} already In Progress on GitLab`);
        } else {
          const newLabels = [...labelArray, "In Progress"].join(",");
          await gitlabClient.editIssue(projectId, issueIid, { labels: newLabels });
          runLogger.logWork(`Added "In Progress" label to GitLab issue #${issueIid}`);
          trackStep(run.id, "note", `GitLab issue #${issueIid} labeled In Progress`);
        }
      }
    } catch (err) {
      runLogger.logWork(`Could not label GitLab issue: ${err instanceof Error ? err.message : err}`);
      trackStep(run.id, "note", `GitLab label failed: ${err instanceof Error ? err.message : err}`, { success: false });
    }
  } else if (cfg.source === "github" && ghToken) {
    try {
      const owner = cfg.owner || process.env.GITHUB_DEFAULT_OWNER || "redsand";
      const repo = cfg.repo || process.env.AICODER_REPO || "";
      if (owner && repo && item.number) {
        const headers = { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" };
        const issueResp = await axios.get(`https://api.github.com/repos/${owner}/${repo}/issues/${item.number}`, { headers });
        if (issueResp.data?.state === "closed") {
          runLogger.logSkip(`${item.id} is already Closed at source — skipping`);
          saveProcessedIssue(item.id);
          agentRunDatabase.clearFailedAttempt(item.id, WORKSPACE);
          return null;
        }
        const currentLabels: string[] = (issueResp.data?.labels || []).map((l: any) => typeof l === "string" ? l : l.name);
        if (currentLabels.some((l: string) => l.toLowerCase() === "in progress")) {
          runLogger.logWork(`${item.id} already has "In Progress" label — keeping label`);
          trackStep(run.id, "note", `${item.id} already In Progress on GitHub`);
        } else {
          await axios.patch(`https://api.github.com/repos/${owner}/${repo}/issues/${item.number}`, {
            labels: [...currentLabels, "In Progress"],
          }, { headers });
          runLogger.logWork(`Added "In Progress" label to GitHub issue #${item.number}`);
          trackStep(run.id, "note", `GitHub issue #${item.number} labeled In Progress`);
        }
      }
    } catch (err) {
      runLogger.logWork(`Could not label GitHub issue: ${err instanceof Error ? err.message : err}`);
      trackStep(run.id, "note", `GitHub label failed: ${err instanceof Error ? err.message : err}`, { success: false });
    }
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

async function resumeFromCheckpoint(state: RunState): Promise<void> {
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

  runLogger.logWork(`Resuming from checkpoint '${state.checkpoint}' for issue ${state.issueKey}`);

  // Remove from processed issues so processWorkItem won't skip it
  processedIssues.delete(state.issueKey);
  agentRunDatabase.unmarkIssueProcessed(state.issueKey);

  // Ensure workspace is clean and on the correct branch
  ensureCleanWorkspace();

  switch (state.checkpoint) {
    case "issue_transitioned":
      // Re-run from branch checkout — issue is already transitioned
      await continueFromBranchCheckout(cfg, item, state);
      break;
    case "branch_checked_out":
      await continueFromBranchCheckout(cfg, item, state);
      break;
    case "baseline_tests_pass":
      await continueFromBaselineTestsPass(cfg, item, state);
      break;
    case "agent_complete":
      await continueFromAgentComplete(cfg, item, state);
      break;
    case "changes_committed":
      await continueFromChangesCommitted(cfg, item, state);
      break;
    case "tests_passed":
      await continueFromTestsPassed(cfg, item, state);
      break;
    case "branch_pushed":
      await continueFromBranchPushed(cfg, item, state);
      break;
    case "pr_created":
    case "review_polling":
    case "rework_pushed":
      await continueFromReviewLoop(cfg, item, state);
      break;
    case "rework_agent_complete":
      await continueFromReworkAgentComplete(cfg, item, state);
      break;
    case "rework_committed":
      await continueFromReworkCommitted(cfg, item, state);
      break;
    case "rework_tests_passed":
      await continueFromReworkTestsPassed(cfg, item, state);
      break;
    default:
      runLogger.logError(`Unknown checkpoint: ${state.checkpoint} — starting fresh`);
      clearRunState(state.issueKey);
  }
}

// Re-run from branch checkout: run baseline tests, agent, test gate, push, PR
async function continueFromBranchCheckout(cfg: ServerConfig, item: WorkItem, state: RunState): Promise<void> {
  if (!forceCheckout(item.suggestedBranch, WORKSPACE)) {
    runLogger.logError(`Cannot checkout branch ${item.suggestedBranch} for resume`);
    clearRunState(state.issueKey);
    return;
  }

  // Baseline tests
  if (ENABLE_BASELINE && !(await fixBaselineTests(cfg, item))) {
    runLogger.logError("Baseline tests could not be fixed on resume — aborting");
    clearRunState(state.issueKey);
    return;
  }
  saveRunState({ ...state, checkpoint: "baseline_tests_pass" });
  await continueFromBaselineTestsPass(cfg, item, state);
}

async function continueFromBaselineTestsPass(cfg: ServerConfig, item: WorkItem, state: RunState): Promise<void> {
  // Run agent (with --resume if we have a session ID)
  const generated = await generatePrompt(cfg, item);
  if (generated.skipped) {
    runLogger.logError(`Cannot generate prompt on resume: ${generated.skipReason}`);
    clearRunState(state.issueKey);
    return;
  }

  const resumeId = state.sessionId && AGENT === "claude" ? state.sessionId : undefined;
  const agentResult = await runAgent(await buildAgentPrompt(generated.prompt, item), resumeId);

  if (!agentResult.finDetected && agentResult.exitCode !== 0) {
    // Resume failed — try fresh if we were resuming
    if (resumeId) {
      runLogger.logWork("Resume session failed — restarting agent from scratch");
      const freshResult = await runAgent(await buildAgentPrompt(generated.prompt, item));
      if (!freshResult.finDetected && freshResult.exitCode !== 0) {
        runLogger.logError(`Agent exited with code ${freshResult.exitCode} on retry — aborting`);
        if (freshResult.stderr) runLogger.logError(`Agent stderr: ${freshResult.stderr.slice(-1000)}`);
        if (isAgentInfrastructureFailure(freshResult.stderr)) {
          await escalateAgentInfrastructureFailure(state.issueKey, freshResult.stderr);
        }
        recordProcessFailure(state.issueKey);
        clearRunState(state.issueKey);
        return;
      }
      saveRunState({ ...state, checkpoint: "agent_complete", sessionId: freshResult.sessionId, agentRanTests: freshResult.ranTests });
    } else {
      runLogger.logError(`Agent exited with code ${agentResult.exitCode} — aborting`);
      if (agentResult.stderr) runLogger.logError(`Agent stderr: ${agentResult.stderr.slice(-1000)}`);
      if (isAgentInfrastructureFailure(agentResult.stderr)) {
        await escalateAgentInfrastructureFailure(state.issueKey, agentResult.stderr);
      }
      recordProcessFailure(state.issueKey);
      clearRunState(state.issueKey);
      return;
    }
  } else {
    saveRunState({ ...state, checkpoint: "agent_complete", sessionId: agentResult.sessionId, agentRanTests: agentResult.ranTests });
  }

  await continueFromAgentComplete(cfg, item, loadRunState(state.issueKey)!);
}

async function continueFromAgentComplete(cfg: ServerConfig, item: WorkItem, state: RunState): Promise<void> {
  forceCheckout(item.suggestedBranch, WORKSPACE);
  if (!stageAndCommit(`[AI] ${item.title}`)) {
    runLogger.logError("Stage/commit failed on resume — aborting");
    clearRunState(state.issueKey);
    return;
  }
  saveRunState({ ...state, checkpoint: "changes_committed" });
  await continueFromChangesCommitted(cfg, item, loadRunState(state.issueKey)!);
}

async function continueFromChangesCommitted(cfg: ServerConfig, item: WorkItem, state: RunState): Promise<void> {
  // Run test gate
  const agentRanTests = state.agentRanTests ?? false;
  if (SKIP_TESTS) {
    runLogger.logConfig("Skipping all tests and coverage checks (--skip-tests)");
  } else if (agentRanTests) {
    runLogger.logConfig("Agent already ran tests — skipping manual test gate");
  } else {
    const unitResult = runTestSuite("unit");
    if (unitResult.kind === "spawn_error") {
      runLogger.logConfig("Unit tests could not start on resume — proceeding without tests");
    } else if (!unitResult.passed) {
      runLogger.logError(`Unit tests ${unitResult.kind} on resume — aborting`);
      clearRunState(state.issueKey);
      return;
    }
    const integrationResult = runTestSuite("integration");
    if (integrationResult.kind === "spawn_error") {
      runLogger.logConfig("Integration tests could not start on resume — skipping");
    } else if (!integrationResult.passed) {
      runLogger.logError(`Integration tests ${integrationResult.kind} on resume — aborting`);
      clearRunState(state.issueKey);
      return;
    }
    const coverageResult = checkCoverage();
    if (!coverageResult.passed && coverageResult.kind !== "spawn_error") {
      await fixCoverageGap(item, coverageResult.output || "coverage check failed");
    }
  }
  saveRunState({ ...state, checkpoint: "tests_passed" });
  await continueFromTestsPassed(cfg, item, loadRunState(state.issueKey)!);
}

async function continueFromTestsPassed(cfg: ServerConfig, item: WorkItem, state: RunState): Promise<void> {
  if (!pushBranch(item.suggestedBranch)) {
    runLogger.logGit(`Push rejected — rebasing on remote and retrying`);
    if (!gitRun(["pull", "--rebase", "origin", item.suggestedBranch], WORKSPACE) || !pushBranch(item.suggestedBranch)) {
      runLogger.logError("Push failed after rebase on resume — aborting");
      clearRunState(state.issueKey);
      return;
    }
  }
  saveRunState({ ...state, checkpoint: "branch_pushed" });
  await continueFromBranchPushed(cfg, item, loadRunState(state.issueKey)!);
}

async function continueFromBranchPushed(cfg: ServerConfig, item: WorkItem, state: RunState): Promise<void> {
  const pr = await createPR(cfg, item, item.suggestedBranch);
  if (pr) {
    const platform = detectRemotePlatform(WORKSPACE);
    const label = platform === "gitlab" ? "MR" : "PR";
    runLogger.logPR(`Opened ${label} #${pr.prNumber}: ${pr.url}`);
    saveRunState({ ...state, checkpoint: "pr_created", prNumber: pr.prNumber });
    await continueFromReviewLoop(cfg, item, loadRunState(state.issueKey)!);
  } else {
    runLogger.logError("PR/MR creation failed on resume — aborting");
    clearRunState(state.issueKey);
  }
}

async function continueFromReviewLoop(cfg: ServerConfig, item: WorkItem, state: RunState): Promise<void> {
  const ghToken = process.env.GITHUB_TOKEN;
  const owner = cfg.owner || process.env.GITHUB_DEFAULT_OWNER || "redsand";
  const repo = cfg.repo || process.env.AICODER_REPO || "";

  if (!state.prNumber) {
    runLogger.logError("Run state has no prNumber — cannot resume review loop");
    clearRunState(state.issueKey);
    return;
  }

  // Enter the review loop directly — no need to re-create the PR
  await runReviewLoop(cfg, item, ghToken, owner, repo, state.prNumber);
}

async function continueFromReworkAgentComplete(cfg: ServerConfig, item: WorkItem, state: RunState): Promise<void> {
  forceCheckout(item.suggestedBranch, WORKSPACE);
  if (!stageAndCommit(`[AI] rework: ${item.title}`)) {
    runLogger.logError("Rework stage/commit failed on resume — aborting");
    clearRunState(state.issueKey);
    return;
  }
  saveRunState({ ...state, checkpoint: "rework_committed" });
  // Continue with test gate and push
  await continueFromReworkCommitted(cfg, item, loadRunState(state.issueKey)!);
}

async function continueFromReworkCommitted(cfg: ServerConfig, item: WorkItem, state: RunState): Promise<void> {
  if (SKIP_TESTS) {
    runLogger.logConfig("Skipping tests on resume (--skip-tests)");
  } else {
    const unitResult = runTestSuite("unit");
    if (!unitResult.passed) {
      runLogger.logError(`Rework unit tests ${unitResult.kind} on resume — aborting`);
      clearRunState(state.issueKey);
      return;
    }
    const integrationResult = runTestSuite("integration");
    if (!integrationResult.passed) {
      runLogger.logError(`Rework integration tests ${integrationResult.kind} on resume — aborting`);
      clearRunState(state.issueKey);
      return;
    }
    const coverageResult = checkCoverage();
    if (!coverageResult.passed && coverageResult.kind !== "spawn_error") {
      await fixCoverageGap(item, coverageResult.output || "coverage check failed");
    }
  }
  saveRunState({ ...state, checkpoint: "rework_tests_passed" });
  await continueFromReworkTestsPassed(cfg, item, loadRunState(state.issueKey)!);
}

async function continueFromReworkTestsPassed(cfg: ServerConfig, item: WorkItem, state: RunState): Promise<void> {
  if (!pushBranch(item.suggestedBranch, { forceWithLease: true })) {
    runLogger.logError("Rework push failed on resume — aborting");
    clearRunState(state.issueKey);
    return;
  }
  const sinceTimestamp = new Date().toISOString();
  const reworkCount = (state.reworkCount ?? 0);
  saveRunState({ ...state, checkpoint: "rework_pushed", sinceTimestamp, reworkCount });
  await continueFromReviewLoop(cfg, item, loadRunState(state.issueKey)!);
}

async function focusedLoop(cfg: ServerConfig): Promise<void> {
  runLogger.logConfig(`AiRemoteCoder started in focused mode (agent: ${AGENT}, workspace: ${WORKSPACE}${USE_OLLAMA ? ", ollama: on" : ""}${DEBUG ? ", debug: on" : ""}, base: ${getBaseBranch()})`);
  const ghToken = process.env.GITHUB_TOKEN;
  const owner = cfg.owner || process.env.GITHUB_DEFAULT_OWNER || "redsand";
  const repo = cfg.repo || process.env.AICODER_REPO || "";

  // --issue <key>: work on a specific issue with review loop
  if (TARGET_ISSUE_KEY) {
    runLogger.logConfig(`Targeting issue ${TARGET_ISSUE_KEY} directly`);
    const target = await fetchIssueByKey(cfg, TARGET_ISSUE_KEY);
    if (!target) {
      runLogger.logError(`Could not find issue ${TARGET_ISSUE_KEY}`);
      process.exit(1);
    }
    await focusedProcessWorkItem(cfg, target, ghToken, owner, repo);
    process.exit(lastPipelineExitCode);
  }

  runLogger.logConfig(`Polling ${cfg.apiUrl} for label="${LABEL}"`);
  runLogger.logConfig(`Source: ${SOURCE}, Priority mode: ${PRIORITY}, Lookup: ${LOOKUP}${SPRINT ? `, Sprint: ${SPRINT}` : ""}`);

  let cycles = 0;
  while (true) {
    if (MAX_CYCLES > 0 && cycles >= MAX_CYCLES) {
      runLogger.log("STOP", `Reached max cycles (${MAX_CYCLES})`);
      break;
    }

    try {
      const rawItems = await fetchWork(cfg);
      if (rawItems.length === 0) {
        runLogger.logPoll(`No qualifying issues found — waiting ${POLL_MS / 1000}s`);
      } else {
        const items = await expandWithDependencies(rawItems, SOURCE, ghToken || "", owner, repo);
        const sorted = await prioritizeItems(items, PRIORITY, cfg.apiUrl, cfg.apiKey);
        runLogger.logConfig(`Prioritized ${sorted.length} issues (mode=${PRIORITY}): ${sorted.map((i) => `#${i.number}`).join(", ")}`);
        // Try items in priority order. Skip dep-blocked ones and attempt the next.
        // Only one unblocked item is processed per cycle so that after it merges,
        // the next cycle pulls latest main before branching for the subsequent item.
        depBlockedThisCycle.clear();
        for (const item of sorted) {
          await focusedProcessWorkItem(cfg, item, ghToken, owner, repo);
          if (!depBlockedThisCycle.has(item.id || String(item.number))) break;
        }
        cycles++;
      }
    } catch (err) {
      runLogger.logError((err as Error).message);
    }

    if (SKIP_POLL) {
      runLogger.log("STOP", "skip-poll: exiting after one cycle");
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * Resolves an issue key to the correct source system and fetches it.
 * Uses SourceResolver for smart routing — Jira-style keys (IR-82, PROJ-123)
 * go to Jira, numeric keys go to GitHub, and the resolver's memory/cache
 * is consulted for anything ambiguous.
 */
// ---------------------------------------------------------------------------
// Watch an existing PR/MR for review feedback and rework (no agent run)
// ---------------------------------------------------------------------------
async function watchIssue(cfg: ServerConfig, issueKey: string): Promise<void> {
  const item = await fetchIssueByKey(cfg, issueKey);
  if (!item) {
    runLogger.logError(`Could not find issue ${issueKey}`);
    return;
  }

  runLogger.logWork(`Watching issue ${item.id}: ${item.title}`);

  // Ensure we're on the right branch
  const branchName = item.suggestedBranch;
  const currentBranch = gitRunWithOutput(["rev-parse", "--abbrev-ref", "HEAD"], WORKSPACE);
  if (currentBranch.ok && currentBranch.stdout.trim() !== branchName) {
    runLogger.logGit(`Switching to branch: ${branchName}`);
    if (!gitRun(["checkout", branchName], WORKSPACE)) {
      runLogger.logError(`Cannot checkout branch ${branchName} — does it exist?`);
      return;
    }
  }

  // Find the existing PR/MR
  const platform = detectRemotePlatform(WORKSPACE);
  const ghToken = process.env.GITHUB_TOKEN;
  const owner = cfg.owner || process.env.GITHUB_DEFAULT_OWNER || "redsand";
  const repo = cfg.repo || process.env.AICODER_REPO || "";
  let prNumber: number | null = null;

  if (platform === "gitlab") {
    const projectId = getGitLabProjectFromRemote(WORKSPACE) || item.repo || cfg.repo || process.env.GITLAB_DEFAULT_PROJECT || "";
    if (!projectId) {
      runLogger.logError("No GitLab project ID — cannot find MR");
      return;
    }
    const existingMR = await findExistingGitLabMR(projectId, branchName);
    if (existingMR) {
      prNumber = existingMR.iid;
      runLogger.logConfig(`Found existing MR !${prNumber} for branch ${branchName}`);
    } else {
      runLogger.logError(`No MR found for branch ${branchName} — use --publish to create one`);
      return;
    }
  } else {
    if (!ghToken || !owner || !repo) {
      runLogger.logError("GitHub credentials required — set GITHUB_TOKEN");
      return;
    }
    // Search for an open PR from this branch
    try {
      const resp = await axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
        params: { state: "open", head: `${owner}:${branchName}` },
        headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
      });
      const prs = resp.data;
      if (prs.length > 0) {
        prNumber = prs[0].number;
        runLogger.logConfig(`Found existing PR #${prNumber} for branch ${branchName}`);
      } else {
        runLogger.logError(`No PR found for branch ${branchName} — use --publish to create one`);
        return;
      }
    } catch (err) {
      runLogger.logError(`Failed to search for PR: ${err instanceof Error ? err.message : err}`);
      return;
    }
  }

  if (!prNumber) {
    runLogger.logError("Could not find existing PR/MR");
    return;
  }

  // Clear any stale run state and enter the review loop
  clearRunState(issueKey);
  await runReviewLoop(cfg, item, ghToken, owner, repo, prNumber);
}

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

async function focusedProcessWorkItem(
  cfg: ServerConfig,
  item: WorkItem,
  ghToken: string | undefined,
  owner: string,
  repo: string,
): Promise<void> {
  try {
    await focusedProcessWorkItemInner(cfg, item, ghToken, owner, repo);
  } finally {
    // Always clean up the workspace before returning to the poll loop
    ensureCleanWorkspace();
  }
}

async function focusedProcessWorkItemInner(
  cfg: ServerConfig,
  item: WorkItem,
  ghToken: string | undefined,
  owner: string,
  repo: string,
): Promise<void> {
  const result = await processWorkItem(cfg, item);
  if (!result) {
    return; // Failed to create PR/MR
  }

  const platform = detectRemotePlatform(WORKSPACE);
  const label = platform === "gitlab" ? "MR" : "PR";
  const prNumber = result.prNumber;

  // For GitLab, we don't need ghToken/repo for review polling
  if (platform !== "gitlab" && (!ghToken || !repo)) {
    return; // No GitHub token — can't poll for review
  }

  runLogger.logConfig(`Waiting for review of ${label} #${prNumber} (polling every ${REVIEW_POLL_MS / 1000}s)`);
  await runReviewLoop(cfg, item, ghToken, owner, repo, prNumber);
}

/**
 * After an MR/PR is merged, close the originating issue on the source platform.
 * Jira: transition to Done + post completion comment.
 * GitLab/GitHub: close the issue + post completion comment.
 * Failures are non-fatal — logged but do not abort the run.
 */

async function runReviewLoop(
  cfg: ServerConfig,
  item: WorkItem,
  ghToken: string | undefined,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  const platform = detectRemotePlatform(WORKSPACE);
  const label = platform === "gitlab" ? "MR" : "PR";

  // Load run state for review loop (may have reworkCount/sinceTimestamp from a resumed run)
  const reviewState = loadRunState(item.id);
  let reworkCount = reviewState?.reworkCount ?? 0;
  let postponeTimeout = 0;
  const POSTPONE_MAX_MS = 30 * 60 * 1000; // 30 min max wait for service restoration
  // Start from now — ignore any review notes that existed before our push
  let sinceTimestamp = reviewState?.sinceTimestamp ?? new Date().toISOString();
  let lastReworkPrompt: string | null = null;
  const previousFailures: string[] = [];
  const promptStrategiesTried = new Set<PromptStrategy>(
    (reviewState?.promptStrategiesTried ?? []).filter(isPromptStrategy),
  );

  // Convergence state: tracks repeated findings, empty PRs, and no-progress rounds
  // Prefer RunState data; fall back to file persistence; fall back to fresh state
  let convergenceState: ConvergenceState = reviewState?.convergenceState
    ? {
        ...reviewState.convergenceState,
        identicalCount: new Map(Object.entries(reviewState.convergenceState.identicalCount)),
        lastRoundFindings: new Set(reviewState.convergenceState.lastRoundFindings),
        roundSummaries: reviewState.convergenceState.roundSummaries ?? [],
      }
    : loadConvergenceState(item.id);
  const convergenceConfig: ConvergenceConfig = { ...DEFAULT_CONVERGENCE_CONFIG };

  // Extract finding-like hashes from a rework prompt string.
  // Looks for file paths (e.g., "src/foo.ts") and severity keywords to produce stable hashes.
  function extractFindingsFromPrompt(prompt: string): Array<{ file?: string; severity?: string; category?: string; message?: string }> {
    const findings: Array<{ file?: string; severity?: string; category?: string; message?: string }> = [];
    // Match patterns like "src/path/file.ts" which appear in review findings
    const fileRegex = /(?:^|\s|`)([\w./-]+\.(?:ts|js|py|rs|go|java|rb|yml|yaml|json|md))\b/gim;
    const severityRegex = /\b(critical|high|medium|low|info|blocker|major|minor)\b/gi;
    const files = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = fileRegex.exec(prompt)) !== null) {
      files.add(m[1]);
    }
    const severities = new Set<string>();
    while ((m = severityRegex.exec(prompt)) !== null) {
      severities.add(m[1].toLowerCase());
    }
    // If we found files, create one finding per file+severity combo
    if (files.size > 0) {
      for (const file of files) {
        const sevIter = severities.values();
        const firstSev = sevIter.next().value;
        findings.push({ file, severity: firstSev || "high", category: "review" });
      }
    }
    return findings;
  }

  function toSemanticFindings(findings: Array<{ file?: string; severity?: string; category?: string; message?: string }>): SemanticFinding[] {
    return findings.map((finding) => ({
      severity: normalizeSemanticSeverity(finding.severity),
      category: normalizeSemanticCategory(finding.category),
      file: finding.file || "unknown",
      message: finding.message || `Finding in ${finding.file || "unknown file"}`,
    }));
  }

  function buildPromptContext(input: {
    codingPrompt: string;
    reviewerFindings: SemanticFinding[];
    diffFromLastAttempt?: string;
    testOutput?: string;
  }): PromptContext {
    const affectedFiles = [...new Set([
      ...input.reviewerFindings.map((finding) => finding.file).filter((file) => file && file !== "unknown"),
      ...extractFilesFromText(input.codingPrompt),
    ])];

    return {
      issueKey: item.id,
      issueTitle: item.title,
      issueDescription: item.url || item.title,
      codingPrompt: input.codingPrompt,
      affectedFiles,
      previousAttempts: reworkCount,
      previousFailures,
      reviewerFindings: input.reviewerFindings,
      diffFromLastAttempt: input.diffFromLastAttempt,
      testOutput: input.testOutput,
      strategiesTried: [...promptStrategiesTried],
    };
  }

  function recordPromptStrategy(strategy: PromptStrategy): void {
    promptStrategiesTried.add(strategy);
  }

  // Checkpoint: entered review polling
  const currentState = reviewState || {
    issueKey: item.id,
    issueNumber: item.number,
    title: item.title,
    url: item.url,
    owner: item.owner,
    repo: item.repo,
    suggestedBranch: item.suggestedBranch,
    labels: item.labels,
    source: (cfg.source === "gitlab" ? "gitlab" : cfg.source === "jira" ? "jira" : cfg.source === "work_items" ? "work_items" : "github") as RunState["source"],
    checkpoint: "review_polling" as PipelineCheckpoint,
    prNumber,
    reworkCount,
    sinceTimestamp,
    apiUrl: cfg.apiUrl,
    apiKey: cfg.apiKey,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveRunState({ ...currentState, checkpoint: "review_polling", prNumber, reworkCount, sinceTimestamp, convergenceState: serializeConvergence(convergenceState), promptStrategiesTried: [...promptStrategiesTried] });

  while (true) {
    // Poll for review result using platform-appropriate method
    let reviewResult: "passed" | "failed" | "postponed" | "merged" | "conflict" | "closed" | "human_review";

    if (platform === "gitlab") {
      const projectId = getGitLabProjectFromRemote(WORKSPACE) || item.repo || cfg.repo || process.env.GITLAB_DEFAULT_PROJECT || "";
      if (!projectId) {
        runLogger.logError("No GitLab project ID — cannot poll for review");
        return;
      }
      reviewResult = await pollForGitLabReviewResult(projectId, prNumber, REVIEW_POLL_MS, sinceTimestamp);
    } else {
      if (!ghToken || !owner || !repo) {
        runLogger.logError("No GitHub credentials — cannot poll for review");
        return;
      }
      reviewResult = await pollForReviewResult(ghToken, owner, repo, prNumber, REVIEW_POLL_MS, sinceTimestamp);
    }

    if (reviewResult === "passed" || reviewResult === "merged") {
      runLogger.logConfig(`${label} #${prNumber} passed review — pulling latest ${getBaseBranch()}`);
      clearRunState(item.id); // Run completed successfully
      clearReviewGateState(item.id); // All findings resolved — clear the gate
      forceCheckout(getBaseBranch(), WORKSPACE);
      gitRun(["pull", "--ff-only", "origin", getBaseBranch()], WORKSPACE);

      // Delete the merged local AI branch + stale remote-tracking ref so the
      // repo does not accumulate stale ai/issue-* branches over time.
      const cleanup = cleanupMergedBranch(WORKSPACE, item.suggestedBranch, getBaseBranch(), runLogger);
      if (!cleanup.deletedLocal && cleanup.reason && cleanup.reason !== "branch_not_found") {
        runLogger.logGit("Branch cleanup skipped", `${item.suggestedBranch}: ${cleanup.reason}`);
      }

      // Issue closing is the reviewer's responsibility after the MR is actually merged.
      return;
    }

    if (reviewResult === "closed") {
      runLogger.logError(`${label} #${prNumber} was closed without merge`);
      clearRunState(item.id);
      return;
    }

    if (reviewResult === "human_review") {
      runLogger.logConfig(`${label} #${prNumber} flagged for human review — stopping rework loop`);
      lastPipelineExitCode = EXIT_REVIEW_FAILED;
      clearRunState(item.id);
      return;
    }

    if (reviewResult === "postponed") {
      postponeTimeout += REVIEW_POLL_MS;
      if (postponeTimeout >= POSTPONE_MAX_MS) {
        runLogger.logError(`Review service unavailable for ${POSTPONE_MAX_MS / 1000}s — giving up on ${label} #${prNumber}`);
        return;
      }
      runLogger.logPoll(`Review service unavailable — retrying in ${REVIEW_POLL_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, REVIEW_POLL_MS));
      continue;
    }

    if (reviewResult === "conflict") {
      reworkCount++;
      if (reworkCount > MAX_REWORK) {
        runLogger.logError(`${label} #${prNumber} exceeded max rework cycles (${MAX_REWORK}) after conflict resolution attempts`);
        lastPipelineExitCode = EXIT_MAX_REWORK;
        clearRunState(item.id);
        return;
      }

      runLogger.logWork(`Conflict resolution cycle ${reworkCount}/${MAX_REWORK} for ${label} #${prNumber}`);

      // Perform local rebase with conflict resolution
      if (!await rebaseAndResolveConflicts(item.suggestedBranch)) {
        runLogger.logError(`Could not resolve conflicts for ${label} #${prNumber} — manual intervention required`);
        return;
      }

      // Force-push the rebased branch
      if (!pushBranch(item.suggestedBranch, { forceWithLease: true })) {
        runLogger.logError("Force push after rebase failed");
        return;
      }

      runLogger.logConfig(`Rebased and force-pushed ${item.suggestedBranch} — waiting for review again`);
      sinceTimestamp = new Date().toISOString();
      continue;
    }

    if (reviewResult === "failed") {
      reworkCount++;
      if (reworkCount > MAX_REWORK) {
        runLogger.logError(`${label} #${prNumber} exceeded max rework cycles (${MAX_REWORK})`);
        lastPipelineExitCode = EXIT_MAX_REWORK;
        clearRunState(item.id);
        return;
      }

      runLogger.logWork(`Rework cycle ${reworkCount}/${MAX_REWORK} for ${label} #${prNumber}`);

      // Extract the linked issue number from the PR/MR body
      const issueMatch = (item.url || "").match(/#(\d+)/);
      const issueNumber = issueMatch ? parseInt(issueMatch[1], 10) : item.number;

      // Fetch rework prompt — use appropriate method based on platform
      let reworkPrompt: string | null = null;
      if (platform === "gitlab") {
        const projectId = getGitLabProjectFromRemote(WORKSPACE) || item.repo || cfg.repo || process.env.GITLAB_DEFAULT_PROJECT || "";
        if (projectId) {
          reworkPrompt = await fetchGitLabReworkPrompt(projectId, prNumber, sinceTimestamp, item.id);
        }
      } else if (ghToken && owner && repo) {
        reworkPrompt = await fetchReworkPrompt(ghToken, owner, repo, prNumber, issueNumber, sinceTimestamp);
      }

      if (!reworkPrompt) {
        runLogger.logError("Could not fetch rework prompt — skipping rework");
        return;
      }

      if (lastReworkPrompt && reworkPrompt === lastReworkPrompt) {
        runLogger.logWork(`${label} #${prNumber} received identical rework prompt again — switching prompt strategy if possible`);
        previousFailures.push("GENERIC_REVIEW_FEEDBACK");
      }
      lastReworkPrompt = reworkPrompt;

      // Convergence: record findings from this round and check if loop should stop.
      // Prefer structured findings persisted by the reviewer; fall back to regex extraction.
      const persistedGateFindings = loadReviewGateState(item.id).lastFindings;
      const regexFindings = extractFindingsFromPrompt(reworkPrompt);
      const roundFindings = persistedGateFindings.length > 0
        ? persistedGateFindings.map((f) => ({ file: f.file, severity: f.severity, category: f.category }))
        : regexFindings;
      if (roundFindings.length === 0) {
        previousFailures.push("NON_ACTIONABLE_REVIEW_FEEDBACK");
        convergenceState = recordRoundFindings(convergenceState, [], true, {
          note: "Reviewer feedback did not include actionable file-specific findings.",
        });
        saveConvergenceState(convergenceState, item.id);
        const report = formatConvergenceReport(
          {
            shouldStop: true,
            reason: "identical_findings",
            message: "Reviewer feedback did not include file-specific actionable findings. Escalating instead of asking the aicoder to guess.",
            recommendation: "escalate_human",
          },
          convergenceState,
          convergenceConfig,
        );
        runLogger.logError("Reviewer feedback is non-actionable — escalating to human review");
        runLogger.logWork(report);
        lastPipelineExitCode = EXIT_REVIEW_FAILED;
        if (jiraClient.isConfigured()) {
          try { await jiraClient.addComment(item.id, report); } catch {}
        }
        saveProcessedIssue(item.id);
        clearRunState(item.id);
        return;
      }
      convergenceState = recordRoundFindings(convergenceState, roundFindings, true, {
        note: "Review findings received before rework.",
      });
      saveConvergenceState(convergenceState, item.id);

      // Review gate: persist findings so jira.close_issue can block Done transitions
      const gateFindings = roundFindings.map((f) => ({
        severity: (f.severity || "high") as "critical" | "high" | "medium" | "low",
        category: f.category || "review",
        file: f.file || "",
        message: `Finding in ${f.file || "unknown file"}`,
      }));
      const currentGateState = loadReviewGateState(item.id);
      saveReviewGateState({ ...currentGateState, lastFindings: [...currentGateState.lastFindings, ...gateFindings] }, item.id);

      const semanticFindings = toSemanticFindings(roundFindings);
      const detectedFailures = detectFailurePatterns({
        reworkPrompt,
        reviewerFindings: semanticFindings,
      });
      previousFailures.push(...detectedFailures);

      const convergence = checkConvergence(convergenceState, convergenceConfig);
      runLogger.logWork(`Convergence check (round ${convergenceState.roundNumber}): ${convergence.reason} — ${convergence.message}`);
      let strategyAlreadySelected = false;
      if (convergence.shouldStop) {
        if (convergence.recommendation === "requeue_different_prompt") {
          const decision = createConvergencePromptDecision(convergence, buildPromptContext({
            codingPrompt: reworkPrompt,
            reviewerFindings: semanticFindings,
          }));
          if (!decision.shouldEscalate) {
            recordPromptStrategy(decision.strategy);
            reworkPrompt = decision.prompt;
            strategyAlreadySelected = true;
            runLogger.logWork(`Convergence requested a different prompt strategy: ${decision.strategy}`);
          } else {
            runLogger.logError(decision.prompt);
            lastPipelineExitCode = EXIT_MAX_REWORK;
            clearRunState(item.id);
            return;
          }
        } else {
        runLogger.logError(`Convergence detected (${convergence.reason}): ${convergence.message}`);
        const report = formatConvergenceReport(convergence, convergenceState, convergenceConfig);
        runLogger.logWork(report);

        // ── Autorepair hook ──────────────────────────────────────────
        // Before escalating to a human, try one autorepair pass: a separate
        // LLM diagnoses why the loop is stuck and rewrites the ticket.
        // Quota and AUTOREPAIR_ENABLED env are handled inside runAutorepair.
        // The CLI --no-autorepair flag is an additional opt-out for this run.
        let autorepairOutcome: string | undefined;
        try {
          if (AUTOREPAIR_DISABLED) {
            runLogger.logWork("[autorepair] skipped — --no-autorepair flag set");
          } else {
          const ticketIdentifier: TicketIdentifier | null = (() => {
            if (platform === "gitlab") {
              const projectId = getGitLabProjectFromRemote(WORKSPACE) || item.repo || cfg.repo || process.env.GITLAB_DEFAULT_PROJECT || "";
              if (!projectId || !item.number) return null;
              return { source: "gitlab", id: item.number, projectId };
            }
            if (platform === "github") {
              const issueMatch = (item.url || "").match(/#(\d+)/);
              const issueNumber = issueMatch ? parseInt(issueMatch[1], 10) : item.number;
              if (!issueNumber || !owner || !repo) return null;
              return { source: "github", id: issueNumber, owner, repo };
            }
            if (cfg.source === "jira" || /^[A-Z]+-\d+$/.test(item.id)) {
              return { source: "jira", id: item.id };
            }
            return null;
          })();
          if (ticketIdentifier) {
            const autorepairResult = await runAutorepair({
              issueKey: item.id,
              ticket: ticketIdentifier,
              convergence: {
                reason: convergence.reason,
                summary: report,
                roundNumber: convergenceState.roundNumber,
              },
              reviewerFindings: semanticFindings.map((f) => ({
                roundNumber: convergenceState.roundNumber,
                file: f.file,
                severity: f.severity,
                category: f.category,
                message: f.message,
              })),
              coderRounds: convergenceState.roundSummaries.map((s) => ({
                roundNumber: s.roundNumber,
                changedFiles: s.changedFiles ?? [],
                diffStat: s.diffStat,
                empty: !s.prHadChanges,
              })),
              promptStrategiesTried: [...promptStrategiesTried],
            });
            autorepairOutcome = autorepairResult.outcome;
            runLogger.logWork(`[autorepair] outcome=${autorepairResult.outcome} attempt=${autorepairResult.attemptNumber ?? "-"} msg=${autorepairResult.message}`);
            if (autorepairResult.outcome === "repaired") {
              // Reset convergence + rework counters so the loop sees the
              // rewritten ticket as a fresh start. The ticket has been
              // updated in the source system; the agents will pick it up
              // on the next poll. Saving state and returning here ends
              // this run gracefully; the next iteration of the outer
              // aicoder cycle re-fetches the (now repaired) ticket.
              clearRunState(item.id);
              return;
            }
          } else {
            runLogger.logWork("[autorepair] skipped — could not build ticket identifier for this source");
          }
          } // close: else (AUTOREPAIR_DISABLED ? skip : run)
        } catch (err) {
          runLogger.logError(`[autorepair] threw unexpectedly: ${err instanceof Error ? err.message : err}`);
        }
        // ── End autorepair hook ──────────────────────────────────────

        lastPipelineExitCode = convergence.reason === "empty_prs" ? EXIT_NO_CHANGES : EXIT_MAX_REWORK;
        // Post convergence report to Jira if configured
        if (jiraClient.isConfigured()) {
          try {
            await jiraClient.addComment(
              item.id,
              autorepairOutcome
                ? `${report}\n\n_Autorepair attempted with outcome: \`${autorepairOutcome}\`._`
                : report,
            );
          } catch {
            // Non-fatal: convergence report is best-effort
          }
        }
        // Prevent re-pickup on next poll — ready-for-agent label stays but we've escalated
        saveProcessedIssue(item.id);
        clearRunState(item.id);
        return;
        }
      }

      if (!strategyAlreadySelected) {
        const strategyContext = buildPromptContext({
          codingPrompt: reworkPrompt,
          reviewerFindings: semanticFindings,
        });
        const strategy = selectStrategy(strategyContext);
        if (strategy === "escalate_human") {
          const escalationPrompt = generateStrategyPrompt(strategy, strategyContext);
          runLogger.logError(escalationPrompt);
          lastPipelineExitCode = EXIT_REVIEW_FAILED;
          saveProcessedIssue(item.id);
          clearRunState(item.id);
          return;
        }
        if (strategy !== "rework_with_feedback") {
          reworkPrompt = generateStrategyPrompt(strategy, strategyContext);
          runLogger.logWork(`Using prompt strategy ${strategy} for rework cycle ${reworkCount}`);
        }
        recordPromptStrategy(strategy);
      }

      // Show a summary of the rework prompt so the user can verify we're working on the right feedback
      const promptPreview = reworkPrompt.length > 500
        ? reworkPrompt.slice(0, 500) + `\n... (${reworkPrompt.length} chars total)`
        : reworkPrompt;
      runLogger.logWork(`Rework prompt for cycle ${reworkCount}:\n${promptPreview}`);

      // Checkout the existing branch and re-run agent with rework prompt
      if (!forceCheckout(item.suggestedBranch, WORKSPACE)) {
        runLogger.logError(`Could not checkout branch ${item.suggestedBranch} for rework`);
        return;
      }

      const reworkResult = await runAgent(await buildAgentPrompt(reworkPrompt, item));
      if (!reworkResult.finDetected && reworkResult.exitCode !== 0) {
        runLogger.logError(`Rework agent exited with code ${reworkResult.exitCode} — stopping`);
        return;
      }

      // Checkpoint: rework agent complete
      saveRunState({ ...currentState, checkpoint: "rework_agent_complete", reworkCount, sessionId: reworkResult.sessionId, convergenceState: serializeConvergence(convergenceState), promptStrategiesTried: [...promptStrategiesTried] });

      // Capture SHA before commit so we can detect "nothing staged" without
      // relying on validateDiffBeforePush, which compares vs the base branch and
      // would return valid=true even if rework added no NEW commits (the branch
      // already has the original PR changes). SHA comparison is the only reliable
      // way to know whether stageAndCommit actually created a commit this cycle.
      const reworkHeadBefore = gitRunWithOutput(["rev-parse", "HEAD"], WORKSPACE);

      if (!stageAndCommit(`[AI] rework #${reworkCount}: ${item.title}`)) {
        runLogger.logError("Rework stage/commit failed");
        return;
      }

      const reworkHeadAfter = gitRunWithOutput(["rev-parse", "HEAD"], WORKSPACE);
      const reworkMadeCommit = reworkHeadBefore.ok && reworkHeadAfter.ok
        && reworkHeadBefore.stdout.trim() !== reworkHeadAfter.stdout.trim();

      if (!reworkMadeCommit) {
        // stageAndCommit returned true but made no new commit (nothing was staged).
        // Pushing with the same SHA would leave the reviewer in an infinite
        // "[SKIP] already reviewed (SHA unchanged)" loop — skip the push instead.
        runLogger.logGit("WARN", `Rework #${reworkCount} staged nothing — skipping push to avoid SHA-unchanged reviewer loop`);
        previousFailures.push("EMPTY_PR");
        convergenceState = recordRoundFindings(convergenceState, [], false, {
          changedFiles: [],
          note: "Aicoder completed but produced no staged changes.",
        });
        saveConvergenceState(convergenceState, item.id);
        const emptyConvergence = checkConvergence(convergenceState, convergenceConfig);
        if (emptyConvergence.shouldStop) {
          runLogger.logError(`Convergence detected (${emptyConvergence.reason}): ${emptyConvergence.message}`);
          const report = formatConvergenceReport(emptyConvergence, convergenceState, convergenceConfig);
          runLogger.logWork(report);
          if (jiraClient.isConfigured()) {
            try { await jiraClient.addComment(item.id, report); } catch {}
          }
          lastPipelineExitCode = EXIT_NO_CHANGES;
          clearRunState(item.id);
          return;
        }
        continue; // Poll again — reviewer still has the old SHA, next rework attempt will try again
      }

      // Convergence: check if rework produced actual changes (empty PR detection)
      const baseBranch = getBaseBranch();
      const changedFilesThisRound = reworkHeadBefore.ok ? getChangedFiles(reworkHeadBefore.stdout.trim(), "HEAD") : [];
      let reworkDiffStat = gitRunWithOutput(["diff", `${baseBranch}...HEAD`, "--stat"], WORKSPACE);
      let reworkDiffContent = gitRunWithOutput(["diff", `${baseBranch}...HEAD`], WORKSPACE);
      let reworkValidation = validateDiffBeforePush(
        reworkDiffStat.ok ? reworkDiffStat.stdout : "",
        reworkDiffContent.ok ? reworkDiffContent.stdout : "",
      );
      let prHadChanges = reworkValidation.valid;
      if (!prHadChanges) {
        runLogger.logError(`Rework produced no meaningful changes (${reworkValidation.reason}) — empty PR cycle ${convergenceState.emptyPRCount + 1}`);
        previousFailures.push("EMPTY_PR");
      }
      convergenceState = recordRoundFindings(convergenceState, [], prHadChanges, {
        changedFiles: changedFilesThisRound,
        diffStat: reworkDiffStat.ok ? summarizeDiffStat(reworkDiffStat.stdout) : "",
        note: prHadChanges ? "Aicoder produced a rework commit." : `Aicoder changes failed validation: ${reworkValidation.reason}`,
      });
      saveConvergenceState(convergenceState, item.id);
      if (!prHadChanges) {
        const convergence = checkConvergence(convergenceState, convergenceConfig);
        if (convergence.shouldStop) {
          if (convergence.recommendation === "requeue_different_prompt") {
            const decision = createConvergencePromptDecision(convergence, buildPromptContext({
              codingPrompt: reworkPrompt,
              reviewerFindings: [],
              diffFromLastAttempt: reworkDiffContent.ok ? reworkDiffContent.stdout : "",
            }));
            if (!decision.shouldEscalate) {
              recordPromptStrategy(decision.strategy);
              runLogger.logWork(`Empty PR convergence selected prompt strategy ${decision.strategy}; retrying immediately`);
              const retryResult = await runAgent(await buildAgentPrompt(decision.prompt, item));
              if (!retryResult.finDetected && retryResult.exitCode !== 0) {
                runLogger.logError(`Recovery rework agent exited with code ${retryResult.exitCode} — stopping`);
                return;
              }
              saveRunState({ ...currentState, checkpoint: "rework_agent_complete", reworkCount, sessionId: retryResult.sessionId, convergenceState: serializeConvergence(convergenceState), promptStrategiesTried: [...promptStrategiesTried] });
              if (!stageAndCommit(`[AI] rework #${reworkCount} recovery: ${item.title}`)) {
                runLogger.logError("Recovery rework stage/commit failed");
                return;
              }
              reworkDiffStat = gitRunWithOutput(["diff", `${baseBranch}...HEAD`, "--stat"], WORKSPACE);
              reworkDiffContent = gitRunWithOutput(["diff", `${baseBranch}...HEAD`], WORKSPACE);
              reworkValidation = validateDiffBeforePush(
                reworkDiffStat.ok ? reworkDiffStat.stdout : "",
                reworkDiffContent.ok ? reworkDiffContent.stdout : "",
              );
              prHadChanges = reworkValidation.valid;
              if (prHadChanges) {
                runLogger.logWork(`Recovery prompt strategy ${decision.strategy} produced meaningful changes`);
              } else {
                runLogger.logError(`Recovery prompt strategy ${decision.strategy} still produced no meaningful changes (${reworkValidation.reason})`);
              }
            }
          }
          if (prHadChanges) {
            convergenceState = recordRoundFindings(convergenceState, [], true, {
              changedFiles: getChangedFiles(reworkHeadBefore.ok ? reworkHeadBefore.stdout.trim() : baseBranch, "HEAD"),
              diffStat: reworkDiffStat.ok ? summarizeDiffStat(reworkDiffStat.stdout) : "",
              note: "Recovery prompt produced meaningful changes.",
            });
            saveConvergenceState(convergenceState, item.id);
          } else {
          runLogger.logError(`Convergence detected (${convergence.reason}): ${convergence.message}`);
          lastPipelineExitCode = EXIT_NO_CHANGES;
          const report = formatConvergenceReport(convergence, convergenceState, convergenceConfig);
          runLogger.logWork(report);
          if (jiraClient.isConfigured()) {
            try { await jiraClient.addComment(item.id, report); } catch { /* best-effort */ }
          }
          clearRunState(item.id);
          return;
          }
        }
      }

      // Checkpoint: rework committed
      saveRunState({ ...currentState, checkpoint: "rework_committed", reworkCount, convergenceState: serializeConvergence(convergenceState), promptStrategiesTried: [...promptStrategiesTried] });

      // TDD: Tiered test gate after rework — fix failing tests if possible
      const reworkTestPassed = await fixReworkTests(item, reworkCount);
      if (!reworkTestPassed) {
        previousFailures.push("TESTS_FAILING");
        runLogger.logError("Rework tests could not be fixed — stopping");
        return;
      }

      // Checkpoint: rework tests passed
      saveRunState({ ...currentState, checkpoint: "rework_tests_passed", reworkCount, convergenceState: serializeConvergence(convergenceState), promptStrategiesTried: [...promptStrategiesTried] });

      if (!pushBranch(item.suggestedBranch, { forceWithLease: true })) {
        runLogger.logError("Rework push failed");
        return;
      }

      // Checkpoint: rework pushed — update state for review loop resumption
      sinceTimestamp = new Date().toISOString();
      saveRunState({ ...currentState, checkpoint: "rework_pushed", reworkCount, sinceTimestamp, prNumber, convergenceState: serializeConvergence(convergenceState), promptStrategiesTried: [...promptStrategiesTried] });

      runLogger.logConfig(`Rework pushed for ${label} #${prNumber} — waiting for review again`);
      continue;
    }

    // Unknown result — keep polling
    await new Promise((r) => setTimeout(r, REVIEW_POLL_MS));
  }
}

async function pollLoop(cfg: ServerConfig): Promise<void> {
  runLogger.logConfig(`AiRemoteCoder started in poll mode (agent: ${AGENT}, workspace: ${WORKSPACE}${USE_OLLAMA ? ", ollama: on" : ""}, base: ${getBaseBranch()})`);

  // --issue <key>: work on a specific issue and exit (no polling)
  if (TARGET_ISSUE_KEY) {
    runLogger.logConfig(`Targeting issue ${TARGET_ISSUE_KEY} directly`);
    const target = await fetchIssueByKey(cfg, TARGET_ISSUE_KEY);
    if (!target) {
      runLogger.logError(`Could not find issue ${TARGET_ISSUE_KEY}`);
      process.exit(1);
    }
    await processWorkItem(cfg, target);
    process.exit(lastPipelineExitCode);
  }

  runLogger.logConfig(`Polling ${cfg.apiUrl} for label="${LABEL}"`);
  runLogger.logConfig(`Source: ${SOURCE}, Priority mode: ${PRIORITY}, Lookup: ${LOOKUP}${SPRINT ? `, Sprint: ${SPRINT}` : ""}`);

  let cycles = 0;
  while (true) {
    if (MAX_CYCLES > 0 && cycles >= MAX_CYCLES) {
      runLogger.log("STOP", `Reached max cycles (${MAX_CYCLES})`);
      break;
    }

    try {
      const rawItems = await fetchWork(cfg);
      const ghToken = process.env.GITHUB_TOKEN;
      const owner = cfg.owner || process.env.GITHUB_DEFAULT_OWNER || "redsand";
      const repo = cfg.repo || process.env.AICODER_REPO || "";

      if (rawItems.length === 0) {
        runLogger.logPoll(`No qualifying issues found — waiting ${POLL_MS / 1000}s`);
      } else {
        const items = await expandWithDependencies(rawItems, SOURCE, ghToken || "", owner, repo);
        const sorted = await prioritizeItems(items, PRIORITY, cfg.apiUrl, cfg.apiKey);
        runLogger.logConfig(`Prioritized ${sorted.length} issues (mode=${PRIORITY}): ${sorted.map((i) => `#${i.number}`).join(", ")}`);
        for (const item of sorted) {
          await processWorkItem(cfg, item);
        }
        cycles++;
      }
    } catch (err) {
      runLogger.logError((err as Error).message);
    }

    if (SKIP_POLL) {
      runLogger.log("STOP", "skip-poll: exiting after one cycle");
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
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
