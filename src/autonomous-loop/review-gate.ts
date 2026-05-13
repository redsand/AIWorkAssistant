/**
 * Review gate — prevents Jira "Done" transition when unresolved
 * critical or high findings remain from the review cycle.
 *
 * This is the safety net that ensures a ticket marked "Done" actually
 * means done. Without it, the autonomous loop can close tickets with
 * unfixed bugs, burning reviewer trust and making Jira status unreliable.
 *
 * The gate reads from convergence state (finding hashes with severity
 * info) and can be overridden with --force-done for manual intervention.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReviewGateFinding {
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  file: string;
  message: string;
}

export interface ReviewGateConfig {
  /** Minimum severity that blocks Done (default: "high") */
  blockOnSeverity: "critical" | "high" | "medium" | "low";
  /** Categories that always block regardless of severity (default: ["security"]) */
  alwaysBlockCategories: string[];
  /** Whether to block when no review has occurred (default: true) */
  blockOnNoReview: boolean;
}

export const DEFAULT_GATE_CONFIG: ReviewGateConfig = {
  blockOnSeverity: "high",
  alwaysBlockCategories: ["security"],
  blockOnNoReview: true,
};

export interface ReviewGateResult {
  canMarkDone: boolean;
  blockedBy: string[];
  criticalCount: number;
  highCount: number;
}

export interface ReviewGateState {
  /** Findings from the most recent review round */
  lastFindings: ReviewGateFinding[];
  /** Whether at least one review has occurred */
  reviewOccurred: boolean;
  /** Whether the --force-done flag was used to override */
  forceDoneUsed: boolean;
  /** Timestamp of when force-done was applied */
  forceDoneAt?: string;
}

// ── Review gate logic ─────────────────────────────────────────────────────────

/**
 * Check whether a ticket can be marked as "Done" based on the last
 * review findings.
 *
 * Blocking rules (evaluated per finding, first match wins):
 *  1. severity >= config.blockOnSeverity → blocked
 *  2. finding.category in config.alwaysBlockCategories → blocked (security
 *     findings always block regardless of severity)
 *
 * @param findings      Findings from the last review round
 * @param forceDone     Whether the --force-done override was specified
 * @param reviewOccurred Whether at least one review has completed
 * @param config        Gate configuration (defaults to DEFAULT_GATE_CONFIG)
 */
export function reviewGate(
  findings: ReviewGateFinding[],
  forceDone: boolean = false,
  reviewOccurred: boolean = true,
  config: ReviewGateConfig = DEFAULT_GATE_CONFIG,
): ReviewGateResult {
  if (forceDone) {
    return { canMarkDone: true, blockedBy: [], criticalCount: 0, highCount: 0 };
  }

  if (!reviewOccurred && config.blockOnNoReview) {
    return { canMarkDone: false, blockedBy: ["No review found"], criticalCount: 0, highCount: 0 };
  }

  const severityOrder: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
  const blockThreshold = severityOrder[config.blockOnSeverity] ?? 3;

  const blocked = findings.filter((f) => {
    const score = severityOrder[f.severity] ?? 0;
    return score >= blockThreshold || config.alwaysBlockCategories.includes(f.category);
  });

  const criticalCount = blocked.filter((f) => f.severity === "critical").length;
  const highCount = blocked.filter((f) => f.severity === "high").length;
  const blockedBy = blocked.map((f) => `[${f.severity.toUpperCase()}] ${f.file}: ${f.message}`);

  return { canMarkDone: blocked.length === 0, blockedBy, criticalCount, highCount };
}

/**
 * Format a review gate blockage as a Jira comment.
 */
export function formatGateBlockComment(result: ReviewGateResult): string {
  const otherCount = result.blockedBy.length - result.criticalCount - result.highCount;
  const parts: string[] = [];
  if (result.criticalCount > 0) parts.push(`${result.criticalCount} critical`);
  if (result.highCount > 0) parts.push(`${result.highCount} high`);
  if (otherCount > 0) parts.push(`${otherCount} other`);
  const summary = parts.join(" and ") || `${result.blockedBy.length}`;
  const plural = result.blockedBy.length !== 1;

  const lines = [
    `**Cannot mark as Done**: ${summary} finding${plural ? "s" : ""} remain${plural ? "" : "s"} unresolved.`,
    ``,
    `The autonomous loop will not transition this ticket to Done until the findings below are addressed.`,
    ``,
    ...result.blockedBy.map((b) => `- ${b}`),
    ``,
    `Use \`--force-done\` to override this gate (audited).`,
  ];

  return lines.join("\n");
}

/**
 * Initialize an empty review gate state.
 */
export function initReviewGateState(): ReviewGateState {
  return {
    lastFindings: [],
    reviewOccurred: false,
    forceDoneUsed: false,
  };
}

/**
 * Update review gate state with findings from a new review round.
 * Preserves forceDone flag if it was set.
 */
export function updateGateState(
  state: ReviewGateState,
  findings: ReviewGateFinding[],
): ReviewGateState {
  return {
    lastFindings: findings,
    reviewOccurred: true,
    forceDoneUsed: state.forceDoneUsed,
    forceDoneAt: state.forceDoneAt,
  };
}