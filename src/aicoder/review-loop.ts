/**
 * The post-PR review-then-rework loop. Extracted from src/aicoder.ts
 * (2026-06-26).
 *
 * Lifecycle:
 *   1. Poll the platform (GitHub PR comments or GitLab MR notes) for a
 *      review-marker comment (Passed / Failed / Conflict / Postponed /
 *      Human Review / Closed / Merged).
 *   2. Branch on the result:
 *      - passed/merged → checkout base, cleanup branches, exit success
 *      - closed         → exit (PR was closed without merge)
 *      - human_review   → exit (escalated to a human)
 *      - postponed      → backoff up to 30 min total, then give up
 *      - conflict       → local rebase + force-push, loop again
 *      - failed         → run the rework sub-loop:
 *                          a. fetch the reviewer's coding prompt
 *                          b. convergence check (identical findings,
 *                             empty PRs, no-progress rounds)
 *                          c. try autorepair before giving up
 *                          d. pick a prompt strategy
 *                          e. run the agent + commit + test + push
 *                          f. loop
 *
 * The 30+ runtime dependencies (clients, helpers, persisters, exit
 * codes) are all injected via ReviewLoopDeps so this module doesn't
 * reach back into aicoder.ts. lastPipelineExitCode is a setter callback
 * because aicoder.ts owns the mutable variable.
 */
import type { SemanticFinding } from "../autonomous-loop/semantic-review";
import {
  checkConvergence,
  createConvergencePromptDecision,
  DEFAULT_CONVERGENCE_CONFIG,
  formatConvergenceReport,
  recordRoundFindings,
} from "../autonomous-loop/convergence";
import type {
  ConvergenceConfig,
  ConvergenceState,
} from "../autonomous-loop/convergence";
import {
  loadConvergenceState,
  saveConvergenceState,
  serializeConvergence,
} from "../autonomous-loop/convergence-state";
import {
  cleanupMergedBranch,
  gitRun,
  gitRunWithOutput,
} from "../autonomous-loop/git-ops";
import {
  detectRemotePlatform,
  getGitLabProjectFromRemote,
} from "../autonomous-loop/pr-creator";
import { validateDiffBeforePush } from "../aicoder-pipeline";
import { runAutorepair } from "../autonomous-loop/ticket-autorepair";
import type { TicketIdentifier } from "../autonomous-loop/ticket-autorepair/source-updater";
import {
  clearReviewGateState,
  loadReviewGateState,
  saveReviewGateState,
} from "../autonomous-loop/review-gate-state";
import {
  detectFailurePatterns,
  generatePrompt as generateStrategyPrompt,
  selectStrategy,
} from "../autonomous-loop/prompt-strategies";
import type {
  PromptContext,
  PromptStrategy,
} from "../autonomous-loop/prompt-strategies";
import type {
  PipelineCheckpoint,
  RunState,
  ServerConfig,
  WorkItem,
} from "../autonomous-loop/types";
import {
  pollForGitLabReviewResult,
  pollForReviewResult,
} from "./review-polling";
import type { GitLabReviewPollClient } from "./review-polling";
import {
  fetchGitLabReworkPrompt,
  fetchReworkPrompt,
} from "./rework-prompts";
import type {
  GitLabReworkClient,
  JiraReworkClient,
} from "./rework-prompts";
import { getChangedFiles, summarizeDiffStat } from "./git-diff-helpers";
import {
  extractFilesFromText,
  isPromptStrategy,
  normalizeSemanticCategory,
  normalizeSemanticSeverity,
} from "./semantic-helpers";

/** Local re-declaration of PipelineLogger plus the logPoll method we
 *  need. Avoids importing from autonomous-loop/types just for the shape. */
export interface ReviewLoopLogger {
  logConfig(message: string): void;
  logError(message: string): void;
  logGit(action: string, detail?: string): void;
  logPoll(message: string): void;
  logWork(message: string): void;
  logAgent(message: string): void;
}

export interface ReviewLoopJiraClient extends JiraReworkClient {
  addComment(issueKey: string, body: string): Promise<unknown>;
}

