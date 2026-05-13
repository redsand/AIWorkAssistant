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
export const EXIT_WHITESPACE_ONLY = 8;  // only whitespace changes
export const EXIT_META_ONLY = 9;        // only meta file changes (.gitignore, etc.)

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

// ── Pre-push diff validation ──────────────────────────────────────────────────

/**
 * Files that are purely metadata / configuration with no functional impact.
 * Changes confined to these files should not produce a PR.
 */
const META_FILE_PATTERNS = [
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".prettierrc",
  ".prettierignore",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintignore",
  "tsconfig.json",
  "tsconfig.*.json",
  "jest.config.js",
  "jest.config.ts",
  "vitest.config.ts",
  "vitest.config.js",
  ".mocharc.yml",
  ".nvmrc",
  ".python-version",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Gemfile.lock",
  "poetry.lock",
  "Cargo.lock",
];

function isMetaFile(filePath: string): boolean {
  const basename = filePath.replace(/.*\//, "");
  return META_FILE_PATTERNS.includes(basename);
}

export interface DiffValidationResult {
  valid: boolean;
  stats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  reason?: string;
  exitCode: number;
}

/**
 * Validate that a branch has meaningful changes before pushing / creating a PR.
 *
 * Checks:
 *  1. NO_CHANGES — zero files changed
 *  2. WHITESPACE_ONLY — all added lines are whitespace (no functional change)
 *  3. META_ONLY — all changed files are meta/config files
 *  4. Otherwise valid
 */
export function validateDiffBeforePush(
  diffStat: string,
  diffContent: string,
): DiffValidationResult {
  const emptyStats = { filesChanged: 0, insertions: 0, deletions: 0 };

  // 1. Empty diff — no changes at all
  const stat = diffStat.trim();
  if (!stat) {
    return { valid: false, stats: emptyStats, reason: "NO_CHANGES", exitCode: EXIT_NO_CHANGES };
  }

  // Parse --stat output for file count, insertions, deletions
  // Format: " file1 | 5 ++--\n file2 | 3 ++-\n 2 files changed, 5 insertions(+), 3 deletions(-)"
  const summaryLine = stat.split("\n").pop() || "";
  const filesMatch = summaryLine.match(/(\d+) files? changed/);
  const insMatch = summaryLine.match(/(\d+) insertion/);
  const delMatch = summaryLine.match(/(\d+) deletion/);

  const filesChanged = filesMatch ? parseInt(filesMatch[1], 10) : 0;
  const insertions = insMatch ? parseInt(insMatch[1], 10) : 0;
  const deletions = delMatch ? parseInt(delMatch[1], 10) : 0;
  const stats = { filesChanged, insertions, deletions };

  if (filesChanged === 0) {
    return { valid: false, stats: emptyStats, reason: "NO_CHANGES", exitCode: EXIT_NO_CHANGES };
  }

  // 2. Parse added lines and check for whitespace-only changes
  const addedLines = diffContent
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"));

  if (addedLines.length === 0) {
    // Only deletions — that's a real change
    return { valid: true, stats, exitCode: EXIT_SUCCESS, reason: "ok (deletions only)" };
  }

  const nonWhitespaceAdded = addedLines.filter((l) => l.trim().length > 1); // "+" plus content
  if (nonWhitespaceAdded.length === 0) {
    return { valid: false, stats, reason: "WHITESPACE_ONLY", exitCode: EXIT_WHITESPACE_ONLY };
  }

  // 3. Check if all changed files are meta/config files
  // Parse file paths from the diff: lines like "diff --git a/path b/path"
  const changedFiles = diffContent
    .split("\n")
    .filter((l) => l.startsWith("diff --git "))
    .map((l) => {
      // "diff --git a/src/foo.ts b/src/foo.ts" -> "src/foo.ts"
      const match = l.match(/^diff --git a\/(.+?) b\//);
      return match ? match[1] : "";
    })
    .filter(Boolean);

  if (changedFiles.length > 0 && changedFiles.every(isMetaFile)) {
    return { valid: false, stats, reason: "META_ONLY", exitCode: EXIT_META_ONLY };
  }

  // 4. Legitimate changes
  return { valid: true, stats, exitCode: EXIT_SUCCESS, reason: "ok" };
}
