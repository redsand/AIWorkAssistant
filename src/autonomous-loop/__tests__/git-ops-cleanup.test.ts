import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cleanupMergedBranch, cleanupAllMergedBranches, pushBranch, recoverFromRebase, isRebaseInProgress } from "../git-ops";

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" });
  return { ok: r.status === 0, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function gitMust(args: string[], cwd: string): void {
  const r = git(args, cwd);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function listLocalBranches(cwd: string): string[] {
  const r = git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], cwd);
  return r.stdout ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Build a "remote" bare repo and a clone with origin → bare.
 * Returns { workspace, remote } absolute paths.
 */
function makeRepoPair(): { workspace: string; remote: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-cleanup-"));
  const remote = path.join(tmp, "remote.git");
  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(remote, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  gitMust(["init", "--bare", "--initial-branch=main"], remote);

  gitMust(["init", "--initial-branch=main"], workspace);
  gitMust(["config", "user.email", "test@example.com"], workspace);
  gitMust(["config", "user.name", "Test"], workspace);
  gitMust(["remote", "add", "origin", remote], workspace);

  fs.writeFileSync(path.join(workspace, "README.md"), "# test\n");
  gitMust(["add", "README.md"], workspace);
  gitMust(["commit", "-m", "init"], workspace);
  gitMust(["push", "-u", "origin", "main"], workspace);

  return { workspace, remote };
}

function makeAiBranchMergedIntoMain(workspace: string, branchName: string): void {
  // Create the AI branch with a commit, then merge it into main on the remote.
  gitMust(["checkout", "-b", branchName], workspace);
  fs.writeFileSync(path.join(workspace, `${branchName.replace(/[\/]/g, "_")}.txt`), "ai\n");
  gitMust(["add", "."], workspace);
  gitMust(["commit", "-m", `ai work ${branchName}`], workspace);
  gitMust(["push", "-u", "origin", branchName], workspace);

  // Merge into main on the remote via a local fast-forward + push.
  gitMust(["checkout", "main"], workspace);
  gitMust(["merge", "--no-ff", "-m", `merge ${branchName}`, branchName], workspace);
  gitMust(["push", "origin", "main"], workspace);
  // Refresh remote-tracking refs so cleanup's --is-ancestor check sees the merge.
  gitMust(["fetch", "origin"], workspace);
}

function makeAiBranchUnmerged(workspace: string, branchName: string): void {
  gitMust(["checkout", "-b", branchName], workspace);
  fs.writeFileSync(path.join(workspace, `${branchName.replace(/[\/]/g, "_")}.txt`), "ai\n");
  gitMust(["add", "."], workspace);
  gitMust(["commit", "-m", `unmerged work ${branchName}`], workspace);
  gitMust(["checkout", "main"], workspace);
}

describe("cleanupMergedBranch", () => {
  let workspace: string;
  let root: string;

  beforeEach(() => {
    const pair = makeRepoPair();
    workspace = pair.workspace;
    root = path.dirname(workspace);
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows sometimes holds the lock briefly — non-fatal in tests.
    }
  });

  it("deletes a merged AI branch", () => {
    makeAiBranchMergedIntoMain(workspace, "ai/issue-1-foo");
    expect(listLocalBranches(workspace)).toContain("ai/issue-1-foo");

    const result = cleanupMergedBranch(workspace, "ai/issue-1-foo", "main");
    expect(result.deletedLocal).toBe(true);
    expect(listLocalBranches(workspace)).not.toContain("ai/issue-1-foo");
  });

  it("refuses to delete a non-AI branch", () => {
    gitMust(["checkout", "-b", "feature/keep-me"], workspace);
    gitMust(["checkout", "main"], workspace);

    const result = cleanupMergedBranch(workspace, "feature/keep-me", "main");
    expect(result.deletedLocal).toBe(false);
    expect(result.reason).toBe("not_ai_branch");
    expect(listLocalBranches(workspace)).toContain("feature/keep-me");
  });

  it("refuses to delete the base branch even with AI prefix override", () => {
    process.env.AICODER_BRANCH_CLEANUP_PREFIX = "ma";
    try {
      const result = cleanupMergedBranch(workspace, "main", "main");
      expect(result.deletedLocal).toBe(false);
      expect(result.reason).toBe("branch_is_base");
    } finally {
      delete process.env.AICODER_BRANCH_CLEANUP_PREFIX;
    }
  });

  it("returns branch_not_found for missing branch", () => {
    const result = cleanupMergedBranch(workspace, "ai/never-existed", "main");
    expect(result.deletedLocal).toBe(false);
    expect(result.reason).toBe("branch_not_found");
  });

  it("refuses to force-delete an unmerged branch", () => {
    makeAiBranchUnmerged(workspace, "ai/issue-2-unmerged");

    const result = cleanupMergedBranch(workspace, "ai/issue-2-unmerged", "main");
    expect(result.deletedLocal).toBe(false);
    expect(result.reason).toBe("not_fully_merged");
    expect(listLocalBranches(workspace)).toContain("ai/issue-2-unmerged");
  });

  it("switches off the branch first if it is currently checked out", () => {
    makeAiBranchMergedIntoMain(workspace, "ai/issue-3-current");
    // Re-create the local branch (the merge above deleted nothing locally; just switch back)
    gitMust(["checkout", "ai/issue-3-current"], workspace);

    const result = cleanupMergedBranch(workspace, "ai/issue-3-current", "main");
    expect(result.deletedLocal).toBe(true);
    expect(listLocalBranches(workspace)).not.toContain("ai/issue-3-current");
    const head = git(["rev-parse", "--abbrev-ref", "HEAD"], workspace);
    expect(head.stdout).toBe("main");
  });

  it("is idempotent — second call returns branch_not_found", () => {
    makeAiBranchMergedIntoMain(workspace, "ai/issue-4-twice");
    const first = cleanupMergedBranch(workspace, "ai/issue-4-twice", "main");
    expect(first.deletedLocal).toBe(true);
    const second = cleanupMergedBranch(workspace, "ai/issue-4-twice", "main");
    expect(second.deletedLocal).toBe(false);
    expect(second.reason).toBe("branch_not_found");
  });

  it("skips a branch checked out in another worktree", () => {
    makeAiBranchMergedIntoMain(workspace, "ai/issue-5-in-worktree");
    const wtPath = path.join(root, "extra-worktree");
    gitMust(["worktree", "add", wtPath, "ai/issue-5-in-worktree"], workspace);

    const result = cleanupMergedBranch(workspace, "ai/issue-5-in-worktree", "main");
    expect(result.deletedLocal).toBe(false);
    expect(result.reason).toBe("checked_out_in_worktree");
    expect(listLocalBranches(workspace)).toContain("ai/issue-5-in-worktree");

    // Cleanup worktree before afterEach removes the dir
    gitMust(["worktree", "remove", "--force", wtPath], workspace);
  });
});

describe("cleanupAllMergedBranches", () => {
  let workspace: string;
  let root: string;

  beforeEach(() => {
    const pair = makeRepoPair();
    workspace = pair.workspace;
    root = path.dirname(workspace);
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch { /* non-fatal on Windows */ }
  });

  it("deletes only merged AI branches, leaves unmerged + non-AI alone", () => {
    makeAiBranchMergedIntoMain(workspace, "ai/issue-merged-1");
    makeAiBranchMergedIntoMain(workspace, "ai/issue-merged-2");
    makeAiBranchUnmerged(workspace, "ai/issue-unmerged");
    gitMust(["checkout", "-b", "feature/keep"], workspace);
    gitMust(["checkout", "main"], workspace);

    const result = cleanupAllMergedBranches(workspace, "main");

    expect(result.cleaned.sort()).toEqual(["ai/issue-merged-1", "ai/issue-merged-2"]);
    expect(result.skipped.map((s) => s.branch)).toContain("ai/issue-unmerged");

    const remaining = listLocalBranches(workspace);
    expect(remaining).toContain("main");
    expect(remaining).toContain("feature/keep");
    expect(remaining).toContain("ai/issue-unmerged");
    expect(remaining).not.toContain("ai/issue-merged-1");
    expect(remaining).not.toContain("ai/issue-merged-2");
  });
});

describe("pushBranch", () => {
  let workspace: string;
  let root: string;

  beforeEach(() => {
    const pair = makeRepoPair();
    workspace = pair.workspace;
    root = path.dirname(workspace);
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows sometimes holds the lock briefly in tests */
    }
  });

  it("pushes to origin with normal push", () => {
    gitMust(["checkout", "-b", "ai/test-push-normal"], workspace);
    fs.writeFileSync(path.join(workspace, "test-push.txt"), "content\n");
    gitMust(["add", "."], workspace);
    gitMust(["commit", "-m", "test push"], workspace);
    const result = pushBranch("ai/test-push-normal", workspace);
    expect(result).toBe(true);
  });

  it("force pushes when force=true", () => {
    gitMust(["checkout", "-b", "ai/test-push-force"], workspace);
    fs.writeFileSync(path.join(workspace, "test-force.txt"), "v1\n");
    gitMust(["add", "."], workspace);
    gitMust(["commit", "-m", "force v1"], workspace);
    gitMust(["push", "-u", "origin", "ai/test-push-force"], workspace);

    // Amend to create diverged history
    fs.writeFileSync(path.join(workspace, "test-force.txt"), "v2\n");
    gitMust(["add", "."], workspace);
    gitMust(["commit", "--amend", "-m", "force v2"], workspace);

    const normalPush = git(["push", "origin", "ai/test-push-force"], workspace);
    expect(normalPush.ok).toBe(false); // rejected (non-fast-forward)

    const result = pushBranch("ai/test-push-force", workspace, undefined, { force: true });
    expect(result).toBe(true);
  });

  it("force pushes with --force-with-lease when forceWithLease=true", () => {
    gitMust(["checkout", "-b", "ai/test-push-fwl"], workspace);
    fs.writeFileSync(path.join(workspace, "test-fwl.txt"), "v1\n");
    gitMust(["add", "."], workspace);
    gitMust(["commit", "-m", "fwl v1"], workspace);
    gitMust(["push", "-u", "origin", "ai/test-push-fwl"], workspace);

    // Amend to create diverged history
    fs.writeFileSync(path.join(workspace, "test-fwl.txt"), "v2\n");
    gitMust(["add", "."], workspace);
    gitMust(["commit", "--amend", "-m", "fwl v2"], workspace);

    const result = pushBranch("ai/test-push-fwl", workspace, undefined, { forceWithLease: true });
    expect(result).toBe(true);
  });

  it("returns false on non-fast-forward rejection without force", () => {
    gitMust(["checkout", "-b", "ai/test-push-reject"], workspace);
    fs.writeFileSync(path.join(workspace, "test-reject.txt"), "v1\n");
    gitMust(["add", "."], workspace);
    gitMust(["commit", "-m", "reject v1"], workspace);
    gitMust(["push", "-u", "origin", "ai/test-push-reject"], workspace);

    // Create conflict on remote
    gitMust(["checkout", "main"], workspace);
    fs.writeFileSync(path.join(workspace, "conflict.txt"), "remote\n");
    gitMust(["add", "."], workspace);
    gitMust(["commit", "-m", "remote conflict"], workspace);
    gitMust(["push", "origin", "main"], workspace);

    // Create diverged local
    gitMust(["checkout", "ai/test-push-reject"], workspace);
    fs.writeFileSync(path.join(workspace, "test-reject.txt"), "v2\n");
    gitMust(["add", "."], workspace);
    gitMust(["commit", "--amend", "-m", "reject v2"], workspace);

    const result = pushBranch("ai/test-push-reject", workspace);
    expect(result).toBe(false);
  });
});

describe("recoverFromRebase", () => {
  let workspace: string;
  let root: string;

  beforeEach(() => {
    const pair = makeRepoPair();
    workspace = pair.workspace;
    root = path.dirname(workspace);
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows sometimes holds the lock briefly in tests */
    }
  });

  it("recovers from mid-rebase state", () => {
    // Create a branch with a commit
    gitMust(["checkout", "-b", "ai/test-rebase-recover"], workspace);
    fs.writeFileSync(path.join(workspace, "rebase-test.txt"), "v1\n");
    gitMust(["add", "."], workspace);
    gitMust(["commit", "-m", "rebase v1"], workspace);

    // Simulate mid-rebase by creating the rebase-merge directory
    const gitDir = path.join(workspace, ".git");
    fs.mkdirSync(path.join(gitDir, "rebase-merge"), { recursive: true });
    fs.writeFileSync(path.join(gitDir, "rebase-merge", "head-name"), "refs/heads/ai/test-rebase-recover");

    expect(isRebaseInProgress(workspace)).toBe(true);
    const result = recoverFromRebase(workspace);
    expect(result).toBe(true);
    expect(isRebaseInProgress(workspace)).toBe(false);
  });
});
