/**
 * Test suite execution.
 *
 * Runs unit/integration/all test suites for the detected project type.
 * Pure function — no module-level state.  Returns a typed TestSuiteResult
 * rather than calling process.exit().
 */

import { spawnSync } from "child_process";
import type { TestSuiteKind, TestSuiteOutcome, TestSuiteResult, ProjectConfig, PipelineLogger } from "./types";

const noop: PipelineLogger = {
  logGit: () => {},
  logError: () => {},
  logConfig: () => {},
  logWork: () => {},
  logAgent: () => {},
};

const DEFAULT_UNIT_TIMEOUT = parseInt(process.env.AICODER_UNIT_TEST_TIMEOUT || "300000", 10);
const DEFAULT_INTEGRATION_TIMEOUT = parseInt(process.env.AICODER_INTEGRATION_TEST_TIMEOUT || "600000", 10);

export function runTestSuite(
  suiteKind: TestSuiteKind = "all",
  config: ProjectConfig,
  workspace: string,
  logger: PipelineLogger = noop,
  unitTimeout = DEFAULT_UNIT_TIMEOUT,
  integrationTimeout = DEFAULT_INTEGRATION_TIMEOUT,
): TestSuiteResult {
  let command: string[];
  let timeout: number;

  switch (suiteKind) {
    case "unit":
      command = config.unitTestCommand;
      timeout = unitTimeout;
      break;
    case "integration":
      command = config.integrationTestCommand;
      timeout = integrationTimeout;
      break;
    default:
      command = config.testCommand;
      timeout = 300_000;
  }

  if (command.length === 0) {
    logger.logConfig(`No ${suiteKind} test command detected — skipping`);
    return {
      passed: true,
      output: `No ${suiteKind} test command detected — skipping`,
      exitCode: 0,
      signal: null,
      timedOut: false,
      error: null,
      kind: "pass",
    };
  }

  logger.logGit(`Running ${suiteKind} tests`, command.join(" "));

  const useShell = process.platform === "win32";
  let result = spawnSync(command[0], command.slice(1), {
    cwd: workspace, stdio: "pipe", encoding: "utf-8", timeout,
  });

  if (result.error && useShell && (result.error as any).code === "ENOENT") {
    logger.logConfig("Direct spawn failed (ENOENT) — retrying with shell");
    result = spawnSync(command[0], command.slice(1), {
      cwd: workspace, stdio: "pipe", encoding: "utf-8", timeout, shell: true,
    });
  }

  if (result.error && config.type === "python" && command[0] === "pytest") {
    const fallbackCmd = process.platform === "win32" ? "python" : "python3";
    logger.logConfig(`pytest spawn failed — retrying with ${fallbackCmd} -m pytest`);
    result = spawnSync(fallbackCmd, ["-m", "pytest", ...command.slice(1)], {
      cwd: workspace, stdio: "pipe", encoding: "utf-8", timeout,
    });
    if (result.error && (result.error as any).code === "ENOENT") {
      logger.logConfig("python -m pytest direct spawn failed — retrying with shell");
      result = spawnSync(fallbackCmd, ["-m", "pytest", ...command.slice(1)], {
        cwd: workspace, stdio: "pipe", encoding: "utf-8", timeout, shell: true,
      });
    }
  }

  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  const combined = `${stdout}\n${stderr}`;
  const spawnError = result.error?.message ?? null;
  const timedOut = (result as any).timedOut === true;
  const signal = result.signal ?? null;

  let kind: TestSuiteOutcome;
  if (result.status === 0) {
    kind = "pass";
  } else if (spawnError) {
    kind = "spawn_error";
  } else if (timedOut || (result.status === null && signal)) {
    kind = "timeout";
  } else {
    kind = "fail";
  }

  const passed = kind === "pass";

  if (!passed) {
    const lastLines = combined.split("\n").slice(-15).join("\n");
    switch (kind) {
      case "spawn_error":
        logger.logError(`${suiteKind} tests could not start: ${spawnError}`);
        break;
      case "timeout":
        logger.logError(
          `${suiteKind} tests timed out after ${timeout}ms${signal ? ` (killed by ${signal})` : ""}${lastLines ? `\n${lastLines}` : ""}`,
        );
        break;
      default:
        logger.logError(
          `${suiteKind} tests failed (exit code ${result.status}):\n${lastLines || "no output captured"}`,
        );
    }
  } else {
    logger.logGit(`${suiteKind} tests passed`, command.join(" "));
  }

  return { passed, output: combined, exitCode: result.status, signal, timedOut, error: spawnError, kind };
}

export function checkCoverage(
  config: ProjectConfig,
  workspace: string,
  logger: PipelineLogger = noop,
): { passed: boolean; kind: TestSuiteOutcome; output?: string } {
  if (config.coverageCommand.length === 0) {
    logger.logConfig("No coverage command detected — skipping coverage check");
    return { passed: true, kind: "pass" };
  }

  logger.logGit("Checking coverage thresholds", config.coverageCommand.join(" "));
  const result = spawnSync(
    config.coverageCommand[0],
    config.coverageCommand.slice(1),
    { cwd: workspace, stdio: "pipe", encoding: "utf-8", timeout: 300_000 },
  );

  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  const combined = `${stdout}\n${stderr}`;
  const passed = result.status === 0;

  if (!passed) {
    logger.logError(`Coverage check failed (exit code ${result.status}):\n${combined.split("\n").slice(-10).join("\n")}`);
  } else {
    logger.logConfig("Coverage thresholds met");
  }

  return { passed, kind: passed ? "pass" : "fail", output: combined };
}