export interface ReviewLoopGithubClient {
  getIssue(
    issueNumber: number,
    owner?: string,
    repo?: string,
  ): Promise<{ labels?: Array<{ name?: string } | string> }>;
  updateIssue(
    issueNumber: number,
    params: { labels?: string[] },
    owner?: string,
    repo?: string,
  ): Promise<unknown>;
  addIssueComment(
    issueNumber: number,
    body: string,
    owner?: string,
    repo?: string,
  ): Promise<unknown>;
}

export interface ReviewLoopAgentResult {
  finDetected: boolean;
  exitCode: number | null;
  sessionId?: string;
}

export interface ReviewLoopExitCodes {
  reviewFailed: number;
  maxRework: number;
  noChanges: number;
}

export interface ReviewLoopDeps {
  logger: ReviewLoopLogger;
  workspace: string;

  // Platform clients
  gitlabReviewClient: GitLabReviewPollClient;
  gitlabReworkClient: GitLabReworkClient;
  jiraClient: ReviewLoopJiraClient;
  githubClient: ReviewLoopGithubClient;

  // Tunables
  reviewPollMs: number;
  maxRework: number;
  autorepairDisabled: boolean;
  exits: ReviewLoopExitCodes;

  // Callbacks back into aicoder.ts singletons
  runAgent: (prompt: string) => Promise<ReviewLoopAgentResult>;
  buildAgentPrompt: (prompt: string, item: WorkItem) => Promise<string>;
  forceCheckout: (branch: string, cwd: string) => boolean;
  stageAndCommit: (message: string) => boolean;
  pushBranch: (branch: string, opts: { forceWithLease?: boolean }) => boolean;
  rebaseAndResolveConflicts: (branchName: string) => Promise<boolean>;
  fixReworkTests: (item: WorkItem, reworkCount: number) => Promise<boolean>;
  getBaseBranch: () => string;
  saveRunState: (state: RunState, issueKey?: string) => void;
  loadRunState: (issueKey?: string) => RunState | null;
  clearRunState: (issueKey?: string) => void;
  saveProcessedIssue: (issueKey: string) => void;

  /** Setter for the host process's lastPipelineExitCode mutable. */
  setLastPipelineExitCode: (code: number) => void;
}

const POSTPONE_MAX_MS = 30 * 60 * 1000; // 30 min — see review postponed branch

