/**
 * Exit code constants and pure output-validation logic for aicoder.
 *
 * Kept in a separate module so tests can import the pure functions
 * without triggering aicoder.ts's module-level side effects (config
 * loading, logger setup, etc.).
 */

// ── Exit codes ────────────────────────────────────────────────────────────────
// 0 and 1 follow UNIX convention (success / generic error).
// 2-7 are domain-specific; the autonomous-loop orchestrator reads these
// to decide whether to re-queue, escalate, or mark a ticket done.
export const EXIT_SUCCESS = 0;
export const EXIT_NO_CHANGES = 2;       // agent ran but produced no file changes
export const EXIT_PLACEHOLDER_ONLY = 3; // agent produced only stub/TODO content
export const EXIT_GIT_FAILURE = 4;      // git commit, push, or rebase failed
export const EXIT_TEST_FAILURE = 5;     // test suite failed after agent changes
export const EXIT_REVIEW_FAILED = 6;    // PR flagged for human review (unresolvable)
export const EXIT_MAX_REWORK = 7;       // rework cycle limit exceeded

// ── Pure validation logic ─────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  exitCode: number;
  reason: string;
}

/**
 * Lines added by the agent that are unambiguously stubs with no real logic.
 *
 * A stub line BEGINS with a comment character after the `+` — that's what
 * distinguishes `+// TODO: implement` (stub) from `+  doSomething(); // TODO`
 * (real code with an inline note). Only pure comment-lines are counted.
 */
const STUB_LINE_RE = /^\+\s*(\/\/|#)\s*(TODO|FIXME|PLACEHOLDER)\b/i;

/**
 * Validate agent output from the git diff of the feature branch vs its base.
 *
 * @param diffStat   stdout of `git diff <base>...HEAD --stat`
 * @param diffContent stdout of `git diff <base>...HEAD`
 * @param skipAgent  true when --skip-agent was passed (committing existing changes)
 */
export function validateOutputFromDiff(
  diffStat: string,
  diffContent: string,
  skipAgent: boolean,
): ValidationResult {
  // --skip-agent: user is committing whatever is already present.
  // Empty diff is expected and not an error.
  if (skipAgent) {
    return { valid: true, exitCode: EXIT_SUCCESS, reason: "skip-agent: output validation bypassed" };
  }

  const stat = diffStat.trim();

  // No files changed vs base branch.
  if (!stat) {
    return { valid: false, exitCode: EXIT_NO_CHANGES, reason: "no file changes vs base branch" };
  }

  // Parse added lines from the unified diff.
  const addedLines = diffContent
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"));

  if (addedLines.length === 0) {
    // Files were deleted only — that is a real change.
    return { valid: true, exitCode: EXIT_SUCCESS, reason: "ok (deletions only)" };
  }

  // Only flag PLACEHOLDER_ONLY when the output is almost entirely stubs.
  // Threshold: >80% of added lines are stub markers AND at least 5 lines
  // (tiny diffs like a 1-line TODO in a real change should not be blocked).
  const stubLines = addedLines.filter((l) => STUB_LINE_RE.test(l));
  if (stubLines.length >= 5 && stubLines.length / addedLines.length > 0.8) {
    return {
      valid: false,
      exitCode: EXIT_PLACEHOLDER_ONLY,
      reason: `${stubLines.length}/${addedLines.length} added lines are stubs`,
    };
  }

  return { valid: true, exitCode: EXIT_SUCCESS, reason: "ok" };
}
