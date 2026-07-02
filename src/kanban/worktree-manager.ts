import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  findLocalCloneForRemote,
  injectGitCredentials,
  redactCredentials,
} from "../util/git-auth";

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  locked: boolean;
  prunable: boolean;
}

function spawnGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn("git", args, {
      cwd,
      shell: false,
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => errChunks.push(c));

    proc.on("error", reject);
    proc.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(
          `git ${args.join(" ")} failed (exit ${code}): ${stderr || stdout}`,
        );
        (err as NodeJS.ErrnoException).code = String(code);
        reject(err);
      }
    });
  });
}

function shortSha(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 7);
}

function worktreePathConvention(opts: {
  repoPath: string;
  branch: string;
  worktreeRoot?: string;
}): string {
  const root =
    opts.worktreeRoot ??
    path.join(opts.repoPath, "..", ".kanban-worktrees");
  const slug = opts.branch.replace(/\//g, "-");
  const sha = shortSha(opts.branch + Date.now().toString());
  const dirName = `${slug}-${sha}`;
  return path.resolve(path.join(root, dirName));
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await spawnGit(["rev-parse", "--verify", branch], cwd);
    return true;
  } catch {
    return false;
  }
}

export async function createWorktree(opts: {
  repoPath: string;
  branch: string;
  baseBranch?: string;
  worktreeRoot?: string;
}): Promise<string> {
  const { repoPath, branch } = opts;
  const baseBranch = opts.baseBranch ?? "main";
  const wtPath = worktreePathConvention(opts);

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });

  const exists = await branchExists(repoPath, branch);
  const args: string[] = ["worktree", "add"];

  if (!exists) {
    args.push("-b", branch);
  }

  args.push(wtPath);
  if (!exists) {
    args.push(baseBranch);
  }

  await spawnGit(args, repoPath);

  // Ask git for the canonical path to avoid 8.3 vs long-name mismatches on Windows
  const { stdout: topLevel } = await spawnGit(
    ["rev-parse", "--show-toplevel"],
    wtPath,
  );
  return path.resolve(topLevel.trim());
}

export async function listWorktrees(
  repoPath: string,
): Promise<WorktreeInfo[]> {
  const { stdout } = await spawnGit(
    ["worktree", "list", "--porcelain"],
    repoPath,
  );

  const results: WorktreeInfo[] = [];
  const blocks = stdout.trim().split("\n\n");

  for (const block of blocks) {
    if (!block.trim()) continue;

    let wtPath = "";
    let head = "";
    let branch = "";
    let locked = false;
    let prunable = false;

    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        wtPath = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length);
      } else if (line === "locked") {
        locked = true;
      } else if (line.startsWith("locked ")) {
        locked = true;
      } else if (line === "prunable") {
        prunable = true;
      } else if (line.startsWith("prunable ")) {
        prunable = true;
      }
    }

    if (wtPath) {
      results.push({ path: path.resolve(wtPath), branch, head, locked, prunable });
    }
  }

  return results;
}

export async function removeWorktree(
  wtPath: string,
  opts?: { force?: boolean },
): Promise<void> {
  const repoPath = await findRepoRoot(wtPath);

  if (!fs.existsSync(wtPath)) {
    if (repoPath) {
      await spawnGit(["worktree", "prune"], repoPath);
    }
    return;
  }

  const args = ["worktree", "remove", wtPath];
  if (opts?.force) {
    args.push("--force");
  }

  // Must run from the main repo, not from the worktree being removed
  const cwd = repoPath ?? path.dirname(wtPath);

  try {
    await spawnGit(args, cwd);
    if (repoPath) {
      await spawnGit(["worktree", "prune"], repoPath).catch(() => undefined);
    }
    console.log(`[worktree] Removed worktree via git worktree remove: ${wtPath}`);
  } catch {
    await removeStaleWorkspaceDir(wtPath, repoPath ?? null);
    if (repoPath) {
      await spawnGit(["worktree", "prune"], repoPath).catch(() => undefined);
    }
  }
}

