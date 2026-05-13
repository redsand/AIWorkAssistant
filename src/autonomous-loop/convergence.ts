/**
 * Convergence detection for the autonomous loop.
 *
 * Prevents the rework loop from running indefinitely by detecting:
 *  - Identical findings repeated across rounds (reviewer stuck)
 *  - Consecutive empty PRs (agent producing no changes)
 *  - Rounds with no progress (same unresolved findings)
 *  - Hard round cap
 *
 * Pure functions — no side effects, no I/O. All state is passed in.
 */

import {
  generatePrompt,
  selectStrategy,
  type PromptContext,
  type PromptStrategy,
} from "./prompt-strategies";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConvergenceConfig {
  /** Hard cap on total rework rounds (default: 5) */
  maxRounds: number;
  /** Same finding hash posted N times → stop (default: 2) */
  maxIdenticalFindings: number;
  /** N consecutive empty PRs → stop (default: 2) */
  maxEmptyPRs: number;
  /** N rounds with no new findings resolved → stop (default: 3) */
  maxNoProgressRounds: number;
}

export const DEFAULT_CONVERGENCE_CONFIG: ConvergenceConfig = {
  maxRounds: 5,
  maxIdenticalFindings: 2,
  maxEmptyPRs: 2,
  maxNoProgressRounds: 3,
};

export interface ConvergenceState {
  roundNumber: number;
  /** Hashed finding summaries from each round (one hash per finding) */
  previousFindings: string[];
  /** Finding hash → count of how many rounds it appeared in */
  identicalCount: Map<string, number>;
  /** Consecutive empty PRs (reset when a PR has real changes) */
  emptyPRCount: number;
  /** Findings resolved in the most recent round */
  findingsResolved: number;
  /** New findings in the most recent round */
  findingsNew: number;
  /** Consecutive rounds with zero progress (no new resolved findings) */
  noProgressCount: number;
  /** Set of finding hashes seen in the PREVIOUS round (for delta detection) */
  lastRoundFindings: Set<string>;
}

export type StopReason =
  | "max_rounds"
  | "identical_findings"
  | "empty_prs"
  | "no_progress"
  | "converged";

export type Recommendation =
  | "escalate_human"
  | "requeue_different_prompt"
  | "mark_done"
  | "continue";

export interface ConvergenceResult {
  shouldStop: boolean;
  reason: StopReason;
  message: string;
  recommendation: Recommendation;
}

export interface ConvergencePromptDecision {
  strategy: PromptStrategy;
  prompt: string;
  shouldEscalate: boolean;
}

// ── Finding hashing ───────────────────────────────────────────────────────────

/**
 * Normalize a finding to a stable hash string.
 * Uses file + severity + category so that cosmetic differences in
 * the finding message don't create spurious new hashes.
 */
export function hashFinding(finding: {
  file?: string;
  severity?: string;
  category?: string;
  message?: string;
}): string {
  const parts = [
    finding.file?.trim() || "",
    (finding.severity ?? "unknown").toLowerCase().trim(),
    (finding.category ?? "unknown").toLowerCase().trim(),
  ];
  return parts.join("::");
}

// ── State management ──────────────────────────────────────────────────────────

export function initConvergenceState(): ConvergenceState {
  return {
    roundNumber: 0,
    previousFindings: [],
    identicalCount: new Map(),
    emptyPRCount: 0,
    findingsResolved: 0,
    findingsNew: 0,
    noProgressCount: 0,
    lastRoundFindings: new Set(),
  };
}

/**
 * Record the findings from a completed review round.
 * Updates identical counts and computes delta (resolved vs new).
 */
export function recordRoundFindings(
  state: ConvergenceState,
  findings: Array<{ file?: string; severity?: string; category?: string; message?: string }>,
  prHadChanges: boolean,
): ConvergenceState {
  const currentHashes = new Set(findings.map(hashFinding));

  // Find findings that were in the last round but NOT in this round (resolved)
  const resolved = [...state.lastRoundFindings].filter((h) => !currentHashes.has(h)).length;

  // Find findings that are new (not in previousFindings history)
  const newFindings = [...currentHashes].filter((h) => !state.previousFindings.includes(h)).length;

  // Update identical counts: for each current finding, increment its count
  const newIdenticalCount = new Map(state.identicalCount);
  for (const hash of currentHashes) {
    newIdenticalCount.set(hash, (newIdenticalCount.get(hash) ?? 0) + 1);
  }

  // Track no-progress: a round has "progress" if at least one finding was resolved
  const hadProgress = resolved > 0;
  const newNoProgressCount = hadProgress ? 0 : state.noProgressCount + 1;

  return {
    roundNumber: state.roundNumber + 1,
    previousFindings: [...new Set([...state.previousFindings, ...currentHashes])],
    identicalCount: newIdenticalCount,
    emptyPRCount: prHadChanges ? 0 : state.emptyPRCount + 1,
    findingsResolved: resolved,
    findingsNew: newFindings,
    noProgressCount: newNoProgressCount,
    lastRoundFindings: currentHashes,
  };
}

