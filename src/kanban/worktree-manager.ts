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
  } catch {
    if (repoPath) {
      await spawnGit(["worktree", "prune"], repoPath);
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
  const dir = path.resolve(path.join(root, `runner-${opts.runnerId}`));

  fs.mkdirSync(path.dirname(dir), { recursive: true });

  const isRepo = fs.existsSync(path.join(dir, ".git"));
  if (!isRepo) {
    if (!opts.repoUrl) {
      throw new Error(
        `Workspace ${dir} does not exist and no repoUrl was provided for runner ${opts.runnerId}`,
      );
    }
    // Stale-directory recovery: a prior provision attempt may have
    // created `dir` but failed before writing `.git`. `git worktree add`
    // and `git clone` both refuse to operate on a non-empty existing
    // path. Wipe the orphan and retry — there's nothing in it we want
    // since it's not a real worktree.
    if (fs.existsSync(dir)) {
      // First try to prune the worktree registration in case the anchor
      // still thinks this path is live; otherwise `worktree add` later
      // refuses to recreate it even after rm.
      try {
        const searchRootForPrune = path.dirname(root);
        const anchorForPrune = opts.repoUrl
          ? findLocalCloneForRemote(opts.repoUrl, searchRootForPrune)
          : null;
        if (anchorForPrune) {
          await spawnGit(["worktree", "prune"], anchorForPrune);
        }
      } catch {
        // Best-effort — if anchor lookup or prune fails, we still try rm.
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Stale workspace ${dir} could not be removed before re-provisioning: ${msg}`,
        );
      }
    }
    // Two-strategy provisioning (see src/util/git-auth.ts header):
    //
    //   1. If the user has a local clone whose origin matches our repoUrl
    //      sitting next to .kanban-worktrees, `git worktree add` from there.
    //      No network, no auth required — git treats it as a local op. This
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
      // create a worktree off it. Best-effort — if fetch fails (e.g. the
      // anchor's origin remote uses SSH keys not present here) we still
      // try the worktree add against whatever ref is local.
      try {
        await spawnGit(["fetch", "origin", baseBranch], localAnchor);
      } catch {
        // Non-fatal — there may already be a local origin/<baseBranch> ref.
      }
      // --detach is mandatory here: git refuses to check out the same
      // branch in two worktrees, so if the anchor is already on master,
      // any `worktree add -B master` or `worktree add master` fails. We
      // start the runner workspace in detached-HEAD at the latest
      // origin/<baseBranch>; aicoder creates its own feature branch from
      // there exactly the same way kanban worktrees do.
      await spawnGit(
        ["worktree", "add", "--detach", dir, `origin/${baseBranch}`],
        localAnchor,
      );
    } else {
      const cloneUrl = injectGitCredentials(opts.repoUrl);
      // Never log the credentialed URL — pipe through redactCredentials.
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

  // Per-cycle refresh — runs every invocation regardless of how the
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
