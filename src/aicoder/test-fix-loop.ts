/**
 * Test-fix retry orchestrators extracted from src/aicoder.ts (2026-06-26).
 *
 * Three loops, same shape:
 *   - fixBaselineTests: ran before the agent does new work. Quick-path
 *     detects missing-package errors and runs the package manager
 *     directly (no agent burn) before falling through to the fix loop.
 *   - fixCoverageGap: ran after agent work to bring coverage back up.
 *   - fixReworkTests / attemptTestFix: ran after a review-rework cycle.
 *
 * Every loop follows the same pattern: build a prompt → run agent →
 * commit → retest. Differences are cosmetic (max attempts, log labels,
 * whether to classify "unrelated failure" as success).
 *
 * Dependencies are injected via a single TestFixDeps object so callers
 * in tests can use fakes without standing up the full aicoder process.
 */
import type {
  TestSuiteKind,
  TestSuiteResult,
  WorkItem,
} from "../autonomous-loop/types";
import { buildBaselineFixPrompt, buildCoverageFixPrompt } from "./fix-prompts";
import type { TestFailureLogger } from "./test-failure-classifier";

export interface TestFixLogger extends TestFailureLogger {
  logWork(message: string): void;
  logError(message: string): void;
  log(level: string, message: string): void;
}

/**
 * Coverage helpers return a narrower shape than full test results — no
 * exitCode/signal, output is optional. Local re-declaration keeps the
 * test-fix-loop module decoupled from autonomous-loop's exact coverage
 * return shape.
 */
export interface CoverageResult {
  passed: boolean;
  output?: string;
  kind?: TestSuiteResult["kind"];
}

export interface AgentCallResult {
  finDetected: boolean;
  exitCode: number | null;
  stderr?: string;
}

export interface PackageManagerInfo {
  pm: "npm" | "pnpm" | "yarn";
  install(): { success: boolean; command: string; exitCode: number | null };
}

export interface TestFixDeps {
  logger: TestFixLogger;
  /** Resolved project config — testCommand / coverageCommand / hasTests. */
  hasTests: boolean;
  testCommand: string;
  coverageCommand: string;
  /** Limits — passed from aicoder.ts module-level constants. */
  skipTests: boolean;
  baselineMaxFixAttempts: number;
  coverageMaxFixAttempts: number;
  reworkMaxFixAttempts: number;
  maxRework: number;
  /** Callbacks the loops invoke. */
  runAgent: (prompt: string) => Promise<AgentCallResult>;
  stageAndCommit: (message: string) => boolean;
  runTestSuite: (kind: TestSuiteKind) => TestSuiteResult;
  checkCoverage: () => CoverageResult;
  classifyTestFailure: (output: string) => Promise<boolean>;
  detectPackageManager: () => "npm" | "pnpm" | "yarn";
  runPackageInstall: (
    pm: "npm" | "pnpm" | "yarn",
  ) => { success: boolean; command: string; exitCode: number | null };
}

