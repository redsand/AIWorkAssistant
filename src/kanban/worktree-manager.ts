import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

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
