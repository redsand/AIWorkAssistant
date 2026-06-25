/**
 * Heuristic that decides whether a test failure is related to the code
 * just changed. Extracted from src/aicoder.ts (2026-06-25). Used to
 * short-circuit the test-fix loop when failures appear unrelated to the
 * agent's changes (pre-existing e2e flakes, etc.).
 *
 * Three signals (in order of confidence):
 *   1. File paths in test output ∩ changed files → related
 *   2. e2e/integration/workflow failure + no test changes → unrelated
 *   3. Anything else → uncertain, attempt fix
 *
 * Name kept as `classify*` (not `llmEvaluate*`) to reflect that it's
 * regex/heuristic only — no LLM call despite the legacy name in the
 * original.
 */
import { gitRunWithOutput } from "../autonomous-loop/git-ops";

export interface TestFailureLogger {
  logConfig(message: string): void;
}

const FILE_REF_PATTERN =
  /(?:at\s+)?([\w./\-]+\.(?:ts|js|tsx|jsx|py|go|rs)):\d+/g;
const E2E_PATTERN = /e2e|workflow|integration/i;
const TEST_FILE_PATTERN = /\/test\/|\.test\.|\.spec\./;

/**
 * Returns true when the failures look unrelated to the agent's changes
 * (so the caller should proceed rather than spin on an unfixable fail).
 * Returns false when fix is warranted or uncertain.
 */
export async function classifyTestFailure(
  logger: TestFailureLogger,
  workspace: string,
  testOutput: string,
): Promise<boolean> {
  const diffResult = gitRunWithOutput(["diff", "--name-only", "HEAD~1"], workspace);
  const changedFiles = diffResult.ok ? diffResult.stdout : "";

  const failedFiles = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = FILE_REF_PATTERN.exec(testOutput)) !== null) {
    failedFiles.add(match[1]);
  }
  // exec retains lastIndex across calls — reset for next invocation.
  FILE_REF_PATTERN.lastIndex = 0;

  // 1. Explicit non-overlap → unrelated
  if (failedFiles.size > 0 && changedFiles.length > 0) {
    const changedSet = new Set(
      changedFiles.split("\n").map((f) => f.trim()).filter(Boolean),
    );
    const overlap = [...failedFiles].some(
      (f) => changedSet.has(f) || changedSet.has(f.replace(/^.*\//, "")),
    );
    if (!overlap) {
      logger.logConfig(
        `Test failures appear in unrelated files (failed: ${[...failedFiles].join(", ")}) — proceeding`,
      );
      return true;
    }
  }

  // 2. e2e failure + no test changes → likely pre-existing
  const isE2E = E2E_PATTERN.test(testOutput.slice(0, 2000));
  const hasTestChanges = changedFiles
    .split("\n")
    .some((f) => TEST_FILE_PATTERN.test(f));
  if (isE2E && !hasTestChanges) {
    logger.logConfig(
      "E2E test failures detected but no test files changed — likely pre-existing, proceeding",
    );
    return true;
  }

  // 3. Uncertain — fall through to fix attempt
  logger.logConfig("Unclear if test failures are related — will attempt fix");
  return false;
}
