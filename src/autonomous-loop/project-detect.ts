/**
 * Project type detection.
 *
 * Examines the workspace for known project markers (package.json, Cargo.toml,
 * go.mod, etc.) and returns a ProjectConfig with the correct test/build
 * commands.  Pure function — no side effects beyond reading the filesystem.
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import type { ProjectConfig, PipelineLogger } from "./types";

const noop: PipelineLogger = {
  logGit: () => {},
  logError: () => {},
  logConfig: () => {},
  logWork: () => {},
  logAgent: () => {},
};

/**
 * Find a Python test subdirectory by searching for common test layouts.
 * Returns the relative path from `workspace` (e.g. "hawkSoar/test/unit")
 * or undefined if no match found.
 */
export function findPythonTestDir(
  workspace: string,
  keywords: string[],
): string | undefined {
  const topDirs = fs
    .readdirSync(workspace, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const testRoots = ["tests", "test"];
  for (const top of topDirs) {
    const subTest = path.join(top, "test");
    const subTests = path.join(top, "tests");
    if (fs.existsSync(path.join(workspace, subTest))) testRoots.push(subTest);
    if (fs.existsSync(path.join(workspace, subTests))) testRoots.push(subTests);
  }

  for (const root of testRoots) {
    const rootPath = path.join(workspace, root);
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) continue;

    for (const kw of keywords) {
      const direct = path.join(workspace, root, kw);
      if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) {
        return path.relative(workspace, direct).replace(/\\/g, "/");
      }
    }

    try {
      const entries = fs.readdirSync(rootPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        for (const kw of keywords) {
          const nested = path.join(workspace, root, entry.name, kw);
          if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
            return path.relative(workspace, nested).replace(/\\/g, "/");
          }
        }
      }
    } catch {
      // Permission or OS error — skip this root
    }
  }
  return undefined;
}

