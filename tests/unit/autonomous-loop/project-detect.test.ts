import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  detectProjectConfig,
  getProjectConfig,
  resetProjectConfigCache,
  findPythonTestDir,
  hasPytestCov,
} from "../../../src/autonomous-loop/project-detect";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-detect-"));
  resetProjectConfigCache();
  // Clear env overrides
  delete process.env.AICODER_TEST_CMD;
  delete process.env.AICODER_UNIT_TEST_CMD;
  delete process.env.AICODER_INTEGRATION_TEST_CMD;
  delete process.env.AICODER_COVERAGE_CMD;
});

afterEach(() => {
  resetProjectConfigCache();
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ── Node.js detection ─────────────────────────────────────────────────────────

describe("detectProjectConfig — Node.js", () => {
  it("detects 'node' type from package.json with test script", () => {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", build: "tsc" } }),
    );
    const cfg = detectProjectConfig(tempDir);
    expect(cfg.type).toBe("node");
    expect(cfg.hasTests).toBe(true);
    expect(cfg.testCommand).toEqual(["npm", "test"]);
    expect(cfg.buildCommand).toEqual(["npm", "run", "build"]);
  });

  it("detects separate unit/integration/coverage commands", () => {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        scripts: {
          test: "vitest run",
          "test-unit": "vitest run tests/unit",
          "test-integration": "vitest run tests/integration",
          "test:coverage": "vitest run --coverage",
        },
      }),
    );
    const cfg = detectProjectConfig(tempDir);
    expect(cfg.unitTestCommand).toEqual(["npm", "run", "test-unit"]);
    expect(cfg.integrationTestCommand).toEqual(["npm", "run", "test-integration"]);
    expect(cfg.coverageCommand).toEqual(["npm", "run", "test:coverage"]);
  });

  it("returns empty commands for package.json without test script", () => {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc" } }),
    );
    const cfg = detectProjectConfig(tempDir);
    expect(cfg.type).toBe("node");
    expect(cfg.hasTests).toBe(false);
    expect(cfg.testCommand).toEqual([]);
  });

  it("handles malformed package.json gracefully", () => {
    fs.writeFileSync(path.join(tempDir, "package.json"), "{ invalid json");
    const cfg = detectProjectConfig(tempDir);
    expect(cfg.type).toBe("node");
    expect(cfg.hasTests).toBe(false);
  });
});

// ── Python detection ──────────────────────────────────────────────────────────

describe("detectProjectConfig — Python", () => {
  it("detects 'python' type from pyproject.toml", () => {
    fs.writeFileSync(path.join(tempDir, "pyproject.toml"), "[tool.poetry]\nname = 'x'");
    const cfg = detectProjectConfig(tempDir);
    expect(cfg.type).toBe("python");
    expect(cfg.testCommand).toEqual(["pytest"]);
    expect(cfg.hasTests).toBe(true);
  });

  it("detects 'python' type from setup.py", () => {
    fs.writeFileSync(path.join(tempDir, "setup.py"), "from setuptools import setup");
    const cfg = detectProjectConfig(tempDir);
    expect(cfg.type).toBe("python");
  });

  it("detects 'python' type from pytest.ini", () => {
    fs.writeFileSync(path.join(tempDir, "pytest.ini"), "[pytest]");
    const cfg = detectProjectConfig(tempDir);
    expect(cfg.type).toBe("python");
  });

  it("uses test directory in unitTestCommand when tests/unit/ exists", () => {
    fs.writeFileSync(path.join(tempDir, "pyproject.toml"), "");
    fs.mkdirSync(path.join(tempDir, "tests", "unit"), { recursive: true });
    const cfg = detectProjectConfig(tempDir);
    expect(cfg.unitTestCommand).toEqual(["pytest", "tests/unit"]);
  });
});

// ── Rust detection ────────────────────────────────────────────────────────────

describe("detectProjectConfig — Rust", () => {
  it("detects 'rust' type from Cargo.toml", () => {
    fs.writeFileSync(path.join(tempDir, "Cargo.toml"), "[package]\nname = 'app'");
    const cfg = detectProjectConfig(tempDir);
    expect(cfg.type).toBe("rust");
    expect(cfg.testCommand).toEqual(["cargo", "test"]);
    expect(cfg.buildCommand).toEqual(["cargo", "build"]);
  });
});

// ── Go detection ──────────────────────────────────────────────────────────────

