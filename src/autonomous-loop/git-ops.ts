/**
 * Pure git utility operations.
 *
 * All functions accept explicit `workspace` and optional `logger` parameters —
 * no module-level state.  Functions that bridge git + agent concerns
 * (forceCheckout with conflict resolution, ensureCleanWorkspace) remain in
 * aicoder.ts until a workspace-manager module is created.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { PipelineLogger } from "./types";

const noop: PipelineLogger = {
  logGit: () => {},
  logError: () => {},
  logConfig: () => {},
  logWork: () => {},
  logAgent: () => {},
};

// ── Low-level git execution ───────────────────────────────────────────────────

export function gitRun(
  args: string[],
  cwd: string,
  logger: PipelineLogger = noop,
): boolean {
  const result = spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" });
  if (result.status !== 0) {
    logger.logGit(`git ${args.join(" ")}`, `failed: ${result.stderr?.trim()}`);
    return false;
  }
  return true;
}

export function gitRunWithOutput(
  args: string[],
  cwd: string,
  logger: PipelineLogger = noop,
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" });
  if (result.status !== 0) {
    logger.logGit(`git ${args.join(" ")}`, `failed: ${result.stderr?.trim()}`);
  }
  return {
    ok: result.status === 0,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

// ── Branch state ──────────────────────────────────────────────────────────────

export function getCurrentBranch(workspace: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: workspace, stdio: "pipe", encoding: "utf-8",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

export function isRebaseInProgress(cwd: string): boolean {
  const gitDir = path.join(cwd, ".git");
  return (
    fs.existsSync(path.join(gitDir, "rebase-merge")) ||
    fs.existsSync(path.join(gitDir, "rebase-apply"))
  );
}

export function getConflictFiles(workspace: string): string[] {
  const statusResult = spawnSync("git", ["status", "--porcelain"], {
    cwd: workspace, stdio: "pipe", encoding: "utf-8",
  });
  if (statusResult.status !== 0) return [];
  return statusResult.stdout
    .trim()
    .split("\n")
    .filter((line) => /^(DD|AU|UD|UA|DU|UU|AA)/.test(line))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

// ── Base branch resolution ────────────────────────────────────────────────────

export function resolveBaseBranch(
  workspace: string,
  candidates: string[],
  logger: PipelineLogger = noop,
): string {
  const headResult = spawnSync(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    { cwd: workspace, stdio: "pipe", encoding: "utf-8" },
  );
  if (headResult.status === 0) {
    const match = headResult.stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
    if (match) {
      logger.logGit("Base branch resolved from remote HEAD", match[1]);
      return match[1];
    }
  }

  for (const candidate of candidates) {
    const verify = spawnSync("git", ["rev-parse", "--verify", candidate], {
      cwd: workspace, stdio: "pipe", encoding: "utf-8",
    });
    if (verify.status === 0) {
      logger.logGit("Base branch resolved from local", candidate);
      return candidate;
    }
    const remoteVerify = spawnSync(
      "git",
      ["rev-parse", "--verify", `origin/${candidate}`],
      { cwd: workspace, stdio: "pipe", encoding: "utf-8" },
    );
    if (remoteVerify.status === 0) {
      logger.logGit("Base branch resolved from remote", candidate);
      return candidate;
    }
  }

  const current = getCurrentBranch(workspace);
  logger.logGit("WARN", `Could not resolve base branch — using current: ${current}`);
  return current ?? "main";
}

/** Memoised accessor — one resolution per (workspace, candidates) combination. */
const _baseBranchCache = new Map<string, string>();
export function getBaseBranch(
  workspace: string,
  candidates: string[],
  logger: PipelineLogger = noop,
): string {
  const key = `${workspace}::${candidates.join(",")}`;
  if (!_baseBranchCache.has(key)) {
    _baseBranchCache.set(key, resolveBaseBranch(workspace, candidates, logger));
  }
  return _baseBranchCache.get(key)!;
}
export function resetBaseBranchCache(): void {
  _baseBranchCache.clear();
}

// ── Rebase recovery ───────────────────────────────────────────────────────────

/**
 * Recover from a stuck rebase state.  Tries `git rebase --abort`, removes
 * blocking files if needed, then does a manual directory cleanup as last
 * resort.  Never uses `git reset --hard` — working tree changes are preserved.
 */
