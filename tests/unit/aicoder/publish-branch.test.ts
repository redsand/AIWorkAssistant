import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { pushBranch, gitRun, stageAndCommit, gitRunWithOutput } from "../../../src/autonomous-loop/git-ops";

let remoteDir: string;
let localDir: string;

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.toString()}`);
  }
}

function gitOut(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function writeFile(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content);
}

beforeEach(() => {
  remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "pub-branch-remote-"));
  localDir = fs.mkdtempSync(path.join(os.tmpdir(), "pub-branch-local-"));

  // Bare repo as the "GitLab/GitHub remote"
  git(["init", "--bare"], remoteDir);

  // Local repo — clone the bare remote
  git(["clone", remoteDir, "."], localDir);
  git(["config", "user.email", "test@test.com"], localDir);
  git(["config", "user.name", "Test"], localDir);
  git(["config", "commit.gpgsign", "false"], localDir);

  // Seed main branch with an initial commit
  writeFile(localDir, "README.md", "init");
  git(["add", "-A"], localDir);
  git(["commit", "-m", "init"], localDir);
  git(["push", "origin", "HEAD"], localDir);
});

afterEach(() => {
  for (const dir of [remoteDir, localDir]) {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("pushBranch — force push after rebase failure", () => {
  it("normal push succeeds when remote branch does not exist", () => {
    git(["checkout", "-b", "ai/issue-99-fix"], localDir);
    writeFile(localDir, "fix.ts", "const x = 1;");
    git(["add", "-A"], localDir);
    git(["commit", "-m", "fix: first attempt"], localDir);

    const ok = pushBranch("ai/issue-99-fix", localDir);
    expect(ok).toBe(true);
  });

  it("normal push fails when remote has diverged commits (non-fast-forward)", () => {
    // First aicoder run: push ai/issue-99 with commit A
    git(["checkout", "-b", "ai/issue-99-fix"], localDir);
    writeFile(localDir, "feature.ts", "// attempt 1");
    git(["add", "-A"], localDir);
    git(["commit", "-m", "feat: first attempt"], localDir);
    git(["push", "origin", "ai/issue-99-fix"], localDir);

    // Simulate a second aicoder run: reset local to base and make a different commit
    const mainHead = gitOut(["rev-parse", "HEAD~1"], localDir);
    git(["reset", "--hard", mainHead], localDir);
    writeFile(localDir, "feature.ts", "// attempt 2 — different content");
    git(["add", "-A"], localDir);
    git(["commit", "-m", "feat: second attempt"], localDir);

    // Normal push should be rejected (non-fast-forward)
    const normalOk = pushBranch("ai/issue-99-fix", localDir);
    expect(normalOk).toBe(false);
  });

  it("force push succeeds after normal push is rejected", () => {
    // First run: push branch
    git(["checkout", "-b", "ai/issue-99-fix"], localDir);
    writeFile(localDir, "feature.ts", "// attempt 1");
    git(["add", "-A"], localDir);
    git(["commit", "-m", "feat: first attempt"], localDir);
    git(["push", "origin", "ai/issue-99-fix"], localDir);

    // Second run: diverge local from remote
    const mainHead = gitOut(["rev-parse", "HEAD~1"], localDir);
    git(["reset", "--hard", mainHead], localDir);
    writeFile(localDir, "feature.ts", "// attempt 2 — reworked");
    git(["add", "-A"], localDir);
    git(["commit", "-m", "feat: second attempt"], localDir);

    // Force push replaces the stale remote branch
    const forceOk = pushBranch("ai/issue-99-fix", localDir, undefined, true);
    expect(forceOk).toBe(true);

    // Remote now has the second attempt's commit, not the first
    const remoteHead = gitOut(["rev-parse", "refs/heads/ai/issue-99-fix"], remoteDir);
    const localHead = gitOut(["rev-parse", "HEAD"], localDir);
    expect(remoteHead).toBe(localHead);
  });

  it("force push after aborting a failed rebase restores local state correctly", () => {
    // First run: push branch with file A
    git(["checkout", "-b", "ai/issue-100-fix"], localDir);
    writeFile(localDir, "service.ts", "export const v = 1; // first run");
    git(["add", "-A"], localDir);
    git(["commit", "-m", "feat: first run"], localDir);
    git(["push", "origin", "ai/issue-100-fix"], localDir);
    const firstRunHead = gitOut(["rev-parse", "HEAD"], localDir);

    // Second run: diverge — same file, different content → rebase would conflict
    const mainHead = gitOut(["rev-parse", "HEAD~1"], localDir);
    git(["reset", "--hard", mainHead], localDir);
    writeFile(localDir, "service.ts", "export const v = 2; // second run — reworked");
    git(["add", "-A"], localDir);
    git(["commit", "-m", "feat: second run"], localDir);
    const secondRunHead = gitOut(["rev-parse", "HEAD"], localDir);
    expect(secondRunHead).not.toBe(firstRunHead);

    // git pull --rebase fails due to conflict
    const rebaseOk = gitRun(["pull", "--rebase", "origin", "ai/issue-100-fix"], localDir);
    expect(rebaseOk).toBe(false);

    // Recovery: abort the rebase, restoring HEAD to secondRunHead
    const abortOk = gitRun(["rebase", "--abort"], localDir);
    expect(abortOk).toBe(true);
    const headAfterAbort = gitOut(["rev-parse", "HEAD"], localDir);
    expect(headAfterAbort).toBe(secondRunHead);

    // Force push now cleanly replaces the remote branch
    const forceOk = pushBranch("ai/issue-100-fix", localDir, undefined, true);
    expect(forceOk).toBe(true);

    const remoteHead = gitOut(["rev-parse", "refs/heads/ai/issue-100-fix"], remoteDir);
    expect(remoteHead).toBe(secondRunHead);
  });
});

// ── stageAndCommit SHA detection (Bug 1 fix: nothing staged → skip push) ──────

describe("stageAndCommit — SHA-based detection of empty rework cycles", () => {
  it("returns true but does NOT create a new commit when nothing is staged", () => {
    // Clean working tree: nothing to stage
    const headBefore = gitOut(["rev-parse", "HEAD"], localDir);

    const result = stageAndCommit("rework #1: trivial change", localDir);

    const headAfter = gitOut(["rev-parse", "HEAD"], localDir);
    expect(result).toBe(true); // stageAndCommit does not error on nothing-to-commit
    expect(headAfter).toBe(headBefore); // SHA unchanged — no commit was made
  });

  it("returns true and advances HEAD when changes are staged", () => {
    const headBefore = gitOut(["rev-parse", "HEAD"], localDir);

    writeFile(localDir, "fix.ts", "export const v = 1;");
    const result = stageAndCommit("feat: real change", localDir);

    const headAfter = gitOut(["rev-parse", "HEAD"], localDir);
    expect(result).toBe(true);
    expect(headAfter).not.toBe(headBefore); // SHA advanced — commit was made
  });

  it("SHA comparison detects empty rework even when branch has prior commits (the IR-115 scenario)", () => {
    // Simulate: first aicoder run creates a commit and pushes
    git(["checkout", "-b", "ai/issue-115-fix"], localDir);
    writeFile(localDir, "service.ts", "// original fix");
    git(["add", "-A"], localDir);
    git(["commit", "-m", "feat: original fix"], localDir);

    const shaAfterFirstRun = gitOut(["rev-parse", "HEAD"], localDir);

    // Rework agent runs but produces only a trailing newline — nothing staged
    const headBefore = gitOut(["rev-parse", "HEAD"], localDir);
    stageAndCommit("rework #1: address review feedback", localDir);
    const headAfter = gitOut(["rev-parse", "HEAD"], localDir);

    // SHA comparison correctly identifies no new commit
    const reworkMadeCommit = headBefore !== headAfter;
    expect(reworkMadeCommit).toBe(false);

    // Verify: diff vs "base" (HEAD~1) is non-empty — validateDiffBeforePush
    // would be fooled into thinking changes exist, but SHA comparison is not
    const diffResult = gitRunWithOutput(["diff", "HEAD~1..HEAD", "--stat"], localDir);
    expect(diffResult.ok).toBe(true);
    expect(diffResult.stdout.trim().length).toBeGreaterThan(0); // diff exists vs prior commit

    // HEAD is still the first run's SHA — force-pushing this would give reviewer same SHA
    expect(headAfter).toBe(shaAfterFirstRun);
  });

  it("SHA comparison correctly identifies a real rework commit", () => {
    git(["checkout", "-b", "ai/issue-115-fix2"], localDir);
    writeFile(localDir, "service.ts", "// original");
    git(["add", "-A"], localDir);
    git(["commit", "-m", "feat: original"], localDir);

    const headBefore = gitOut(["rev-parse", "HEAD"], localDir);

    // Rework agent makes a real change
    writeFile(localDir, "service.ts", "// fixed based on review");
    stageAndCommit("rework #1: fix session regeneration", localDir);

    const headAfter = gitOut(["rev-parse", "HEAD"], localDir);
    const reworkMadeCommit = headBefore !== headAfter;
    expect(reworkMadeCommit).toBe(true); // Push should proceed
  });
});