// ── Convergence check ──────────────────────────────────────────────────────────

/**
 * Check whether the loop should stop based on convergence criteria.
 *
 * Evaluation order (first match wins):
 *  1. maxRounds exceeded
 *  2. identical_findings threshold hit
 *  3. empty_prs threshold hit
 *  4. no_progress threshold hit
 *  5. All findings from the previous round resolved (converged)
 *  6. Otherwise: continue
 */
export function checkConvergence(
  state: ConvergenceState,
  config: ConvergenceConfig,
): ConvergenceResult {
  // 1. Hard round cap
  if (state.roundNumber > config.maxRounds) {
    return {
      shouldStop: true,
      reason: "max_rounds",
      message: `Exceeded max rework rounds (${config.maxRounds}). Loop stopped after ${state.roundNumber} rounds.`,
      recommendation: "escalate_human",
    };
  }

  // 2. Identical findings: any single finding seen more than maxIdenticalFindings times
  const stuckFindings = [...state.identicalCount.entries()]
    .filter(([, count]) => count > config.maxIdenticalFindings);

  if (stuckFindings.length > 0) {
    const hashes = stuckFindings.map(([hash, count]) => `${hash} (${count}x)`).join(", ");
    return {
      shouldStop: true,
      reason: "identical_findings",
      message: `Identical findings repeated across rounds: ${hashes}. Reviewer is not producing actionable or new findings.`,
      recommendation: "escalate_human",
    };
  }

  // 3. Consecutive empty PRs
  if (state.emptyPRCount > config.maxEmptyPRs) {
    return {
      shouldStop: true,
      reason: "empty_prs",
      message: `${state.emptyPRCount} consecutive PRs with no changes. Agent is not producing meaningful diffs.`,
      recommendation: "requeue_different_prompt",
    };
  }

  // 4. No progress: multiple rounds without resolving any findings
  if (state.noProgressCount >= config.maxNoProgressRounds) {
    return {
      shouldStop: true,
      reason: "no_progress",
      message: `${state.noProgressCount} consecutive rounds with no findings resolved. The loop is not converging.`,
      recommendation: "escalate_human",
    };
  }

  // 5. All previous findings resolved (convergence)
  if (state.roundNumber > 0 && state.lastRoundFindings.size === 0 && state.findingsResolved > 0) {
    return {
      shouldStop: false,
      reason: "converged",
      message: `All findings from previous rounds have been resolved. Loop converged after ${state.roundNumber} rounds.`,
      recommendation: "mark_done",
    };
  }

  // 6. Continue
  return {
    shouldStop: false,
    reason: "converged",
    message: `Round ${state.roundNumber}: ${state.findingsNew} new findings, ${state.findingsResolved} resolved. Continuing.`,
    recommendation: "continue",
  };
}

// ── Convergence report (for posting to Jira/ticket) ───────────────────────────

export function formatConvergenceReport(
  result: ConvergenceResult,
  state: ConvergenceState,
  config: ConvergenceConfig,
): string {
  const lines = [
    `**Autonomous Loop Convergence Report**`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Rounds completed | ${state.roundNumber} |`,
    `| Max rounds allowed | ${config.maxRounds} |`,
    `| Findings resolved | ${state.findingsResolved} |`,
    `| New findings | ${state.findingsNew} |`,
    `| Consecutive no-progress rounds | ${state.noProgressCount} |`,
    `| Consecutive empty PRs | ${state.emptyPRCount} |`,
    `| Stuck findings (>${config.maxIdenticalFindings} occurrences) | ${[...state.identicalCount.entries()].filter(([, c]) => c > config.maxIdenticalFindings).length} |`,
    ``,
    `**Reason**: ${result.reason}`,
    `**Action**: ${result.recommendation}`,
    ``,
    result.message,
  ];

  return lines.join("\n");
}

export function createConvergencePromptDecision(
  result: ConvergenceResult,
  context: PromptContext,
): ConvergencePromptDecision {
  const strategy = result.recommendation === "requeue_different_prompt"
    ? selectStrategy(context)
    : "escalate_human";

  return {
    strategy,
    prompt: generatePrompt(strategy, context),
    shouldEscalate: strategy === "escalate_human",
  };
}