export function recoverFromRebase(
  cwd: string,
  logger: PipelineLogger = noop,
): boolean {
  if (!isRebaseInProgress(cwd)) return true;
  logger.logGit("WARN", "Mid-rebase state detected — attempting recovery");

  if (gitRun(["rebase", "--abort"], cwd, logger)) return true;

  logger.logGit("WARN", "git rebase --abort failed — attempting to remove blocking files");
  const abortResult = gitRunWithOutput(["rebase", "--abort"], cwd, logger);
  const abortErr = abortResult.stderr;

  const unlinkMatches = abortErr.matchAll(/unable to unlink old '([^']+)'/g);
  const overwriteSection = abortErr.match(
    /The following untracked working tree files would be overwritten by checkout:\s*\n((?:\s+.+\n?)+)/,
  );

  const blockingFiles: string[] = [];
  for (const m of unlinkMatches) blockingFiles.push(m[1]);
  if (overwriteSection) {
    overwriteSection[1].split("\n").forEach((line) => {
      const f = line.trim();
      if (f) blockingFiles.push(f);
    });
  }

  for (const filePath of blockingFiles) {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    try {
      fs.unlinkSync(absPath);
      logger.logGit("Removed blocking file", filePath);
    } catch {
      try {
        fs.renameSync(absPath, absPath + ".blocking.bak");
        logger.logGit("Renamed blocking file", filePath);
      } catch {
        logger.logGit("WARN", `Could not remove or rename blocking file: ${filePath}`);
      }
    }
  }

  if (gitRun(["rebase", "--abort"], cwd, logger)) {
    logger.logGit("Rebase abort succeeded after removing blocking files");
    return true;
  }

  logger.logGit("WARN", "Manual rebase cleanup — reading orig-head before removing state");
  const gitDir = path.join(cwd, ".git");
  let origHead: string | null = null;
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const origHeadPath = path.join(gitDir, dir, "orig-head");
    try {
      if (fs.existsSync(origHeadPath)) {
        origHead = fs.readFileSync(origHeadPath, "utf-8").trim();
        logger.logGit("Read orig-head", origHead);
      }
    } catch { /* file may not exist */ }
  }

  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const dirPath = path.join(gitDir, dir);
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
  }

  const resetTarget = origHead || "HEAD";
  if (!gitRun(["reset", "--soft", resetTarget], cwd, logger)) {
    gitRun(["reset", "--soft", "HEAD"], cwd, logger);
  }

  logger.logGit("Rebase recovery completed");
  return !isRebaseInProgress(cwd);
}

// ── Staging and pushing ───────────────────────────────────────────────────────

export function stageAndCommit(
  message: string,
  workspace: string,
  logger: PipelineLogger = noop,
): boolean {
  if (!gitRun(["add", "--all"], workspace, logger)) {
    logger.logGit("git add --all failed — retrying with tracked-only + new files", "");
    gitRun(["add", "-u"], workspace, logger);
    const lsResult = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: workspace, stdio: "pipe", encoding: "utf-8",
    });
    if (lsResult.status === 0 && lsResult.stdout.trim()) {
      for (const f of lsResult.stdout.trim().split("\n")) {
        if (!f.trim()) continue;
        if (!gitRun(["add", f.trim()], workspace, logger)) {
          logger.logGit("Skipping untrackable file", f.trim());
        }
      }
    }
  }

  const status = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: workspace, stdio: "pipe", encoding: "utf-8",
  });
  if (status.status === 0) {
    logger.logGit("Nothing staged to commit", "skipping commit");
    return true;
  }

  logger.logGit("Committing", message);
  if (!gitRun(["commit", "-m", message], workspace, logger)) {
    logger.logError("git commit failed");
    return false;
  }
  return true;
}

/**
 * Ensure `origin` remote exists before pushing. Tools like `git filter-repo`
 * strip all remotes as a safety measure — this restores the remote from env
 * vars so subsequent pushes succeed without manual intervention.
 */