describe("detectProjectConfig — Go", () => {
  it("detects 'go' type from go.mod", () => {
    fs.writeFileSync(path.join(tempDir, "go.mod"), "module example.com/app");
    const cfg = detectProjectConfig(tempDir);
    expect(cfg.type).toBe("go");
    expect(cfg.testCommand).toEqual(["go", "test", "./..."]);
    expect(cfg.buildCommand).toEqual(["go", "build", "./..."]);
  });
});

// ── Makefile detection ────────────────────────────────────────────────────────

describe("detectProjectConfig — Makefile", () => {
  it("detects 'make' type with test target", () => {
    fs.writeFileSync(
      path.join(tempDir, "Makefile"),
      "test:\n\tgo test ./...\nbuild:\n\tgo build ./...",
    );
    const cfg = detectProjectConfig(tempDir);
    expect(cfg.type).toBe("make");
    expect(cfg.testCommand).toEqual(["make", "test"]);
    expect(cfg.buildCommand).toEqual(["make", "build"]);
    expect(cfg.hasTests).toBe(true);
  });

  it("hasTests is false when no test target", () => {
    fs.writeFileSync(path.join(tempDir, "Makefile"), "build:\n\tgo build ./...");
    const cfg = detectProjectConfig(tempDir);
    expect(cfg.type).toBe("make");
    expect(cfg.hasTests).toBe(false);
  });
});

// ── Unknown detection ─────────────────────────────────────────────────────────

describe("detectProjectConfig — unknown", () => {
  it("returns 'unknown' type for empty directory", () => {
    const cfg = detectProjectConfig(tempDir);
    expect(cfg.type).toBe("unknown");
    expect(cfg.hasTests).toBe(false);
    expect(cfg.testCommand).toEqual([]);
  });
});

// ── Environment variable overrides ────────────────────────────────────────────

describe("detectProjectConfig — env overrides", () => {
  it("AICODER_TEST_CMD overrides test command for any project type", () => {
    fs.writeFileSync(path.join(tempDir, "Cargo.toml"), "[package]");
    process.env.AICODER_TEST_CMD = "make test";
    const cfg = detectProjectConfig(tempDir);
    expect(cfg.testCommand).toEqual(["make", "test"]);
    expect(cfg.type).toBe("unknown"); // env override short-circuits detection
  });

  it("AICODER_UNIT_TEST_CMD overrides unit test command", () => {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    process.env.AICODER_UNIT_TEST_CMD = "vitest run tests/unit --reporter=dot";
    const cfg = detectProjectConfig(tempDir);
    expect(cfg.unitTestCommand).toEqual([
      "vitest",
      "run",
      "tests/unit",
      "--reporter=dot",
    ]);
  });
});

// ── getProjectConfig cache ────────────────────────────────────────────────────

describe("getProjectConfig — caching", () => {
  it("returns the same object on repeated calls for the same workspace", () => {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    );
    const a = getProjectConfig(tempDir);
    const b = getProjectConfig(tempDir);
    expect(a).toBe(b); // same reference
  });

  it("returns different configs for different workspaces", () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "project-detect-2-"));
    try {
      fs.writeFileSync(
        path.join(tempDir, "package.json"),
        JSON.stringify({ scripts: { test: "vitest" } }),
      );
      fs.writeFileSync(path.join(dir2, "Cargo.toml"), "[package]");
      const a = getProjectConfig(tempDir);
      const b = getProjectConfig(dir2);
      expect(a.type).toBe("node");
      expect(b.type).toBe("rust");
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});

// ── findPythonTestDir ─────────────────────────────────────────────────────────

describe("findPythonTestDir", () => {
  it("finds tests/unit/ directly", () => {
    fs.mkdirSync(path.join(tempDir, "tests", "unit"), { recursive: true });
    const result = findPythonTestDir(tempDir, ["unit"]);
    expect(result).toBe("tests/unit");
  });

  it("finds nested hawkSoar/test/unit/", () => {
    fs.mkdirSync(path.join(tempDir, "hawkSoar", "test", "unit"), { recursive: true });
    const result = findPythonTestDir(tempDir, ["unit"]);
    expect(result).toBe("hawkSoar/test/unit");
  });

  it("returns undefined when no matching dir exists", () => {
    const result = findPythonTestDir(tempDir, ["unit", "integration"]);
    expect(result).toBeUndefined();
  });
});