async function findRepoRoot(
  wtPath: string,
): Promise<string | undefined> {
  // Walk up from the worktree path to find a .git directory
  // The worktree's .git file points back to the main repo
  const gitFile = path.join(wtPath, ".git");
  if (fs.existsSync(gitFile)) {
    const content = fs.readFileSync(gitFile, "utf8").trim();
    // .git file contains: gitdir: /path/to/main/.git/worktrees/<name>
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (match) {
      const gitDir = match[1];
      // Extract main repo path from gitdir
      const mainRepoGit = path.resolve(
        path.dirname(gitFile),
        gitDir,
        "..",
        "..",
      );
      if (fs.existsSync(mainRepoGit)) {
        return path.resolve(mainRepoGit, "..");
      }
    }
  }

  // Fallback: try parent directories
  let dir = path.dirname(wtPath);
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  return undefined;
}

export async function isClean(worktreePath: string): Promise<boolean> {
  const { stdout } = await spawnGit(
    ["-C", worktreePath, "status", "--porcelain"],
    worktreePath,
  );
  return stdout.trim() === "";
}

/**
 * Remove a stale workspace directory using multiple strategies.
 * On Windows, file handles from crashed processes can cause EPERM errors
 * on fs.rmSync. We try git worktree remove first (which handles the
 * .git/worktrees registration), then retry fs.rmSync with delays, and
 * finally fall back to renaming the directory out of the way.
 */
async function removeStaleWorkspaceDir(
  dir: string,
  anchorRepoPath: string | null,
): Promise<void> {
  // Strategy 1: Try git worktree remove --force from the anchor repo.
  // This properly unregisters the worktree from .git/worktrees/ AND
  // deletes the directory. Works even when the .git file exists.
  if (anchorRepoPath) {
    try {
      await spawnGit(["worktree", "remove", "--force", dir], anchorRepoPath);
      console.log(`[worktree] Removed worktree via git worktree remove: ${dir}`);
      return; // Success â€” git handled both unregister and delete
    } catch {
      // Fall through to fs.rmSync strategies
    }
  }

  // Strategy 2: fs.rmSync with retry-on-EPERM. Windows may hold file
  // handles for a few seconds after a process exits. Retry up to 3
  // times with increasing delays.
  const maxRetries = 3;
  let lastRmError: unknown = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[worktree] Removed worktree via fs.rmSync after retry: ${dir}`);
      return; // Success
    } catch (err) {
      lastRmError = err;
      const code = (err as NodeJS.ErrnoException).code;
      const isEperm = code === "EPERM" || code === "ENOTEMPTY" ||
        (err instanceof Error && /EPERM|ENOTEMPTY|busy|in use/i.test(err.message));
      if (!isEperm) throw err;
      if (attempt === maxRetries) break;
      // Wait before retrying: 500ms, 1000ms, 2000ms
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }

  // Strategy 3: Rename the stale directory out of the way. This lets
  // provisioning proceed immediately. The renamed directory will be
  // cleaned up by the kanban-worktree-cleanup scheduler or manually.
  // Use a timestamp suffix to avoid collisions.
  const trashDir = `${dir}.stale-${Date.now()}`;
  try {
    fs.renameSync(dir, trashDir);
    // eslint-disable-next-line no-console
    console.log(
      `[worktree] Could not delete stale ${dir}; renamed to ${trashDir} for async cleanup`,
    );
  } catch (renameErr) {
    // If even rename fails, re-throw the original-style error
    const msg = renameErr instanceof Error ? renameErr.message : String(renameErr);
    const rmMsg = lastRmError instanceof Error ? lastRmError.message : String(lastRmError ?? "unknown removal error");
    throw new Error(`Could not remove or rename stale workspace ${dir}: remove failed: ${rmMsg}; rename failed: ${msg}`);
  }
}

function spawnAny(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn(cmd, args, { cwd, shell: false });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => errChunks.push(c));
    proc.on("error", reject);
    proc.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(" ")} failed (exit ${code}): ${stderr || stdout}`));
    });
  });
}

