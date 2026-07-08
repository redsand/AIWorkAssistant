import { execFileSync } from "child_process";
import fs from "fs";
import { createRequire } from "module";
import path from "path";

const require = createRequire(__filename);

export interface GitRuntimeMetadata {
  repoRoot: string | null;
  commit: string | null;
  branch: string | null;
  dirty: boolean | null;
}

export interface RuntimePackageMetadata {
  name: string;
  version: string;
  packageRoot: string | null;
  git: GitRuntimeMetadata;
}

interface PackageJsonShape {
  name?: unknown;
  version?: unknown;
}

function execGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function readPackageJson(packageJsonPath: string): PackageJsonShape | null {
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as PackageJsonShape;
  } catch {
    return null;
  }
}

function findPackageRoot(startPath: string): string | null {
  let current = fs.statSync(startPath).isDirectory()
    ? startPath
    : path.dirname(startPath);

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (fs.existsSync(packageJsonPath)) return current;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function gitMetadataForPath(packageRoot: string | null): GitRuntimeMetadata {
  if (!packageRoot) {
    return { repoRoot: null, commit: null, branch: null, dirty: null };
  }

  const repoRoot = execGit(["rev-parse", "--show-toplevel"], packageRoot);
  if (!repoRoot) {
    return { repoRoot: null, commit: null, branch: null, dirty: null };
  }

  const commit = execGit(["rev-parse", "--short=12", "HEAD"], repoRoot);
  const branch =
    execGit(["branch", "--show-current"], repoRoot) ||
    execGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  const status = execGit(["status", "--porcelain"], repoRoot);

  return {
    repoRoot,
    commit,
    branch,
    dirty: status === null ? null : status.length > 0,
  };
}

export function getAppRuntimeMetadata(cwd = process.cwd()): RuntimePackageMetadata {
  const packageRoot = fs.existsSync(path.join(cwd, "package.json")) ? cwd : null;
  const packageJson = packageRoot
    ? readPackageJson(path.join(packageRoot, "package.json"))
    : null;

  return {
    name: typeof packageJson?.name === "string" ? packageJson.name : "unknown",
    version: typeof packageJson?.version === "string" ? packageJson.version : "unknown",
    packageRoot,
    git: gitMetadataForPath(packageRoot),
  };
}

export function getInstalledPackageRuntimeMetadata(
  packageName: string,
): RuntimePackageMetadata {
  try {
    const entryPath = require.resolve(packageName);
    const packageRoot = findPackageRoot(fs.realpathSync(entryPath));
    const packageJson = packageRoot
      ? readPackageJson(path.join(packageRoot, "package.json"))
      : null;

    return {
      name: typeof packageJson?.name === "string" ? packageJson.name : packageName,
      version: typeof packageJson?.version === "string" ? packageJson.version : "unknown",
      packageRoot,
      git: gitMetadataForPath(packageRoot),
    };
  } catch {
    return {
      name: packageName,
      version: "unresolved",
      packageRoot: null,
      git: { repoRoot: null, commit: null, branch: null, dirty: null },
    };
  }
}

export function formatRuntimePackageMetadata(
  label: string,
  metadata: RuntimePackageMetadata,
): string {
  const gitParts = [
    `commit=${metadata.git.commit ?? "unavailable"}`,
    `branch=${metadata.git.branch ?? "unavailable"}`,
    `dirty=${metadata.git.dirty === null ? "unknown" : String(metadata.git.dirty)}`,
  ].join(" ");
  const packageRoot = metadata.packageRoot ?? "unresolved";
  const repoRoot = metadata.git.repoRoot ?? "unavailable";

  return `[Runtime] ${label}: ${metadata.name}@${metadata.version} ${gitParts} packageRoot=${packageRoot} repoRoot=${repoRoot}`;
}
