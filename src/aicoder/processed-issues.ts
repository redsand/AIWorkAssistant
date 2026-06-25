/**
 * Wrappers around the persistent processed-issues + retry-circuit state.
 * Extracted from src/aicoder.ts (2026-06-25).
 *
 * Two layers of "don't process this again" guard:
 *
 *   1. `processedIssues` Set + DB ledger — survives across runs, used by
 *      the polling loop to skip already-completed issues without
 *      re-reading them from the source. Persisted via agentRunDatabase
 *      so a new aicoder process picks up where the last one left off.
 *
 *   2. `ProcessRetryCircuit` — counts crash-loop failures inside the
 *      current process and short-circuits after N (default 3) attempts
 *      in M (default 10 min) ms. Decoupled from the persistent
 *      blacklist so a tight loop can never burn through retries even
 *      with FORCE_REPROCESS set.
 *
 * Workspace + DB + logger are constructor params so the store is
 * testable against fakes.
 */
import type { ProcessRetryCircuit } from "../autonomous-loop/process-retry-circuit";

export interface ProcessedIssuesDb {
  listProcessedIssues(workspace: string): string[];
  markIssueProcessed(issueKey: string, workspace: string): void;
}

export interface ProcessedIssuesLogger {
  logConfig(message: string): void;
  logWork(message: string): void;
}

export interface ProcessedIssuesOptions {
  workspace: string;
  db: ProcessedIssuesDb;
  circuit: ProcessRetryCircuit;
  logger: ProcessedIssuesLogger;
}

export class ProcessedIssuesStore {
  private readonly processed = new Set<string>();

  constructor(private readonly opts: ProcessedIssuesOptions) {}

  /** Restore the in-memory set from the DB. Call once at startup. */
  load(): void {
    try {
      const keys = this.opts.db.listProcessedIssues(this.opts.workspace);
      keys.forEach((id) => this.processed.add(id));
      if (this.processed.size > 0) {
        this.opts.logger.logConfig(
          `Resumed with ${this.processed.size} previously processed issue(s)`,
        );
      }
    } catch {
      // DB not available — start fresh
    }
  }

  has(issueKey: string): boolean {
    return this.processed.has(issueKey);
  }

  size(): number {
    return this.processed.size;
  }

  delete(issueKey: string): void {
    this.processed.delete(issueKey);
  }

  save(issueKey: string): void {
    this.processed.add(issueKey);
    try {
      this.opts.db.markIssueProcessed(issueKey, this.opts.workspace);
    } catch (err) {
      this.opts.logger.logWork(
        `Could not persist processed issue: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // ── Crash-loop circuit ────────────────────────────────────────────────

  recordFailure(issueKey: string): void {
    this.opts.circuit.recordFailure(this.opts.workspace, issueKey);
  }

  clearFailures(issueKey: string): void {
    this.opts.circuit.clear(this.opts.workspace, issueKey);
  }

  checkRetryCircuit(issueKey: string): string | null {
    return this.opts.circuit.check(this.opts.workspace, issueKey);
  }
}
