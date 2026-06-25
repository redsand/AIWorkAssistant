/**
 * Thin git-diff query helpers extracted from src/aicoder.ts (2026-06-25).
 *
 * `getChangedFiles` returns the list of files changed between two refs.
 * `summarizeDiffStat` extracts the summary line ("N files changed,...")
 * from a `git diff --stat` payload.
 *
 * Both delegate to gitRunWithOutput (from autonomous-loop/git-ops) so they
 * inherit the same git executable resolution and error handling as the
 * rest of the pipeline.
 */
import { gitRunWithOutput } from "../autonomous-loop/git-ops";

export function getChangedFiles(
  workspace: string,
  fromRef: string,
  toRef: string = "HEAD",
): string[] {
  const result = gitRunWithOutput(
    ["diff", "--name-only", `${fromRef}...${toRef}`],
    workspace,
  );
  if (!result.ok) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Pull the summary line out of `git diff --stat` output (the last
 * non-blank line, which is the "N files changed, +X insertions, -Y
 * deletions" tally). Returns empty string when the stat is empty.
 */
export function summarizeDiffStat(stat: string): string {
  const lines = stat
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-1)[0] ?? "";
}
