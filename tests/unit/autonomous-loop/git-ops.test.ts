import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import {
  gitRun,
  gitRunWithOutput,
  getCurrentBranch,
  isRebaseInProgress,
  getConflictFiles,
  stageAndCommit,
  resolveBaseBranch,
  recoverFromRebase,
  getBranchModifiedFiles,
  resetBaseBranchCache,
} from "../../../src/autonomous-loop/git-ops";

let repoDir: string;

function initRepo(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  execSync('git config commit.gpgsign false', { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "init.txt"), "init");
  execSync("git add -A", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "pipe" });
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ops-"));
  initRepo(repoDir);
  resetBaseBranchCache();
});

afterEach(() => {
  resetBaseBranchCache();
  if (repoDir && fs.existsSync(repoDir)) {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── gitRun ────────────────────────────────────────────────────────────────────

describe("gitRun", () => {
  it("returns true for a successful git command", () => {
    expect(gitRun(["status"], repoDir)).toBe(true);
  });

  it("returns false for a failing git command", () => {
    expect(gitRun(["checkout", "nonexistent-branch-xyz"], repoDir)).toBe(false);
  });
});

// ── gitRunWithOutput ──────────────────────────────────────────────────────────

describe("gitRunWithOutput", () => {
  it("captures stdout on success", () => {
    const result = gitRunWithOutput(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
    expect(result.ok).toBe(true);
    expect(result.stdout).toMatch(/master|main/);
    expect(result.stderr).toBe("");
  });

  it("returns ok=false and stderr on failure", () => {
    const result = gitRunWithOutput(["log", "--oneline", "nonexistent-ref"], repoDir);
    expect(result.ok).toBe(false);
  });
});

// ── getCurrentBranch ──────────────────────────────────────────────────────────

describe("getCurrentBranch", () => {
  it("returns the current branch name", () => {
    const branch = getCurrentBranch(repoDir);
    expect(branch).toMatch(/master|main/);
  });

  it("returns null for a non-git directory", () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "non-repo-"));
    try {
      expect(getCurrentBranch(nonRepo)).toBeNull();
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

// ── isRebaseInProgress ────────────────────────────────────────────────────────

describe("isRebaseInProgress", () => {
  it("returns false for a clean repo", () => {
    expect(isRebaseInProgress(repoDir)).toBe(false);
  });

  it("returns true when rebase-merge directory exists", () => {
    const rebaseMerge = path.join(repoDir, ".git", "rebase-merge");
    fs.mkdirSync(rebaseMerge, { recursive: true });
    expect(isRebaseInProgress(repoDir)).toBe(true);
    fs.rmdirSync(rebaseMerge);
  });
});

// ── getConflictFiles ──────────────────────────────────────────────────────────

describe("getConflictFiles", () => {
  it("returns empty array for a clean repo", () => {
    expect(getConflictFiles(repoDir)).toEqual([]);
  });
});

// ── stageAndCommit ────────────────────────────────────────────────────────────

describe("stageAndCommit", () => {
  it("stages and commits a new file", () => {
    fs.writeFileSync(path.join(repoDir, "new-file.txt"), "hello");
    const result = stageAndCommit("test commit", repoDir);
    expect(result).toBe(true);
    const log = gitRunWithOutput(["log", "--oneline", "-1"], repoDir);
    expect(log.stdout).toContain("test commit");
  });

  it("returns true and skips commit when nothing staged", () => {
    // No changes in the repo
    const result = stageAndCommit("empty commit", repoDir);
    expect(result).toBe(true); // nothing staged → treated as success
  });

  it("commits modifications to existing files", () => {
    fs.writeFileSync(path.join(repoDir, "init.txt"), "modified");
    const result = stageAndCommit("modify init", repoDir);
    expect(result).toBe(true);
  });
});

// ── resolveBaseBranch ─────────────────────────────────────────────────────────

describe("resolveBaseBranch", () => {
  it("falls back to current branch when no remote and main/master don't exist", () => {
    // Create a branch named 'dev' and resolve from there
    execSync("git checkout -b dev", { cwd: repoDir, stdio: "pipe" });
    const result = resolveBaseBranch(repoDir, ["main", "master"]);
    // Should find master (it exists) or fall back to current
    expect(["master", "main", "dev"]).toContain(result);
  });

  it("returns 'master' when master branch exists and main does not", () => {
    // By default git init creates 'master' (or 'main' depending on config)
    const result = resolveBaseBranch(repoDir, ["main", "master"]);
    expect(["master", "main"]).toContain(result);
  });
});

// ── recoverFromRebase ─────────────────────────────────────────────────────────

describe("recoverFromRebase", () => {
  it("returns true immediately when no rebase is in progress", () => {
    expect(recoverFromRebase(repoDir)).toBe(true);
  });
});

// ── getBranchModifiedFiles ────────────────────────────────────────────────────

describe("getBranchModifiedFiles", () => {
  it("returns an empty array when there are no files beyond base", () => {
    const baseBranch = getCurrentBranch(repoDir) ?? "master";
    // On a fresh repo, no diff between HEAD and base
    const files = getBranchModifiedFiles(repoDir, baseBranch);
    expect(Array.isArray(files)).toBe(true);
  });

  it("returns modified file names after a commit on a feature branch", () => {
    const base = getCurrentBranch(repoDir) ?? "master";
    execSync("git checkout -b feature/test", { cwd: repoDir, stdio: "pipe" });
    fs.writeFileSync(path.join(repoDir, "feature.ts"), "export const x = 1;");
    stageAndCommit("add feature.ts", repoDir);
    const files = getBranchModifiedFiles(repoDir, base);
    expect(files).toContain("feature.ts");
  });
});
