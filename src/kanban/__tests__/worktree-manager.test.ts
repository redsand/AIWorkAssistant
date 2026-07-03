import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  isClean,
  ensurePersistentWorktree,
} from "../worktree-manager.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

vi.setConfig({ testTimeout: 30_000 });

// Shared mutable state read by the node:fs mock below. Populated per-test to
// force fs.rmSync/fs.renameSync to fail for a specific target path, and reset
// afterward. Declared via vi.hoisted so it's safe to reference inside the
// (hoisted) vi.mock factory.
const fsFailureState = vi.hoisted(() => ({
  rmFailPath: null as string | null,
  renameFailPath: null as string | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: (target: fs.PathLike, opts?: fs.RmOptions) => {
      if (fsFailureState.rmFailPath && String(target) === fsFailureState.rmFailPath) {
        const err = new Error("EPERM: operation not permitted (mock)") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return actual.rmSync(target, opts);
    },
    renameSync: (oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (fsFailureState.renameFailPath && String(oldPath) === fsFailureState.renameFailPath) {
        throw new Error("mock rename failure");
      }
      return actual.renameSync(oldPath, newPath);
    },
  };
});

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

  describe("ensurePersistentWorktree reprovisioning fallback", () => {
    const dirsToCleanUp: string[] = [];

    afterEach(() => {
      fsFailureState.rmFailPath = null;
      fsFailureState.renameFailPath = null;
      while (dirsToCleanUp.length > 0) {
        const dir = dirsToCleanUp.pop()!;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    /** Create a bare-bones git repo at `dir` with a single commit on main. */
    function initGitRepo(dir: string): void {
      fs.mkdirSync(dir, { recursive: true });
      execSync("git init --initial-branch=main", { cwd: dir, stdio: "pipe" });
      execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
      execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
      fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
      execSync("git add .", { cwd: dir, stdio: "pipe" });
      execSync("git commit -m initial", { cwd: dir, stdio: "pipe" });
    }

    it("reuses the most recently modified runner-*-reprovision-* directory when the canonical path has no .git", async () => {
      // realpathSync(os.tmpdir()) up front so every path built from `baseDir`
      // is already in long-path form — git's rev-parse --show-toplevel
      // normalizes to long form, but Windows may hand back TEMP in 8.3
      // short-name form, which would otherwise make a raw string comparison
      // against the git-resolved result path flaky.
      const baseDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "wtm-reuse-"));
      dirsToCleanUp.push(baseDir);
      const root = path.join(baseDir, ".kanban-worktrees");
      fs.mkdirSync(root, { recursive: true });
      const runnerId = "reuse-test";

      // Canonical dir intentionally absent — only stale reprovision dirs exist.
      const older = path.join(root, `runner-${runnerId}-reprovision-1000`);
      const newer = path.join(root, `runner-${runnerId}-reprovision-2000`);
      const noGit = path.join(root, `runner-${runnerId}-reprovision-3000`);
      initGitRepo(older);
      initGitRepo(newer);
      fs.mkdirSync(noGit, { recursive: true }); // no .git — must be ignored

      // Force deterministic mtime ordering regardless of creation order above.
      const now = Date.now();
      fs.utimesSync(older, new Date(now - 60_000), new Date(now - 60_000));
      fs.utimesSync(newer, new Date(now), new Date(now));

      const resultPath = await ensurePersistentWorktree({
        runnerId,
        baseBranch: "main",
        worktreeRoot: root,
      });

      // Picked the newer, valid reprovision dir — never touched the (missing)
      // canonical path or the .git-less candidate. Compared via realpath since
      // Windows may report os.tmpdir() in 8.3 short-name form while git
      // resolves --show-toplevel to the long form.
      expect(path.resolve(resultPath)).toBe(path.resolve(newer));
      expect(fs.existsSync(path.join(root, `runner-${runnerId}`, ".git"))).toBe(false);
    });

    it("falls back to a fresh reprovision directory when the stale canonical workspace cannot be removed", async () => {
      const baseDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "wtm-fallback-"));
      dirsToCleanUp.push(baseDir);

      // Anchor repo lives alongside .kanban-worktrees so findLocalCloneForRemote
      // (searchRoot = dirname(root)) discovers it for both the prune-anchor
      // lookup and the actual worktree-add provisioning step.
      const repoUrl = "https://example.invalid/acme/repo.git";
      const anchor = path.join(baseDir, "acme-repo");
      initGitRepo(anchor);
      execSync(`git remote add origin ${repoUrl}`, { cwd: anchor, stdio: "pipe" });
      // No network access in this test — seed a local remote-tracking ref so
      // `worktree add --detach <dir> origin/main` resolves without a fetch.
      execSync("git update-ref refs/remotes/origin/main HEAD", { cwd: anchor, stdio: "pipe" });

      const root = path.join(baseDir, ".kanban-worktrees");
      fs.mkdirSync(root, { recursive: true });
      const runnerId = "fallback-test";
      const canonicalDir = path.join(root, `runner-${runnerId}`);
      // Leftover, non-repo directory at the canonical path — not a registered
      // worktree of `anchor`, so `git worktree remove` (strategy 1) fails
      // naturally without any mocking.
      fs.mkdirSync(canonicalDir, { recursive: true });
      fs.writeFileSync(path.join(canonicalDir, "leftover.txt"), "stale");

      // Force strategies 2 (fs.rmSync retry) and 3 (rename-out-of-the-way) to
      // fail too, so removeStaleWorkspaceDir exhausts every recovery path and
      // ensurePersistentWorktree must fall back to a fresh replacement dir.
      fsFailureState.rmFailPath = canonicalDir;
      fsFailureState.renameFailPath = canonicalDir;

      const resultPath = await ensurePersistentWorktree({
        runnerId,
        repoUrl,
        baseBranch: "main",
        worktreeRoot: root,
      });

      // Provisioning succeeded at a *different* directory than the
      // undeletable canonical path, following the runner-<id>-reprovision-*
      // naming convention used by the fallback branch.
      expect(path.resolve(resultPath)).not.toBe(path.resolve(canonicalDir));
      expect(path.basename(resultPath)).toMatch(
        new RegExp(`^runner-${runnerId}-reprovision-\\d+$`),
      );
      expect(fs.existsSync(path.join(resultPath, ".git"))).toBe(true);
      // The stale canonical dir is left in place for later cleanup — it was
      // never deleted, just abandoned in favor of the replacement.
      expect(fs.existsSync(path.join(canonicalDir, "leftover.txt"))).toBe(true);
    });
  });
});