// Regex for `Cannot find package 'X'` / `Cannot find module 'X'` patterns.
// Captures both bare names and scoped (@org/pkg) — the latter via the
// non-capturing group at the start.
const MISSING_PACKAGE_RE =
  /Cannot find (?:package|module)\s+['"]((?:@[^/'"\s]+\/)?[^/'"\s]+)['"]/gi;

/**
 * Run the test suite. If it passes, return true. If it fails, attempt a
 * quick `npm install` for any missing-package errors before escalating
 * to the agent fix loop. Returns true on success or on env-level
 * issues we can't fix (test runner missing). Returns false when the
 * fix loop exhausts attempts.
 */
export async function fixBaselineTests(
  deps: TestFixDeps,
  item: WorkItem,
): Promise<boolean> {
  if (!deps.hasTests) {
    deps.logger.logConfig("No test infrastructure detected — skipping baseline check");
    return true;
  }

  deps.logger.logWork("Running baseline test check before agent starts");

  const baseline = deps.runTestSuite("all");
  if (baseline.passed) {
    deps.logger.logConfig("Baseline tests passed — proceeding");
    return true;
  }
  if (baseline.kind === "timeout") {
    deps.logger.logError(
      "Baseline tests timed out — cannot auto-fix a timeout. Increase timeout or investigate workspace setup.",
    );
    return false;
  }
  if (baseline.kind === "spawn_error") {
    deps.logger.logError(`Baseline tests could not start: ${baseline.error}`);
    deps.logger.logConfig("Proceeding without baseline tests — test runner unavailable in workspace");
    return true;
  }

  deps.logger.logError("Baseline tests FAILED — attempting to fix");

  // Pre-agent quick-fix: scan for "Cannot find package X" patterns and
  // run the package manager directly. Saves agent cycles on trivial
  // missing-dep errors.
  const missingPackages = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = MISSING_PACKAGE_RE.exec(baseline.output)) !== null) {
    missingPackages.add(match[1]);
  }
  MISSING_PACKAGE_RE.lastIndex = 0;

  if (missingPackages.size > 0) {
    const pkgs = [...missingPackages].join(", ");
    deps.logger.logWork(`Missing packages detected: ${pkgs} — installing`);
    const pm = deps.detectPackageManager();
    const installResult = deps.runPackageInstall(pm);
    if (installResult.success) {
      deps.logger.logConfig(
        `Ran ${installResult.command} — re-running baseline tests`,
      );
      const retest = deps.runTestSuite("all");
      if (retest.passed) {
        deps.logger.logConfig("Baseline tests pass after package install — proceeding");
        return true;
      }
      deps.logger.logWork(
        "Baseline tests still failing after package install — trying agent fix",
      );
    } else {
      deps.logger.logWork(
        `Package install failed (exit ${installResult.exitCode}) — falling through to agent fix`,
      );
    }
  }

  let attempts = 0;
  const maxAttempts = Math.min(deps.baselineMaxFixAttempts, deps.maxRework);
  let lastOutput = baseline.output;

  while (attempts < maxAttempts) {
    attempts++;
    deps.logger.logWork(`Baseline fix attempt ${attempts}/${maxAttempts}`);

    const fixPrompt = buildBaselineFixPrompt(lastOutput, item, deps.testCommand);
    const { finDetected, exitCode, stderr } = await deps.runAgent(fixPrompt);

    if (!finDetected && exitCode !== 0) {
      deps.logger.logError(
        `Baseline fix agent exited with code ${exitCode ?? "unknown"} — stopping`,
      );
      if (stderr) deps.logger.logError(`Agent stderr: ${stderr.slice(-1000)}`);
      return false;
    }

    if (!deps.stageAndCommit(`[AI] baseline test fix attempt ${attempts}`)) {
      deps.logger.logError("Baseline fix stage/commit failed — stopping");
      return false;
    }

    const retest = deps.runTestSuite("all");
    if (retest.passed) {
      deps.logger.logConfig(`Baseline tests fixed after attempt ${attempts}`);
      return true;
    }

    const safeToProceed = await deps.classifyTestFailure(retest.output);
    if (safeToProceed) {
      deps.logger.logConfig(
        "Remaining baseline test failures evaluated as pre-existing — proceeding",
      );
      return true;
    }

    deps.logger.logError(`Baseline tests still failing after attempt ${attempts}`);
    lastOutput = retest.output;
  }

  deps.logger.logError(
    `Baseline tests still failing after ${maxAttempts} fix attempts — aborting`,
  );
  return false;
}

/**
 * Coverage fix loop. Same pattern as baseline, but checks the coverage
 * threshold instead of test pass/fail.
 */
export async function fixCoverageGap(
  deps: TestFixDeps,
  item: WorkItem,
  coverageOutput: string,
): Promise<boolean> {
  let attempts = 0;
  let lastOutput = coverageOutput;

  while (attempts < deps.coverageMaxFixAttempts) {
    attempts++;
    deps.logger.logWork(
      `Coverage fix attempt ${attempts}/${deps.coverageMaxFixAttempts}`,
    );

    const fixPrompt = buildCoverageFixPrompt(lastOutput, item, deps.coverageCommand);
    const { finDetected, exitCode, stderr } = await deps.runAgent(fixPrompt);

    if (!finDetected && exitCode !== 0) {
      deps.logger.logError(
        `Coverage fix agent exited with code ${exitCode ?? "unknown"} — stopping`,
      );
      if (stderr) deps.logger.logError(`Agent stderr: ${stderr.slice(-1000)}`);
      return false;
    }

    if (!deps.stageAndCommit(`[AI] coverage fix attempt ${attempts}`)) {
      deps.logger.logError("Coverage fix stage/commit failed — stopping");
      return false;
    }

    const result = deps.checkCoverage();
    if (result.passed) {
      deps.logger.logConfig(`Coverage thresholds met after fix attempt ${attempts}`);
      return true;
    }
    if (result.kind === "spawn_error") {
      deps.logger.logConfig(
        "Coverage tool unavailable — cannot verify fix, continuing",
      );
      return true;
    }

    deps.logger.logError(
      `Coverage still below threshold after fix attempt ${attempts}`,
    );
    lastOutput = result.output || lastOutput;
  }

  deps.logger.log(
    "WARN",
    `Coverage still below threshold after ${deps.coverageMaxFixAttempts} fix attempts — continuing anyway`,
  );
  return false;
}