function ensureOriginRemote(workspace: string, logger: PipelineLogger): boolean {
  const check = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: workspace,
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (check.status === 0) return true; // origin already present

  // Build remote URL from environment
  const baseUrl = (process.env.GITLAB_BASE_URL || "").replace(/\/$/, "");
  const token = process.env.GITLAB_TOKEN || "";
  const project = process.env.GITLAB_DEFAULT_PROJECT || "";

  // Try to infer project from existing git config (remote was removed but log may have it)
  if (!baseUrl || !project) {
    logger.logError("origin remote missing and GITLAB_BASE_URL/GITLAB_DEFAULT_PROJECT not set — cannot restore remote");
    return false;
  }

  const host = baseUrl.replace(/^https?:\/\//, "");
  const remoteUrl = token
    ? `https://oauth2:${token}@${host}/${project}.git`
    : `${baseUrl}/${project}.git`;

  // Use set-url if origin exists (wrong URL), add if it doesn't exist at all
  const exists = spawnSync("git", ["remote", "get-url", "origin"], { cwd: workspace, stdio: "pipe" }).status === 0;
  const subCmd = exists ? "set-url" : "add";
  logger.logGit(`origin remote ${exists ? "has wrong URL" : "missing"} — restoring from env`);
  const add = spawnSync("git", ["remote", subCmd, "origin", remoteUrl], {
    cwd: workspace,
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (add.status !== 0) {
    logger.logError(`Failed to restore origin remote: ${add.stderr}`);
    return false;
  }
  logger.logGit("origin remote restored");
  return true;
}

export function pushBranch(
  branchName: string,
  workspace: string,
  logger: PipelineLogger = noop,
  force = false,
): boolean {
  ensureOriginRemote(workspace, logger);
  const args = force
    ? ["push", "--force", "origin", branchName]
    : ["push", "origin", branchName];
  logger.logGit(force ? "Force pushing to origin" : "Pushing to origin", branchName);
  return gitRun(args, workspace, logger);
}

// ── Modified file list ────────────────────────────────────────────────────────

export function getBranchModifiedFiles(
  workspace: string,
  baseBranch: string,
  _logger: PipelineLogger = noop,
): string[] {
  let result = spawnSync("git", ["diff", "--name-only", `origin/${baseBranch}`], {
    cwd: workspace, stdio: "pipe", encoding: "utf-8",
  });
  if (result.status === 0) {
    const files = result.stdout.trim().split("\n").filter(Boolean);
    if (files.length > 0) return files;
  }

  result = spawnSync("git", ["diff", "--name-only", baseBranch], {
    cwd: workspace, stdio: "pipe", encoding: "utf-8",
  });
  if (result.status === 0) {
    const files = result.stdout.trim().split("\n").filter(Boolean);
    if (files.length > 0) return files;
  }

  const current = getCurrentBranch(workspace);
  if (current?.startsWith("ai/")) {
    const mergeBase = spawnSync("git", ["merge-base", "HEAD", baseBranch], {
      cwd: workspace, stdio: "pipe", encoding: "utf-8",
    });
    if (mergeBase.status === 0) {
      result = spawnSync("git", ["diff", "--name-only", mergeBase.stdout.trim()], {
        cwd: workspace, stdio: "pipe", encoding: "utf-8",
      });
      if (result.status === 0) {
        return result.stdout.trim().split("\n").filter(Boolean);
      }
    }
  }

  return [];
}

export function pullAndUpdateBase(
  workspace: string,
  candidates: string[],
  logger: PipelineLogger,
  forceCheckoutFn: (branch: string, cwd: string) => boolean,
): boolean {
  if (isRebaseInProgress(workspace)) {
    logger.logGit("WARN", "Mid-rebase state detected — recovering before pull");
    if (!recoverFromRebase(workspace, logger)) {
      logger.logError("Could not recover from mid-rebase state — skipping pull");
      return false;
    }
  }
  const base = getBaseBranch(workspace, candidates, logger);
  const previousBranch = getCurrentBranch(workspace);
  logger.logGit("Pulling latest", base);
  if (!forceCheckoutFn(base, workspace)) {
    logger.logError(`Failed to switch to ${base}`);
    return false;
  }
  if (!gitRun(["pull", "--ff-only", "origin", base], workspace, logger)) {
    logger.logError(`Pull --ff-only failed for ${base} — base branch may be stale`);
    if (previousBranch && previousBranch !== base) {
      forceCheckoutFn(previousBranch, workspace);
    }
    return false;
  }
  return true;
}