/**
 * Provision a persistent per-runner workspace. The directory layout matches the
 * kanban worktree convention but is keyed by runner id so it survives across
 * runs.
 *
 * If `repoUrl` is supplied and the directory doesn't yet exist, the repo is
 * cloned into it. Otherwise we just fetch and reset the base branch so the
 * next aicoder cycle starts from a clean, up-to-date checkout.
 *
 * Returns the absolute path of the workspace.
 */
export async function ensurePersistentWorktree(opts: {
  runnerId: string;
  repoUrl?: string | null;
  baseBranch?: string | null;
  worktreeRoot?: string;
  /** Optional anchor repo to derive worktreeRoot from when none provided. */
  anchorRepoPath?: string;
}): Promise<string> {
  const baseBranch = opts.baseBranch ?? "main";
  const root = opts.worktreeRoot
    ?? (opts.anchorRepoPath
        ? path.join(opts.anchorRepoPath, "..", ".kanban-worktrees")
        : path.join(process.cwd(), "..", ".kanban-worktrees"));
  const canonicalDir = path.resolve(path.join(root, `runner-${opts.runnerId}`));
  let dir = canonicalDir;

  fs.mkdirSync(path.dirname(canonicalDir), { recursive: true });

  if (!fs.existsSync(path.join(canonicalDir, ".git"))) {
    const prefix = `runner-${opts.runnerId}-reprovision-`;
    const replacement = fs.existsSync(root)
      ? fs.readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
          .map((entry) => path.resolve(path.join(root, entry.name)))
          .filter((candidate) => fs.existsSync(path.join(candidate, ".git")))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
      : undefined;
    if (replacement) {
      dir = replacement;
    }
  }

  const isRepo = fs.existsSync(path.join(dir, ".git"));
  if (!isRepo) {
    if (!opts.repoUrl) {
      throw new Error(
        `Workspace ${dir} does not exist and no repoUrl was provided for runner ${opts.runnerId}`,
      );
    }
    // Always prune the anchor's stale worktree registrations BEFORE we
    // try to add. The most common failure isn't a left-behind directory
    // (the rmSync below covers that) â€” it's git remembering a now-gone
    // worktree path via `.git/worktrees/<id>` so `worktree add` aborts
    // with "missing but already registered worktree". Running prune
    // here makes provisioning self-heal across runner deletes,
    // file-system cleanups, and disk migrations without forcing the
    // operator to `git worktree prune` by hand.
    const searchRootForPrune = path.dirname(root);
    const anchorForPrune = opts.repoUrl
      ? findLocalCloneForRemote(opts.repoUrl, searchRootForPrune)
      : null;
    if (anchorForPrune) {
      try {
        await spawnGit(["worktree", "prune"], anchorForPrune);
      } catch {
        // Best-effort â€” if prune itself fails, the worktree-add retry
        // path below will still try `-f` as a last resort.
      }
    }
    // Stale-directory recovery: a prior provision attempt may have
    // created `dir` but failed before writing `.git`, or a prior runner
    // process crashed leaving file handles locked. `git worktree add`
    // and `git clone` both refuse to operate on a non-empty existing
    // path. Try multiple strategies to clear the path:
    //   1. git worktree remove --force (properly unregisters + deletes)
    //   2. fs.rmSync with retry-on-EPERM (Windows releases handles after
    //      process exit; a 2-second wait often resolves the lock)
    //   3. Rename the stale dir out of the way so provisioning can proceed
    //      (the renamed dir gets cleaned up on the next cycle or by the
    //      kanban-worktree-cleanup scheduler)
    if (fs.existsSync(dir)) {
      try {
        await removeStaleWorkspaceDir(dir, anchorForPrune);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const replacementDir = path.resolve(
          path.join(root, `runner-${opts.runnerId}-reprovision-${Date.now()}`),
        );
        console.warn(
          `[worktree] Stale workspace ${dir} could not be removed before re-provisioning: ${msg}. ` +
            `Provisioning replacement workspace ${replacementDir}`,
        );
        dir = replacementDir;
      }
    }
    // Two-strategy provisioning (see src/util/git-auth.ts header):
    //
    //   1. If the user has a local clone whose origin matches our repoUrl
    //      sitting next to .kanban-worktrees, `git worktree add` from there.
    //      No network, no auth required â€” git treats it as a local op. This
    //      is exactly what the existing kanban worktree feature does and
    //      why kanban "just works" while a raw clone here used to fail with
    //      "Host key verification failed."
    //
    //   2. Otherwise fall back to `git clone` with the GITHUB_TOKEN /
    //      GITLAB_TOKEN injected into an HTTPS URL. ssh-style URLs are
    //      rewritten to https first so saved runners auto-heal.
    const searchRoot = path.dirname(root); // sibling of .kanban-worktrees
    const localAnchor = findLocalCloneForRemote(opts.repoUrl, searchRoot);
    if (localAnchor) {
      // Make sure the anchor has the latest base branch fetched before we
      // create a worktree off it. Best-effort â€” if fetch fails (e.g. the
      // anchor's origin remote uses SSH keys not present here) we still
      // try the worktree add against whatever ref is local.
      try {
        await spawnGit(["fetch", "origin", baseBranch], localAnchor);
      } catch {
        // Non-fatal â€” there may already be a local origin/<baseBranch> ref.
      }
      // --detach is mandatory here: git refuses to check out the same
      // branch in two worktrees, so if the anchor is already on master,
      // any `worktree add -B master` or `worktree add master` fails. We
      // start the runner workspace in detached-HEAD at the latest
      // origin/<baseBranch>; aicoder creates its own feature branch from
      // there exactly the same way kanban worktrees do.
      try {
        await spawnGit(
          ["worktree", "add", "--detach", dir, `origin/${baseBranch}`],
          localAnchor,
        );
      } catch (err) {
        // Last-ditch retry: if prune above didn't clear a leftover
        // registration (rare â€” e.g. .git/worktrees/<id> file held open
        // by another process during the prune attempt), force the add.
        // "-f" overrides "missing but already registered" without
        // touching unrelated worktrees. Re-throw the original error if
        // the message doesn't match so genuine failures (auth, ref not
        // found, disk full) aren't masked.
        const msg = err instanceof Error ? err.message : String(err);
        if (/missing but already registered worktree/i.test(msg)) {
          await spawnGit(
            ["worktree", "add", "-f", "--detach", dir, `origin/${baseBranch}`],
            localAnchor,
          );
        } else {
          throw err;
        }
      }
    } else {
      const cloneUrl = injectGitCredentials(opts.repoUrl);
      // Never log the credentialed URL â€” pipe through redactCredentials.
      // eslint-disable-next-line no-console
      console.log(
        `[worktree] No local clone of ${opts.repoUrl} found in ${searchRoot}; ` +
          `cloning fresh into ${dir} via ${redactCredentials(cloneUrl)}`,
      );
      // -b lands the clone directly on baseBranch even if the remote's
      // default HEAD points elsewhere; saves a second checkout.
      await spawnAny(
        "git",
        ["clone", "-b", baseBranch, cloneUrl, dir],
        path.dirname(dir),
      );
    }
  }

  // Per-cycle refresh â€” runs every invocation regardless of how the
  // workspace was provisioned. Never call `git checkout <baseBranch>` here:
  // if this workspace was created as a worktree from a local anchor, the
  // anchor already holds that branch and the checkout would fail with
  // "branch already used by worktree". `reset --hard origin/<baseBranch>`
  // moves the current HEAD (branch or detached) to the latest remote tip
  // which is what we actually want.
  try {
    await spawnGit(["fetch", "origin", baseBranch], dir);
  } catch {
    // Non-fatal: remote may be unreachable or branch may not exist yet.
  }
  try {
    await spawnGit(["reset", "--hard", `origin/${baseBranch}`], dir);
  } catch {
    // Non-fatal: leave whatever state exists, aicoder will recover.
  }

  const { stdout: topLevel } = await spawnGit(
    ["rev-parse", "--show-toplevel"],
    dir,
  );
  return path.resolve(topLevel.trim());
}