/**
 * Inner fix-loop used by fixReworkTests when unit/integration tests fail
 * after a rework cycle. Same retry pattern but tagged with the rework
 * number for log clarity.
 */
export async function attemptTestFix(
  deps: TestFixDeps,
  item: WorkItem,
  reworkCount: number,
  initialOutput: string,
): Promise<boolean> {
  deps.logger.logError("Tests FAILED — entering fix loop");

  let attempts = 0;
  let lastOutput = initialOutput;
  const maxAttempts = deps.reworkMaxFixAttempts;

  while (attempts < maxAttempts) {
    attempts++;
    deps.logger.logWork(`Test fix attempt ${attempts}/${maxAttempts} after rework`);

    const fixPrompt = buildBaselineFixPrompt(lastOutput, item, deps.testCommand);
    const { finDetected, exitCode, stderr } = await deps.runAgent(fixPrompt);

    if (!finDetected && exitCode !== 0) {
      deps.logger.logError(
        `Test fix agent exited with code ${exitCode ?? "unknown"} — stopping`,
      );
      if (stderr) deps.logger.logError(`Agent stderr: ${stderr.slice(-1000)}`);
      return false;
    }

    if (
      !deps.stageAndCommit(
        `[AI] rework #${reworkCount} test fix attempt ${attempts}`,
      )
    ) {
      deps.logger.logError("Test fix stage/commit failed — stopping");
      return false;
    }

    const retestResult = deps.runTestSuite("all");
    if (retestResult.passed) {
      deps.logger.logConfig(`Tests fixed after attempt ${attempts}`);
      return true;
    }
    if (retestResult.kind === "spawn_error") {
      deps.logger.logError(`Tests could not start: ${retestResult.error}`);
      deps.logger.logConfig(
        "Proceeding without tests — test runner unavailable in workspace",
      );
      return true;
    }

    deps.logger.logError(`Tests still failing after fix attempt ${attempts}`);

    const safeToProceed = await deps.classifyTestFailure(retestResult.output);
    if (safeToProceed) {
      deps.logger.logConfig(
        "Remaining test failures evaluated as unrelated to rework — proceeding",
      );
      return true;
    }
    lastOutput = retestResult.output;
  }

  const finalVerdict = await deps.classifyTestFailure(lastOutput);
  if (finalVerdict) {
    deps.logger.logConfig(
      "Final evaluation: remaining test failures are unrelated — proceeding",
    );
    return true;
  }

  deps.logger.logError(
    `Tests still failing after ${maxAttempts} fix attempts — stopping`,
  );
  return false;
}

/**
 * Run tests after a rework cycle, falling through to attemptTestFix when
 * unit/integration fail. Coverage failures are evaluated for relatedness
 * before attempting a fix (don't burn cycles on pre-existing e2e flakes).
 */
export async function fixReworkTests(
  deps: TestFixDeps,
  item: WorkItem,
  reworkCount: number,
): Promise<boolean> {
  if (deps.skipTests) {
    deps.logger.logConfig("Skipping all tests after rework (--skip-tests)");
    return true;
  }

  const unitResult = deps.runTestSuite("unit");
  if (unitResult.kind === "spawn_error") {
    deps.logger.logError(`Unit tests could not start: ${unitResult.error}`);
    deps.logger.logConfig(
      "Proceeding without rework tests — test runner unavailable in workspace",
    );
    return true;
  }

  if (unitResult.passed) {
    const integrationResult = deps.runTestSuite("integration");
    if (integrationResult.kind === "spawn_error") {
      deps.logger.logConfig("Integration tests could not start — skipping");
      return true;
    }
    if (integrationResult.passed) {
      const coverageResult = deps.checkCoverage();
      if (!coverageResult.passed && coverageResult.kind !== "spawn_error") {
        const testOutput =
          coverageResult.output || "coverage check failed with no output";
        const safeToProceed = await deps.classifyTestFailure(testOutput);
        if (safeToProceed) {
          deps.logger.logConfig(
            "Test failure evaluated as unrelated to rework — proceeding",
          );
        } else {
          deps.logger.logConfig(
            "Test failure evaluated as related to rework — attempting fix",
          );
          return await attemptTestFix(deps, item, reworkCount, testOutput);
        }
      }
      return true;
    }
  }

  // Unit or integration failed — attempt fix.
  const lastOutput = !unitResult.passed
    ? unitResult.output
    : deps.runTestSuite("integration").output;
  return await attemptTestFix(deps, item, reworkCount, lastOutput);
}