export function hasPytestCov(workspace: string): boolean {
  try {
    const result = spawnSync(
      process.platform === "win32" ? "python" : "python3",
      ["-c", "import pytest_cov"],
      { cwd: workspace, stdio: "pipe", encoding: "utf-8", timeout: 10_000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

export function detectProjectConfig(workspace: string): ProjectConfig {
  const envTest = process.env.AICODER_TEST_CMD;
  const envUnit = process.env.AICODER_UNIT_TEST_CMD;
  const envIntegration = process.env.AICODER_INTEGRATION_TEST_CMD;
  const envCoverage = process.env.AICODER_COVERAGE_CMD;

  if (envTest) {
    const testCmd = envTest.split(" ");
    return {
      type: "unknown",
      testCommand: testCmd,
      unitTestCommand: envUnit ? envUnit.split(" ") : testCmd,
      integrationTestCommand: envIntegration ? envIntegration.split(" ") : testCmd,
      coverageCommand: envCoverage ? envCoverage.split(" ") : [],
      buildCommand: [],
      hasTests: true,
    };
  }

  const pkgJsonPath = path.join(workspace, "package.json");
  const pyprojectPath = path.join(workspace, "pyproject.toml");
  const setupPyPath = path.join(workspace, "setup.py");
  const pytestIniPath = path.join(workspace, "pytest.ini");
  const cargoPath = path.join(workspace, "Cargo.toml");
  const goModPath = path.join(workspace, "go.mod");
  const makefilePath = path.join(workspace, "Makefile");

  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
      const scripts = pkg.scripts ?? {};
      const testCmd: string[] = "test" in scripts ? ["npm", "test"] : [];
      const hasTestScript = "test" in scripts;
      const unitCmd: string[] = "test-unit" in scripts
        ? ["npm", "run", "test-unit"]
        : hasTestScript ? ["npm", "test", "--", "tests/unit"] : [];
      const integrationCmd: string[] = "test-integration" in scripts
        ? ["npm", "run", "test-integration"]
        : hasTestScript ? ["npm", "test", "--", "tests/integration"] : [];
      const coverageCmd: string[] = "test:coverage" in scripts
        ? ["npm", "run", "test:coverage"]
        : [];
      const buildCmd: string[] = "build" in scripts ? ["npm", "run", "build"] : [];
      return {
        type: "node",
        testCommand: testCmd,
        unitTestCommand: envUnit ? envUnit.split(" ") : unitCmd,
        integrationTestCommand: envIntegration ? envIntegration.split(" ") : integrationCmd,
        coverageCommand: envCoverage ? envCoverage.split(" ") : coverageCmd,
        buildCommand: buildCmd,
        hasTests: hasTestScript,
      };
    } catch {
      return { type: "node", testCommand: [], unitTestCommand: [], integrationTestCommand: [], coverageCommand: [], buildCommand: [], hasTests: false };
    }
  }

  if (fs.existsSync(pyprojectPath) || fs.existsSync(setupPyPath) || fs.existsSync(pytestIniPath)) {
    const unitDir = findPythonTestDir(workspace, ["unit", "units"]);
    const integrationDir = findPythonTestDir(workspace, ["integration", "integrations", "functional", "e2e"]);
    return {
      type: "python",
      testCommand: ["pytest"],
      unitTestCommand: envUnit ? envUnit.split(" ") : unitDir ? ["pytest", unitDir] : ["pytest"],
      integrationTestCommand: envIntegration ? envIntegration.split(" ") : integrationDir ? ["pytest", integrationDir] : ["pytest"],
      coverageCommand: envCoverage ? envCoverage.split(" ") : hasPytestCov(workspace) ? ["pytest", "--cov"] : [],
      buildCommand: [],
      hasTests: true,
    };
  }

  if (fs.existsSync(cargoPath)) {
    return {
      type: "rust",
      testCommand: ["cargo", "test"],
      unitTestCommand: envUnit ? envUnit.split(" ") : ["cargo", "test", "--lib"],
      integrationTestCommand: envIntegration ? envIntegration.split(" ") : ["cargo", "test"],
      coverageCommand: [],
      buildCommand: ["cargo", "build"],
      hasTests: true,
    };
  }

  if (fs.existsSync(goModPath)) {
    return {
      type: "go",
      testCommand: ["go", "test", "./..."],
      unitTestCommand: envUnit ? envUnit.split(" ") : ["go", "test", "./...", "-short"],
      integrationTestCommand: envIntegration ? envIntegration.split(" ") : ["go", "test", "./..."],
      coverageCommand: [],
      buildCommand: ["go", "build", "./..."],
      hasTests: true,
    };
  }

  if (fs.existsSync(makefilePath)) {
    const makeContent = fs.readFileSync(makefilePath, "utf-8");
    const hasTarget = (name: string) => new RegExp(`^${name}:`, "m").test(makeContent);
    const testCmd: string[] = hasTarget("test") ? ["make", "test"] : [];
    const unitCmd: string[] = hasTarget("test-unit") ? ["make", "test-unit"] : testCmd.length > 0 ? ["make", "test"] : [];
    const integrationCmd: string[] = hasTarget("test-integration") ? ["make", "test-integration"] : testCmd.length > 0 ? ["make", "test"] : [];
    const coverageCmd: string[] = hasTarget("test-coverage") ? ["make", "test-coverage"] : [];
    const buildCmd: string[] = hasTarget("build") ? ["make", "build"] : [];
    return {
      type: "make",
      testCommand: testCmd,
      unitTestCommand: envUnit ? envUnit.split(" ") : unitCmd,
      integrationTestCommand: envIntegration ? envIntegration.split(" ") : integrationCmd,
      coverageCommand: envCoverage ? envCoverage.split(" ") : coverageCmd,
      buildCommand: buildCmd,
      hasTests: testCmd.length > 0,
    };
  }

  return {
    type: "unknown",
    testCommand: [],
    unitTestCommand: [],
    integrationTestCommand: [],
    coverageCommand: [],
    buildCommand: [],
    hasTests: false,
  };
}

/** Cached accessor — detects once per workspace path. */
const cache = new Map<string, ProjectConfig>();
export function getProjectConfig(
  workspace: string,
  logger: PipelineLogger = noop,
): ProjectConfig {
  if (!cache.has(workspace)) {
    const cfg = detectProjectConfig(workspace);
    logger.logConfig(
      `Detected project type: ${cfg.type}, test: ${cfg.testCommand.join(" ") || "none"}`,
    );
    cache.set(workspace, cfg);
  }
  return cache.get(workspace)!;
}

/** Clear the cache (for testing). */
export function resetProjectConfigCache(): void {
  cache.clear();
}
