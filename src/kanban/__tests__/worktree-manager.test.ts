import { describe, it, expect, afterEach } from "vitest";
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  isClean,
} from "../worktree-manager.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

/** Create a temp git repo and return its absolute path. */
function makeTempRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wtm-test-"));
  execSync("git init --initial-branch=main", { cwd: tmp, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: tmp, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: tmp, stdio: "pipe" });
  fs.writeFileSync(path.join(tmp, "README.md"), "# test\n");
  execSync("git add .", { cwd: tmp, stdio: "pipe" });
  execSync("git commit -m initial", { cwd: tmp, stdio: "pipe" });
  return tmp;
}

/** Create a temp repo whose path contains spaces (Windows edge case). */
function makeTempRepoWithSpaces(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "path with spaces "));
  const tmp = path.join(base, "my repo");
  fs.mkdirSync(tmp, { recursive: true });
  execSync("git init --initial-branch=main", { cwd: tmp, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: tmp, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: tmp, stdio: "pipe" });
  fs.writeFileSync(path.join(tmp, "README.md"), "# test\n");
  execSync("git add .", { cwd: tmp, stdio: "pipe" });
  execSync("git commit -m initial", { cwd: tmp, stdio: "pipe" });
  return tmp;
}

const reposToCleanUp: string[] = [];

function registerCleanup(repoPath: string) {
  reposToCleanUp.push(repoPath);
}

afterEach(() => {
  while (reposToCleanUp.length > 0) {
    const repoPath = reposToCleanUp.pop()!;
    const worktreeRoot = path.join(repoPath, "..", ".kanban-worktrees");
    if (fs.existsSync(worktreeRoot)) {
      // Force-remove any worktrees first to avoid git lock issues
      try {
        execSync("git worktree prune", { cwd: repoPath, stdio: "pipe" });
      } catch {
        // ignore
      }
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

describe("worktree-manager", () => {
  describe("createWorktree", () => {
    it("returns absolute path and directory exists on disk", async () => {
      const repo = makeTempRepo();
      registerCleanup(repo);

      const wtPath = await createWorktree({
        repoPath: repo,
        branch: "feature-test-1",
      });

      expect(path.isAbsolute(wtPath)).toBe(true);
      expect(fs.existsSync(wtPath)).toBe(true);
      expect(fs.existsSync(path.join(wtPath, "README.md"))).toBe(true);
    });

    it("creates worktree from specified base branch", async () => {
      const repo = makeTempRepo();
      registerCleanup(repo);

      // Create a feature branch from main
      const wtPath = await createWorktree({
        repoPath: repo,
        branch: "feature-base",
        baseBranch: "main",
      });

      expect(fs.existsSync(wtPath)).toBe(true);
    });

    it("uses custom worktreeRoot when provided", async () => {
      const repo = makeTempRepo();
      registerCleanup(repo);
      const customRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wtm-custom-root"));

      const wtPath = await createWorktree({
        repoPath: repo,
        branch: "feature-custom-root",
        worktreeRoot: customRoot,
      });

      // Verify the worktree was created with a path that contains the custom root name
      expect(wtPath).toContain("wtm-custom-root");
      expect(fs.existsSync(wtPath)).toBe(true);

      // Cleanup custom root
      fs.rmSync(customRoot, { recursive: true, force: true });
    });

    it("reuses existing branch (omits -b flag)", async () => {
      const repo = makeTempRepo();
      registerCleanup(repo);

      // Create branch first
      execSync("git branch feature-exists", { cwd: repo, stdio: "pipe" });

      const wtPath = await createWorktree({
        repoPath: repo,
        branch: "feature-exists",
      });

      expect(fs.existsSync(wtPath)).toBe(true);
    });

    it("handles repo path with spaces (Windows)", async () => {
      const repo = makeTempRepoWithSpaces();
      registerCleanup(repo);

      const wtPath = await createWorktree({
        repoPath: repo,
        branch: "feature-spaces",
      });

      expect(path.isAbsolute(wtPath)).toBe(true);
      expect(fs.existsSync(wtPath)).toBe(true);
    });
  });

  describe("listWorktrees", () => {
    it("shows main worktree and new entry with parsed branch", async () => {
      const repo = makeTempRepo();
      registerCleanup(repo);

      const wtPath = await createWorktree({
        repoPath: repo,
        branch: "feature-list",
      });

      const trees = await listWorktrees(repo);

      expect(trees.length).toBeGreaterThanOrEqual(2);
      const mainWt = trees.find((t) => t.branch === "main" || t.branch === "refs/heads/main");
      const featureWt = trees.find((t) => t.path === wtPath);

      expect(mainWt).toBeDefined();
      expect(featureWt).toBeDefined();
      expect(featureWt!.branch).toContain("feature-list");
      expect(featureWt!.head).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  describe("removeWorktree", () => {
    it("deletes directory and entry disappears from listWorktrees", async () => {
      const repo = makeTempRepo();
      registerCleanup(repo);

      const wtPath = await createWorktree({
        repoPath: repo,
        branch: "feature-remove",
      });

      expect(fs.existsSync(wtPath)).toBe(true);

      await removeWorktree(wtPath);

      expect(fs.existsSync(wtPath)).toBe(false);

      const trees = await listWorktrees(repo);
      const found = trees.find((t) => t.path === wtPath);
      expect(found).toBeUndefined();
    });

    it("prunes when directory is already gone", async () => {
      const repo = makeTempRepo();
      registerCleanup(repo);

      const wtPath = await createWorktree({
        repoPath: repo,
        branch: "feature-prune",
      });

      // Manually delete the directory
      fs.rmSync(wtPath, { recursive: true, force: true });

      // Should not throw — should just prune
      await expect(removeWorktree(wtPath)).resolves.toBeUndefined();
    });

    it("supports force removal", async () => {
      const repo = makeTempRepo();
      registerCleanup(repo);

      const wtPath = await createWorktree({
        repoPath: repo,
        branch: "feature-force",
      });

      // Create a dirty state
      fs.writeFileSync(path.join(wtPath, "dirty.txt"), "changes");

      await removeWorktree(wtPath, { force: true });

      expect(fs.existsSync(wtPath)).toBe(false);
    });
  });

  describe("isClean", () => {
    it("returns true for untouched checkout", async () => {
      const repo = makeTempRepo();
      registerCleanup(repo);

      const wtPath = await createWorktree({
        repoPath: repo,
        branch: "feature-clean",
      });

      const clean = await isClean(wtPath);
      expect(clean).toBe(true);
    });

    it("returns false after adding a file", async () => {
      const repo = makeTempRepo();
      registerCleanup(repo);

      const wtPath = await createWorktree({
        repoPath: repo,
        branch: "feature-dirty",
      });

      fs.writeFileSync(path.join(wtPath, "new-file.txt"), "dirty");

      const clean = await isClean(wtPath);
      expect(clean).toBe(false);
    });

    it("handles paths with spaces", async () => {
      const repo = makeTempRepoWithSpaces();
      registerCleanup(repo);

      const wtPath = await createWorktree({
        repoPath: repo,
        branch: "feature-spaces-clean",
      });

      expect(await isClean(wtPath)).toBe(true);

      fs.writeFileSync(path.join(wtPath, "dirty.txt"), "dirty");
      expect(await isClean(wtPath)).toBe(false);
    });
  });
});