/** Lightweight regex-based finding extractor for review prompts. */
function extractFindingsFromPrompt(
  prompt: string,
): Array<{ file?: string; severity?: string; category?: string; message?: string }> {
  const findings: Array<{
    file?: string;
    severity?: string;
    category?: string;
    message?: string;
  }> = [];
  const fileRegex =
    /(?:^|\s|`)([\w./-]+\.(?:ts|js|py|rs|go|java|rb|yml|yaml|json|md))\b/gim;
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
  if (files.size > 0) {
    for (const file of files) {
      const sevIter = severities.values();
      const firstSev = sevIter.next().value;
      findings.push({ file, severity: firstSev || "high", category: "review" });
    }
  }
  return findings;
}

function toSemanticFindings(
  findings: Array<{ file?: string; severity?: string; category?: string; message?: string }>,
): SemanticFinding[] {
  return findings.map((finding) => ({
    severity: normalizeSemanticSeverity(finding.severity),
    category: normalizeSemanticCategory(finding.category),
    file: finding.file || "unknown",
    message: finding.message || `Finding in ${finding.file || "unknown file"}`,
  }));
}

const HUMAN_ESCALATION_LABEL = "needs-human";

/**
 * Surface a "this needs a human now" state somewhere visible outside the
 * runner logs. Jira gets a comment (existing behavior); GitHub additionally
 * gets a distinctly-worded comment plus a `needs-human` label, since the
 * normal per-round review comment ("Review Failed — Rework Required") looks
 * identical whether or not this round was the one that gave up for good.
 * Both are best-effort — a notification failure must not block the
 * already-decided escalation exit.
 */
async function postHumanEscalationNotice(
  deps: ReviewLoopDeps,
  item: WorkItem,
  platform: string,
  owner: string,
  repo: string,
  report: string,
): Promise<void> {
  if (deps.jiraClient.isConfigured()) {
    try {
      await deps.jiraClient.addComment(item.id, report);
    } catch {
      // best-effort
    }
  }
  if (platform === "github" && owner && repo && item.number) {
    const body = `🚨 **Human review required** — the AI coder/reviewer loop stopped making progress on this issue and will not retry automatically.\n\n${report}`;
    try {
      await deps.githubClient.addIssueComment(item.number, body, owner, repo);
    } catch {
      // best-effort
    }
    try {
      const current = await deps.githubClient.getIssue(item.number, owner, repo);
      const currentLabels = (current?.labels || []).map((l) =>
        typeof l === "string" ? l : l?.name ?? "",
      );
      if (!currentLabels.some((l) => l.toLowerCase() === HUMAN_ESCALATION_LABEL)) {
        await deps.githubClient.updateIssue(
          item.number,
          { labels: [...currentLabels, HUMAN_ESCALATION_LABEL] },
          owner,
          repo,
        );
      }
    } catch {
      // best-effort
    }
  }
}

export async function runReviewLoop(
  deps: ReviewLoopDeps,
  cfg: ServerConfig,
  item: WorkItem,
  ghToken: string | undefined,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  const platform = detectRemotePlatform(deps.workspace);
  const label = platform === "gitlab" ? "MR" : "PR";

  const reviewState = deps.loadRunState(item.id);
  let reworkCount = reviewState?.reworkCount ?? 0;
  let postponeTimeout = 0;
  let sinceTimestamp = reviewState?.sinceTimestamp ?? new Date().toISOString();
  let lastReworkPrompt: string | null = null;
  const previousFailures: string[] = [];
  const promptStrategiesTried = new Set<PromptStrategy>(
    (reviewState?.promptStrategiesTried ?? []).filter(isPromptStrategy),
  );

  // Convergence state. Prefer reviewState; fall back to file persistence.
  let convergenceState: ConvergenceState = reviewState?.convergenceState
    ? {
        ...reviewState.convergenceState,
        identicalCount: new Map(
          Object.entries(reviewState.convergenceState.identicalCount),
        ),
        lastRoundFindings: new Set(
          reviewState.convergenceState.lastRoundFindings,
        ),
        roundSummaries: reviewState.convergenceState.roundSummaries ?? [],
      }
    : loadConvergenceState(item.id);
  const convergenceConfig: ConvergenceConfig = { ...DEFAULT_CONVERGENCE_CONFIG };

  function buildPromptContext(input: {
    codingPrompt: string;
    reviewerFindings: SemanticFinding[];
    diffFromLastAttempt?: string;
    testOutput?: string;
  }): PromptContext {
    const affectedFiles = [
      ...new Set([
        ...input.reviewerFindings
          .map((finding) => finding.file)
          .filter((file) => file && file !== "unknown"),
        ...extractFilesFromText(input.codingPrompt),
      ]),
    ];

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
    source: (cfg.source === "gitlab"
      ? "gitlab"
      : cfg.source === "jira"
        ? "jira"
        : cfg.source === "work_items"
          ? "work_items"
          : "github") as RunState["source"],
    checkpoint: "review_polling" as PipelineCheckpoint,
    prNumber,
    reworkCount,
    sinceTimestamp,
    apiUrl: cfg.apiUrl,
    apiKey: cfg.apiKey,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  deps.saveRunState({
    ...currentState,
    checkpoint: "review_polling",
    prNumber,
    reworkCount,
    sinceTimestamp,
    convergenceState: serializeConvergence(convergenceState),
    promptStrategiesTried: [...promptStrategiesTried],
  });

  while (true) {
    let reviewResult: "passed" | "failed" | "postponed" | "merged" | "conflict" | "closed" | "human_review";

    if (platform === "gitlab") {
      const projectId =
        getGitLabProjectFromRemote(deps.workspace) ||
        item.repo ||
        cfg.repo ||
        process.env.GITLAB_DEFAULT_PROJECT ||
        "";
      if (!projectId) {
        deps.logger.logError("No GitLab project ID — cannot poll for review");
        return;
      }
      reviewResult = await pollForGitLabReviewResult(
        deps.gitlabReviewClient,
        projectId,
        prNumber,
        deps.reviewPollMs,
        sinceTimestamp,
      );
    } else {
      if (!ghToken || !owner || !repo) {
        deps.logger.logError("No GitHub credentials — cannot poll for review");
        return;
      }
      reviewResult = await pollForReviewResult(
        ghToken,
        owner,
        repo,
        prNumber,
        deps.reviewPollMs,
        sinceTimestamp,
      );
    }

    if (reviewResult === "passed" || reviewResult === "merged") {
      deps.logger.logConfig(
        `${label} #${prNumber} passed review — pulling latest ${deps.getBaseBranch()}`,
      );
      deps.clearRunState(item.id);
      clearReviewGateState(item.id);
      deps.forceCheckout(deps.getBaseBranch(), deps.workspace);
      gitRun(["pull", "--ff-only", "origin", deps.getBaseBranch()], deps.workspace);

      const cleanup = cleanupMergedBranch(
        deps.workspace,
        item.suggestedBranch,
        deps.getBaseBranch(),
        deps.logger,
      );
      if (
        !cleanup.deletedLocal &&
        cleanup.reason &&
        cleanup.reason !== "branch_not_found"
      ) {
        deps.logger.logGit(
          "Branch cleanup skipped",
          `${item.suggestedBranch}: ${cleanup.reason}`,
        );
      }
      return;
    }

    if (reviewResult === "closed") {
      deps.logger.logError(`${label} #${prNumber} was closed without merge`);
      deps.clearRunState(item.id);
      return;
    }

    if (reviewResult === "human_review") {
      deps.logger.logConfig(
        `${label} #${prNumber} flagged for human review — stopping rework loop`,
      );
      deps.setLastPipelineExitCode(deps.exits.reviewFailed);
      deps.clearRunState(item.id);
      return;
    }

    if (reviewResult === "postponed") {
      postponeTimeout += deps.reviewPollMs;
      if (postponeTimeout >= POSTPONE_MAX_MS) {
        deps.logger.logError(
          `Review service unavailable for ${POSTPONE_MAX_MS / 1000}s — giving up on ${label} #${prNumber}`,
        );
        return;
      }
      deps.logger.logPoll(
        `Review service unavailable — retrying in ${deps.reviewPollMs / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, deps.reviewPollMs));
      continue;
    }

    if (reviewResult === "conflict") {
      reworkCount++;
      if (reworkCount > deps.maxRework) {
        deps.logger.logError(
          `${label} #${prNumber} exceeded max rework cycles (${deps.maxRework}) after conflict resolution attempts`,
        );
        deps.setLastPipelineExitCode(deps.exits.maxRework);
        deps.clearRunState(item.id);
        return;
      }
      deps.logger.logWork(
        `Conflict resolution cycle ${reworkCount}/${deps.maxRework} for ${label} #${prNumber}`,
      );

      if (!(await deps.rebaseAndResolveConflicts(item.suggestedBranch))) {
        deps.logger.logError(
          `Could not resolve conflicts for ${label} #${prNumber} — manual intervention required`,
        );
        return;
      }
      if (!deps.pushBranch(item.suggestedBranch, { forceWithLease: true })) {
        deps.logger.logError("Force push after rebase failed");
        return;
      }
      deps.logger.logConfig(
        `Rebased and force-pushed ${item.suggestedBranch} — waiting for review again`,
      );
      sinceTimestamp = new Date().toISOString();
      continue;
    }

    if (reviewResult === "failed") {
      reworkCount++;
      if (reworkCount > deps.maxRework) {
        deps.logger.logError(
          `${label} #${prNumber} exceeded max rework cycles (${deps.maxRework})`,
        );
        deps.setLastPipelineExitCode(deps.exits.maxRework);
        deps.clearRunState(item.id);
        return;
      }
      deps.logger.logWork(
        `Rework cycle ${reworkCount}/${deps.maxRework} for ${label} #${prNumber}`,
      );

      const issueMatch = (item.url || "").match(/#(\d+)/);
      const issueNumber = issueMatch ? parseInt(issueMatch[1], 10) : item.number;

      let reworkPrompt: string | null = null;
      if (platform === "gitlab") {
        const projectId =
          getGitLabProjectFromRemote(deps.workspace) ||
          item.repo ||
          cfg.repo ||
          process.env.GITLAB_DEFAULT_PROJECT ||
          "";
        if (projectId) {
          reworkPrompt = await fetchGitLabReworkPrompt(
            deps.gitlabReworkClient,
            deps.jiraClient,
            projectId,
            prNumber,
            sinceTimestamp,
            item.id,
          );
        }
      } else if (ghToken && owner && repo) {
        reworkPrompt = await fetchReworkPrompt(
          ghToken,
          owner,
          repo,
          prNumber,
          issueNumber,
          sinceTimestamp,
        );
      }

      if (!reworkPrompt) {
        deps.logger.logError("Could not fetch rework prompt — skipping rework");
        return;
      }

      if (lastReworkPrompt && reworkPrompt === lastReworkPrompt) {
        deps.logger.logWork(
          `${label} #${prNumber} received identical rework prompt again — switching prompt strategy if possible`,
        );
        previousFailures.push("GENERIC_REVIEW_FEEDBACK");
      }
      lastReworkPrompt = reworkPrompt;

      const persistedGateFindings = loadReviewGateState(item.id).lastFindings;
      const regexFindings = extractFindingsFromPrompt(reworkPrompt);
      const roundFindings =
        persistedGateFindings.length > 0
          ? persistedGateFindings.map((f) => ({
              file: f.file,
              severity: f.severity,
              category: f.category,
            }))
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
            message:
              "Reviewer feedback did not include file-specific actionable findings. Escalating instead of asking the aicoder to guess.",
            recommendation: "escalate_human",
          },
          convergenceState,
          convergenceConfig,
        );
        deps.logger.logError(
          "Reviewer feedback is non-actionable — escalating to human review",
        );
        deps.logger.logWork(report);
        deps.setLastPipelineExitCode(deps.exits.reviewFailed);
        await postHumanEscalationNotice(deps, item, platform, owner, repo, report);
        deps.saveProcessedIssue(item.id);
        deps.clearRunState(item.id);
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
      saveReviewGateState(
        {
          ...currentGateState,
          lastFindings: [...currentGateState.lastFindings, ...gateFindings],
        },
        item.id,
      );

      const semanticFindings = toSemanticFindings(roundFindings);
      const detectedFailures = detectFailurePatterns({
        reworkPrompt,
        reviewerFindings: semanticFindings,
      });
      previousFailures.push(...detectedFailures);

      const convergence = checkConvergence(convergenceState, convergenceConfig);
      deps.logger.logWork(
        `Convergence check (round ${convergenceState.roundNumber}): ${convergence.reason} — ${convergence.message}`,
      );
      let strategyAlreadySelected = false;
      if (convergence.shouldStop) {
        if (convergence.recommendation === "requeue_different_prompt") {
          const decision = createConvergencePromptDecision(
            convergence,
            buildPromptContext({
              codingPrompt: reworkPrompt,
              reviewerFindings: semanticFindings,
            }),
          );
          if (!decision.shouldEscalate) {
            recordPromptStrategy(decision.strategy);
            reworkPrompt = decision.prompt;
            strategyAlreadySelected = true;
            deps.logger.logWork(
              `Convergence requested a different prompt strategy: ${decision.strategy}`,
            );
          } else {
            deps.logger.logError(decision.prompt);
            deps.setLastPipelineExitCode(deps.exits.maxRework);
            deps.clearRunState(item.id);
            return;
          }
        } else {
          deps.logger.logError(
            `Convergence detected (${convergence.reason}): ${convergence.message}`,
          );
          const report = formatConvergenceReport(
            convergence,
            convergenceState,
            convergenceConfig,
          );
          deps.logger.logWork(report);

          // Autorepair hook — one LLM-powered ticket-rewrite attempt before
          // escalating to a human. Quota and AUTOREPAIR_ENABLED env are
          // checked inside runAutorepair; the host's CLI flag is another
          // opt-out for this specific run.
          let autorepairOutcome: string | undefined;
          try {
            if (deps.autorepairDisabled) {
              deps.logger.logWork("[autorepair] skipped — --no-autorepair flag set");
            } else {
              const ticketIdentifier: TicketIdentifier | null = (() => {
                if (platform === "gitlab") {
                  const projectId =
                    getGitLabProjectFromRemote(deps.workspace) ||
                    item.repo ||
                    cfg.repo ||
                    process.env.GITLAB_DEFAULT_PROJECT ||
                    "";
                  if (!projectId || !item.number) return null;
                  return { source: "gitlab", id: item.number, projectId };
                }
                if (platform === "github") {
                  const issueMatch2 = (item.url || "").match(/#(\d+)/);
                  const issueNumber2 = issueMatch2
                    ? parseInt(issueMatch2[1], 10)
                    : item.number;
                  if (!issueNumber2 || !owner || !repo) return null;
                  return { source: "github", id: issueNumber2, owner, repo };
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
                deps.logger.logWork(
                  `[autorepair] outcome=${autorepairResult.outcome} attempt=${autorepairResult.attemptNumber ?? "-"} msg=${autorepairResult.message}`,
                );
                if (autorepairResult.outcome === "repaired") {
                  // Reset run state so the next outer aicoder cycle re-fetches the
                  // (now repaired) ticket as a fresh start.
                  deps.clearRunState(item.id);
                  return;
                }
              } else {
                deps.logger.logWork(
                  "[autorepair] skipped — could not build ticket identifier for this source",
                );
              }
            }
          } catch (err) {
            deps.logger.logError(
              `[autorepair] threw unexpectedly: ${err instanceof Error ? err.message : err}`,
            );
          }

          deps.setLastPipelineExitCode(
            convergence.reason === "empty_prs"
              ? deps.exits.noChanges
              : deps.exits.maxRework,
          );
          await postHumanEscalationNotice(
            deps,
            item,
            platform,
            owner,
            repo,
            autorepairOutcome
              ? `${report}\n\n_Autorepair attempted with outcome: \`${autorepairOutcome}\`._`
              : report,
          );
          deps.saveProcessedIssue(item.id);
          deps.clearRunState(item.id);
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
          deps.logger.logError(escalationPrompt);
          deps.setLastPipelineExitCode(deps.exits.reviewFailed);
          await postHumanEscalationNotice(deps, item, platform, owner, repo, escalationPrompt);
          deps.saveProcessedIssue(item.id);
          deps.clearRunState(item.id);
          return;
        }
        if (strategy !== "rework_with_feedback") {
          reworkPrompt = generateStrategyPrompt(strategy, strategyContext);
          deps.logger.logWork(
            `Using prompt strategy ${strategy} for rework cycle ${reworkCount}`,
          );
        }
        recordPromptStrategy(strategy);
      }

      const promptPreview =
        reworkPrompt.length > 500
          ? reworkPrompt.slice(0, 500) + `\n... (${reworkPrompt.length} chars total)`
          : reworkPrompt;
      deps.logger.logWork(`Rework prompt for cycle ${reworkCount}:\n${promptPreview}`);

      if (!deps.forceCheckout(item.suggestedBranch, deps.workspace)) {
        deps.logger.logError(
          `Could not checkout branch ${item.suggestedBranch} for rework`,
        );
        return;
      }

      const reworkResult = await deps.runAgent(
        await deps.buildAgentPrompt(reworkPrompt, item),
      );
      if (!reworkResult.finDetected && reworkResult.exitCode !== 0) {
        deps.logger.logError(
          `Rework agent exited with code ${reworkResult.exitCode} — stopping`,
        );
        return;
      }

      deps.saveRunState({
        ...currentState,
        checkpoint: "rework_agent_complete",
        reworkCount,
        sessionId: reworkResult.sessionId,
        convergenceState: serializeConvergence(convergenceState),
        promptStrategiesTried: [...promptStrategiesTried],
      });

      // Capture SHA before commit so we can detect a no-op commit (nothing
      // staged) — validateDiffBeforePush compares vs base branch and would
      // return valid even if the rework added no NEW commits.
      const reworkHeadBefore = gitRunWithOutput(
        ["rev-parse", "HEAD"],
        deps.workspace,
      );

      if (!deps.stageAndCommit(`[AI] rework #${reworkCount}: ${item.title}`)) {
        deps.logger.logError("Rework stage/commit failed");
        return;
      }

      const reworkHeadAfter = gitRunWithOutput(
        ["rev-parse", "HEAD"],
        deps.workspace,
      );
      const reworkMadeCommit =
        reworkHeadBefore.ok &&
        reworkHeadAfter.ok &&
        reworkHeadBefore.stdout.trim() !== reworkHeadAfter.stdout.trim();

      if (!reworkMadeCommit) {
        // No new commit despite stageAndCommit returning true → pushing the
        // same SHA would put the reviewer in an infinite "[SKIP] already
        // reviewed" loop. Skip the push and convergence-check instead.
        deps.logger.logGit(
          "WARN",
          `Rework #${reworkCount} staged nothing — skipping push to avoid SHA-unchanged reviewer loop`,
        );
        previousFailures.push("EMPTY_PR");
        convergenceState = recordRoundFindings(convergenceState, [], false, {
          changedFiles: [],
          note: "Aicoder completed but produced no staged changes.",
        });
        saveConvergenceState(convergenceState, item.id);
        const emptyConvergence = checkConvergence(convergenceState, convergenceConfig);
        if (emptyConvergence.shouldStop) {
          deps.logger.logError(
            `Convergence detected (${emptyConvergence.reason}): ${emptyConvergence.message}`,
          );
          const report = formatConvergenceReport(
            emptyConvergence,
            convergenceState,
            convergenceConfig,
          );
          deps.logger.logWork(report);
          await postHumanEscalationNotice(deps, item, platform, owner, repo, report);
          deps.setLastPipelineExitCode(deps.exits.noChanges);
          deps.clearRunState(item.id);
          return;
        }
        continue;
      }

      // Convergence: did the rework actually change anything meaningful?
      const baseBranch = deps.getBaseBranch();
      const changedFilesThisRound = reworkHeadBefore.ok
        ? getChangedFiles(deps.workspace, reworkHeadBefore.stdout.trim(), "HEAD")
        : [];
      let reworkDiffStat = gitRunWithOutput(
        ["diff", `${baseBranch}...HEAD`, "--stat"],
        deps.workspace,
      );
      let reworkDiffContent = gitRunWithOutput(
        ["diff", `${baseBranch}...HEAD`],
        deps.workspace,
      );
      let reworkValidation = validateDiffBeforePush(
        reworkDiffStat.ok ? reworkDiffStat.stdout : "",
        reworkDiffContent.ok ? reworkDiffContent.stdout : "",
      );
      let prHadChanges = reworkValidation.valid;
      if (!prHadChanges) {
        deps.logger.logError(
          `Rework produced no meaningful changes (${reworkValidation.reason}) — empty PR cycle ${convergenceState.emptyPRCount + 1}`,
        );
        previousFailures.push("EMPTY_PR");
      }
      convergenceState = recordRoundFindings(convergenceState, [], prHadChanges, {
        changedFiles: changedFilesThisRound,
        diffStat: reworkDiffStat.ok ? summarizeDiffStat(reworkDiffStat.stdout) : "",
        note: prHadChanges
          ? "Aicoder produced a rework commit."
          : `Aicoder changes failed validation: ${reworkValidation.reason}`,
      });
      saveConvergenceState(convergenceState, item.id);
      if (!prHadChanges) {
        const convergence2 = checkConvergence(convergenceState, convergenceConfig);
        if (convergence2.shouldStop) {
          if (convergence2.recommendation === "requeue_different_prompt") {
            const decision = createConvergencePromptDecision(
              convergence2,
              buildPromptContext({
                codingPrompt: reworkPrompt,
                reviewerFindings: [],
                diffFromLastAttempt: reworkDiffContent.ok ? reworkDiffContent.stdout : "",
              }),
            );
            if (!decision.shouldEscalate) {
              recordPromptStrategy(decision.strategy);
              deps.logger.logWork(
                `Empty PR convergence selected prompt strategy ${decision.strategy}; retrying immediately`,
              );
              const retryResult = await deps.runAgent(
                await deps.buildAgentPrompt(decision.prompt, item),
              );
              if (!retryResult.finDetected && retryResult.exitCode !== 0) {
                deps.logger.logError(
                  `Recovery rework agent exited with code ${retryResult.exitCode} — stopping`,
                );
                return;
              }
              deps.saveRunState({
                ...currentState,
                checkpoint: "rework_agent_complete",
                reworkCount,
                sessionId: retryResult.sessionId,
                convergenceState: serializeConvergence(convergenceState),
                promptStrategiesTried: [...promptStrategiesTried],
              });
              if (
                !deps.stageAndCommit(`[AI] rework #${reworkCount} recovery: ${item.title}`)
              ) {
                deps.logger.logError("Recovery rework stage/commit failed");
                return;
              }
              reworkDiffStat = gitRunWithOutput(
                ["diff", `${baseBranch}...HEAD`, "--stat"],
                deps.workspace,
              );
              reworkDiffContent = gitRunWithOutput(
                ["diff", `${baseBranch}...HEAD`],
                deps.workspace,
              );
              reworkValidation = validateDiffBeforePush(
                reworkDiffStat.ok ? reworkDiffStat.stdout : "",
                reworkDiffContent.ok ? reworkDiffContent.stdout : "",
              );
              prHadChanges = reworkValidation.valid;
              if (prHadChanges) {
                deps.logger.logWork(
                  `Recovery prompt strategy ${decision.strategy} produced meaningful changes`,
                );
              } else {
                deps.logger.logError(
                  `Recovery prompt strategy ${decision.strategy} still produced no meaningful changes (${reworkValidation.reason})`,
                );
              }
            }
          }
          if (prHadChanges) {
            convergenceState = recordRoundFindings(convergenceState, [], true, {
              changedFiles: getChangedFiles(
                deps.workspace,
                reworkHeadBefore.ok ? reworkHeadBefore.stdout.trim() : baseBranch,
                "HEAD",
              ),
              diffStat: reworkDiffStat.ok ? summarizeDiffStat(reworkDiffStat.stdout) : "",
              note: "Recovery prompt produced meaningful changes.",
            });
            saveConvergenceState(convergenceState, item.id);
          } else {
            deps.logger.logError(
              `Convergence detected (${convergence2.reason}): ${convergence2.message}`,
            );
            deps.setLastPipelineExitCode(deps.exits.noChanges);
            const report = formatConvergenceReport(
              convergence2,
              convergenceState,
              convergenceConfig,
            );
            deps.logger.logWork(report);
            await postHumanEscalationNotice(deps, item, platform, owner, repo, report);
            deps.clearRunState(item.id);
            return;
          }
        }
      }

      deps.saveRunState({
        ...currentState,
        checkpoint: "rework_committed",
        reworkCount,
        convergenceState: serializeConvergence(convergenceState),
        promptStrategiesTried: [...promptStrategiesTried],
      });

      const reworkTestPassed = await deps.fixReworkTests(item, reworkCount);
      if (!reworkTestPassed) {
        previousFailures.push("TESTS_FAILING");
        deps.logger.logError("Rework tests could not be fixed — stopping");
        return;
      }

      deps.saveRunState({
        ...currentState,
        checkpoint: "rework_tests_passed",
        reworkCount,
        convergenceState: serializeConvergence(convergenceState),
        promptStrategiesTried: [...promptStrategiesTried],
      });

      if (!deps.pushBranch(item.suggestedBranch, { forceWithLease: true })) {
        deps.logger.logError("Rework push failed");
        return;
      }

      sinceTimestamp = new Date().toISOString();
      deps.saveRunState({
        ...currentState,
        checkpoint: "rework_pushed",
        reworkCount,
        sinceTimestamp,
        prNumber,
        convergenceState: serializeConvergence(convergenceState),
        promptStrategiesTried: [...promptStrategiesTried],
      });

      deps.logger.logConfig(
        `Rework pushed for ${label} #${prNumber} — waiting for review again`,
      );
      continue;
    }

    // Unknown result — keep polling.
    await new Promise((r) => setTimeout(r, deps.reviewPollMs));
  }
}
