/**
 * Package manager detection + install helpers extracted from
 * src/aicoder.ts (2026-06-25). Used after a fresh checkout when the
 * aicoder needs to install dependencies before running tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export type PackageManager = "npm" | "pnpm" | "yarn";

export interface PackageManagerLogger {
  logWork(message: string): void;
  logError(message: string): void;
}

/**
 * Detect which package manager governs `workspace` by lockfile presence.
 * Defaults to npm when no lockfile is found (most permissive — works on
 * a fresh repo with just a package.json).
 */
export function detectPackageManager(workspace: string): PackageManager {
  if (fs.existsSync(path.join(workspace, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(workspace, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Run `<pm> install` in `workspace`. 2 minute hard cap so a broken
 * registry or missing token doesn't hang the whole aicoder cycle.
 *
 * `shell: true` only on Windows because `.cmd` shim resolution on win32
 * requires the shell — on POSIX systems the direct exec works fine.
 */
export function runPackageInstall(
  logger: PackageManagerLogger,
  workspace: string,
  pm: PackageManager,
): { success: boolean; command: string; exitCode: number | null } {
  const cmd = `${pm} install`;
  logger.logWork(`Running ${cmd} in workspace...`);
  const result = spawnSync(pm, ["install"], {
    cwd: workspace,
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 120_000,
    shell: process.platform === "win32",
  });
  if (result.error) {
    logger.logError(`${cmd} spawn error: ${result.error.message}`);
    return { success: false, command: cmd, exitCode: -1 };
  }
  if (result.status !== 0) {
    const tail = result.stderr?.split("\n").slice(-5).join("\n") || "";
    logger.logError(`${cmd} failed (exit ${result.status}): ${tail}`);
    return { success: false, command: cmd, exitCode: result.status };
  }
  return { success: true, command: cmd, exitCode: 0 };
}
