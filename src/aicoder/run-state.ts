/**
 * Per-issue pipeline checkpoint persistence.
 *
 * Each aicoder cycle writes the current `checkpoint` field to
 * `<workspace>/.aicoder/run-state-<issueKey>.json` after every stage. If the
 * process is killed mid-cycle, the next start reads the file back and
 * resumes from the last stage rather than redoing the whole pipeline.
 *
 * Per-issue file isolation (one file per issueKey) is what lets concurrent
 * aicoder processes work on different issues from the same workspace
 * without trampling each other's state. Legacy unkeyed `run-state.json` is
 * still read on fallback for runs that started before the per-key scheme.
 *
 * Extracted from src/aicoder.ts (~70 lines) as a proof-of-pattern for the
 * larger aicoder.ts split. Logic is byte-identical to the original — the
 * only change is that workspace + target issue key + logger are now
 * constructor parameters instead of module-level reads, which lets us
 * unit-test the store in isolation.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { RunState } from "../autonomous-loop/types";

export interface RunStateLogger {
  logWork(message: string): void;
}

export interface RunStateStoreOptions {
  /** Workspace root — `.aicoder/` is created underneath it. */
  workspace: string;
  /**
   * Issue key to prefer when scanning for any existing state file (set when
   * the CLI was invoked with `--issue <key>`). May be null/undefined.
   */
  targetIssueKey?: string | null;
  /** Optional logger for non-fatal persistence failures. */
  logger?: RunStateLogger;
}

export class RunStateStore {
  constructor(private readonly opts: RunStateStoreOptions) {}

  /** Absolute path of the state file for a given issue key (or the legacy unkeyed file). */
  filePath(issueKey?: string): string {
    const base = path.join(this.opts.workspace || process.cwd(), ".aicoder");
    const name = issueKey ? `run-state-${issueKey}.json` : "run-state.json";
    return path.join(base, name);
  }

  /**
   * Load state for `issueKey`. Falls back to the legacy unkeyed file if no
   * per-issue file exists. Returns null on missing/corrupt files (never throws).
   */
  load(issueKey?: string): RunState | null {
    const filePath = this.filePath(issueKey);
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (data && data.checkpoint && data.issueKey) {
          return data as RunState;
        }
      }
    } catch {
      // File doesn't exist or is corrupt — start fresh
    }
    // Legacy fallback: if no per-issue file found, try the old unkeyed file.
    if (issueKey) {
      return this.load();
    }
    return null;
  }

  /**
   * Scan `.aicoder/` for the first valid `run-state-*.json`. Prefers the
   * caller's targetIssueKey when set so a `--issue X` CLI invocation
   * resumes X (not whichever happens to come first in readdir order).
   */
  findExisting(): RunState | null {
    if (this.opts.targetIssueKey) {
      const state = this.load(this.opts.targetIssueKey);
      if (state) return state;
    }
    const dir = path.join(this.opts.workspace || process.cwd(), ".aicoder");
    try {
      if (!fs.existsSync(dir)) return null;
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith("run-state-") && entry.endsWith(".json")) {
          const key = entry.slice("run-state-".length, -".json".length);
          const state = this.load(key);
          if (state) return state;
        }
      }
    } catch {
      // Non-fatal
    }
    return this.load();
  }

  /** Atomically-ish overwrite the state file (no temp-file rename — single-writer assumption). */
  save(state: RunState, issueKey?: string): void {
    const key = issueKey || state.issueKey;
    const filePath = this.filePath(key);
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      state.updatedAt = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
    } catch (err) {
      this.opts.logger?.logWork(
        `Could not persist run state: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Delete the state file for an issue. No-op if missing. Never throws. */
  clear(issueKey?: string): void {
    const filePath = this.filePath(issueKey);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Non-fatal
    }
  }
}
