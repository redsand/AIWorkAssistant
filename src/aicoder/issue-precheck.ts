/**
 * Pre-flight checks that decide whether `processWorkItem` should even
 * start work on a given issue. Extracted from src/aicoder.ts (2026-06-26)
 * so the gating logic is testable in isolation and processWorkItem's
 * body shrinks.
 *
 * Returns `{ skip: true }` when any check fires — caller should log the
 * `reason` (if any) and return early. `force` is the runtime --force flag
 * which bypasses most (but not all) checks. The in-process retry
 * circuit-breaker fires even with --force so a tight crash loop in the
 * same PID can't keep retrying forever.
 *
 * Side effects on the convergence-blacklist path:
 *   - calls `saveProcessedIssue(issueKey)` to lock the issue out of
 *     future cycles
 * Side effects on the too-many-failures path:
 *   - increments the failed-attempt counter; if it crosses the cap,
 *     calls `blacklistIssue` + `clearFailedAttempt` + `saveProcessedIssue`
 *
 * Anything more invasive (run-state creation, agent-runs record,
 * dependency resolution) stays in processWorkItem.
 */
import type {
  ConvergenceConfig,
  ConvergenceState,
} from "../autonomous-loop/convergence";

export interface IssuePrecheckLogger {
  logSkip(message: string): void;
  logError(message: string): void;
  logConfig(message: string): void;
}

export interface IssuePrecheckConvergence {
  loadConvergenceState: (issueKey: string) => ConvergenceState;
  checkConvergence: (
    state: ConvergenceState,
    config: ConvergenceConfig,
  ) => { shouldStop: boolean; reason?: string };
  config: ConvergenceConfig;
}

export interface IssuePrecheckDeps {
  logger: IssuePrecheckLogger;
  workspace: string;
  force: boolean;
  maxFailedAttempts: number;

  infrastructureBlockedIssues: Set<string>;
  processedIssues: { has: (key: string) => boolean; delete: (key: string) => void };
  checkProcessRetryCircuit: (issueKey: string) => string | null | undefined;

  agentRunDatabase: {
    isIssueBlacklisted: (issueKey: string, workspace: string) => boolean;
    incrementFailedAttempt: (issueKey: string, workspace: string) => number;
    blacklistIssue: (issueKey: string, workspace: string, reason: string) => void;
    clearFailedAttempt: (issueKey: string, workspace: string) => void;
    unmarkIssueProcessed: (issueKey: string) => void;
  };

  saveProcessedIssue: (issueKey: string) => void;
  convergence: IssuePrecheckConvergence;
}

export interface IssuePrecheckResult {
  skip: boolean;
  reason?: string;
}

export function shouldSkipIssue(
  deps: IssuePrecheckDeps,
  issueKey: string,
): IssuePrecheckResult {
  if (deps.infrastructureBlockedIssues.has(issueKey)) {
    const reason = `Issue ${issueKey} has an agent infrastructure failure in this run — skipping to avoid a retry loop`;
    deps.logger.logSkip(reason);
    return { skip: true, reason };
  }

  // Process-local circuit breaker — fires even with --force, so a tight
  // crash loop can't keep retrying forever in the same PID.
  const circuitReason = deps.checkProcessRetryCircuit(issueKey);
  if (circuitReason) {
    deps.logger.logSkip(circuitReason);
    return { skip: true, reason: circuitReason };
  }

  if (deps.processedIssues.has(issueKey) && !deps.force) {
    const reason = `Issue ${issueKey} already processed (use --force to re-process)`;
    deps.logger.logSkip(reason);
    return { skip: true, reason };
  }

  // Blacklist pre-check: permanently skip issues that failed too many times
  if (
    !deps.force &&
    deps.agentRunDatabase.isIssueBlacklisted(issueKey, deps.workspace)
  ) {
    const reason = `Issue ${issueKey} is blacklisted after repeated failures — skipping (use --force to override)`;
    deps.logger.logSkip(reason);
    return { skip: true, reason };
  }

  // Convergence pre-check: if a previous run already determined this issue
  // is stuck (no progress across multiple rounds), refuse to re-run even if
  // the reviewer re-added the ready-for-agent label. --force overrides.
  if (!deps.force) {
    const existingConvergence = deps.convergence.loadConvergenceState(issueKey);
    if (existingConvergence.roundNumber > 0) {
      const convergenceCheck = deps.convergence.checkConvergence(
        existingConvergence,
        deps.convergence.config,
      );
      if (convergenceCheck.shouldStop) {
        const reason =
          `Skipping ${issueKey} — convergence already fired (${convergenceCheck.reason}). ` +
          `Round ${existingConvergence.roundNumber}, no-progress count: ${existingConvergence.noProgressCount}. ` +
          `Use --force to override.`;
        deps.logger.logError(reason);
        deps.saveProcessedIssue(issueKey);
        return { skip: true, reason };
      }
    }
  }

  // Track consecutive failures — after maxFailedAttempts, blacklist
  // permanently to stop the retry loop.
  const attempts = deps.agentRunDatabase.incrementFailedAttempt(
    issueKey,
    deps.workspace,
  );
  if (attempts >= deps.maxFailedAttempts) {
    const reason = `Issue ${issueKey} failed ${attempts} times — blacklisting to stop retry loop`;
    deps.logger.logError(reason);
    deps.saveProcessedIssue(issueKey);
    deps.agentRunDatabase.blacklistIssue(
      issueKey,
      deps.workspace,
      `Failed ${attempts} consecutive times`,
    );
    deps.agentRunDatabase.clearFailedAttempt(issueKey, deps.workspace);
    return { skip: true, reason };
  }

  if (deps.force && deps.processedIssues.has(issueKey)) {
    deps.logger.logConfig(`Force re-processing issue ${issueKey} (--force)`);
    deps.processedIssues.delete(issueKey);
    deps.agentRunDatabase.unmarkIssueProcessed(issueKey);
  }

  return { skip: false };
}
