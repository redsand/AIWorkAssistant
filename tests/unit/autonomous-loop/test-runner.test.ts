import { describe, it, expect } from "vitest";
import { runTestSuite, checkCoverage } from "../../../src/autonomous-loop/test-runner";
import type { ProjectConfig } from "../../../src/autonomous-loop/types";

const nodeConfig: ProjectConfig = {
  type: "node",
  testCommand: ["node", "--version"],
  unitTestCommand: ["node", "--version"],
  integrationTestCommand: ["node", "--version"],
  coverageCommand: [],
  buildCommand: [],
  hasTests: true,
};

const noTestConfig: ProjectConfig = {
  type: "unknown",
  testCommand: [],
  unitTestCommand: [],
  integrationTestCommand: [],
  coverageCommand: [],
  buildCommand: [],
  hasTests: false,
};

const failingConfig: ProjectConfig = {
  type: "node",
  testCommand: process.platform === "win32"
    ? ["cmd", "/c", "exit 1"]
    : ["sh", "-c", "exit 1"],
  unitTestCommand: process.platform === "win32"
    ? ["cmd", "/c", "exit 1"]
    : ["sh", "-c", "exit 1"],
  integrationTestCommand: [],
  coverageCommand: [],
  buildCommand: [],
  hasTests: true,
};

const cwd = process.cwd();

// ── runTestSuite ──────────────────────────────────────────────────────────────

describe("runTestSuite — pass cases", () => {
  it("returns kind=pass when command exits 0", () => {
    const result = runTestSuite("unit", nodeConfig, cwd);
    expect(result.passed).toBe(true);
    expect(result.kind).toBe("pass");
    expect(result.exitCode).toBe(0);
  });

  it("returns pass with 'skipping' message when command array is empty", () => {
    const result = runTestSuite("unit", noTestConfig, cwd);
    expect(result.passed).toBe(true);
    expect(result.kind).toBe("pass");
    expect(result.output).toContain("skipping");
  });

  it("passes the correct command for 'integration' suite kind", () => {
    const cfg: ProjectConfig = {
      ...nodeConfig,
      integrationTestCommand: ["node", "--version"],
    };
    const result = runTestSuite("integration", cfg, cwd);
    expect(result.passed).toBe(true);
    expect(result.kind).toBe("pass");
  });
});

describe("runTestSuite — failure cases", () => {
  it("returns kind=fail when command exits non-zero", () => {
    const result = runTestSuite("unit", failingConfig, cwd);
    expect(result.passed).toBe(false);
    expect(result.kind).toBe("fail");
    expect(result.exitCode).not.toBe(0);
  });

  it("returns passed=false for a nonexistent command", () => {
    const cfg: ProjectConfig = {
      ...noTestConfig,
      testCommand: ["__does_not_exist_xyz__"],
      unitTestCommand: ["__does_not_exist_xyz__"],
      hasTests: true,
    };
    const result = runTestSuite("unit", cfg, cwd);
    expect(result.passed).toBe(false);
    // Windows cmd.exe shell retry reports 'fail'; Unix ENOENT reports 'spawn_error'
    expect(["fail", "spawn_error"]).toContain(result.kind);
  });
});

describe("runTestSuite — default (all) suite", () => {
  it("uses testCommand when kind is 'all'", () => {
    const result = runTestSuite("all", nodeConfig, cwd);
    expect(result.passed).toBe(true);
  });
});

// ── checkCoverage ─────────────────────────────────────────────────────────────

describe("checkCoverage", () => {
  it("returns pass when no coverage command is configured", () => {
    const result = checkCoverage(noTestConfig, cwd);
    expect(result.passed).toBe(true);
    expect(result.kind).toBe("pass");
    expect(result.output).toBeUndefined();
  });

  it("returns pass when coverage command exits 0", () => {
    const cfg: ProjectConfig = {
      ...noTestConfig,
      coverageCommand: ["node", "--version"],
    };
    const result = checkCoverage(cfg, cwd);
    expect(result.passed).toBe(true);
    expect(result.kind).toBe("pass");
  });

  it("returns fail when coverage command exits non-zero", () => {
    const cfg: ProjectConfig = {
      ...noTestConfig,
      coverageCommand: process.platform === "win32"
        ? ["cmd", "/c", "exit 1"]
        : ["sh", "-c", "exit 1"],
    };
    const result = checkCoverage(cfg, cwd);
    expect(result.passed).toBe(false);
    expect(result.kind).toBe("fail");
  });
});
