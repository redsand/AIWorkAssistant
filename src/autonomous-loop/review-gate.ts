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
 * review findings. Critical and high severity findings block the
 * transition; medium and low are advisory but not blocking.
 *
 * @param findings  Findings from the last review round (may be empty
 *                  if no review occurred, which blocks Done by default)
 * @param forceDone Whether the --force-done override was specified
 */
export function reviewGate(
  findings: ReviewGateFinding[],
  forceDone: boolean = false,
  reviewOccurred: boolean = true,
): ReviewGateResult {
  if (forceDone) {
    return {
      canMarkDone: true,
      blockedBy: [],
      criticalCount: 0,
      highCount: 0,
    };
  }

  // No review occurred — cannot trust that the code is done
  if (!reviewOccurred) {
    return {
      canMarkDone: false,
      blockedBy: ["No review found"],
      criticalCount: 0,
      highCount: 0,
    };
  }

  const criticals = findings.filter(
    (f) => f.severity === "critical",
  );
  const highs = findings.filter(
    (f) => f.severity === "high",
  );

  const blockedBy = [...criticals, ...highs].map(
    (f) => `[${f.severity.toUpperCase()}] ${f.file}: ${f.message}`,
  );

  return {
    canMarkDone: criticals.length === 0 && highs.length === 0,
    blockedBy,
    criticalCount: criticals.length,
    highCount: highs.length,
  };
}

/**
 * Format a review gate blockage as a Jira comment.
 */
export function formatGateBlockComment(result: ReviewGateResult): string {
  const lines = [
    `**Cannot mark as Done**: ${result.criticalCount} critical and ${result.highCount} high findings remain unresolved.`,
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