/**
 * Process-local rapid-failure circuit for aicoder issue processing.
 *
 * The DB-backed `failed_attempts` ladder works for normal flow but
 * FORCE_REPROCESS bypasses it. Without an in-process check, a tight
 * crash loop (e.g. agent CLI exits with code 1 in 8s every time) keeps
 * retrying forever — observed: issue #50 burned through 103 attempts
 * in ~3 hours on 2026-06-18 before the persistent ladder eventually
 * caught up.
 *
 * This circuit tracks failures per (workspace, issueKey) inside the
 * current process and refuses further attempts once the threshold is
 * hit. It fires regardless of FORCE_REPROCESS — that flag is meant to
 * override the *persistent* blacklist after a real fix, not to allow
 * an actively-crashing loop. Restart the process or wait out the
 * window to retry.
 */

interface RetryState {
  count: number;
  firstFailAt: number;
  lastFailAt: number;
}

export interface ProcessRetryCircuitOptions {
  /**
   * Maximum failures allowed within the window before the circuit trips.
   * Default 3.
   */
  maxFailures?: number;
  /**
   * Sliding window in milliseconds. After this much time without a new
   * failure, the count resets. Default 10 minutes.
   */
  windowMs?: number;
  /**
   * Time source — injectable for tests. Defaults to Date.now.
   */
  now?: () => number;
}

export class ProcessRetryCircuit {
  private readonly state = new Map<string, RetryState>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: ProcessRetryCircuitOptions = {}) {
    this.maxFailures =
      opts.maxFailures !== undefined && opts.maxFailures > 0
        ? opts.maxFailures
        : 3;
    this.windowMs =
      opts.windowMs !== undefined && opts.windowMs > 0
        ? opts.windowMs
        : 10 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  private keyFor(workspace: string, issueKey: string): string {
    return `${workspace}::${issueKey}`;
  }

  /**
   * Returns null if processing may continue, otherwise a reason string
   * that the caller can log and surface to the operator. Auto-expires
   * stale state (outside the window) before checking.
   */
  check(workspace: string, issueKey: string): string | null {
    const key = this.keyFor(workspace, issueKey);
    const state = this.state.get(key);
    if (!state) return null;
    const now = this.now();
    if (now - state.firstFailAt > this.windowMs) {
      this.state.delete(key);
      return null;
    }
    if (state.count >= this.maxFailures) {
      const ageS = Math.round((now - state.firstFailAt) / 1000);
      const remainingS = Math.max(
        0,
        Math.round((this.windowMs - (now - state.firstFailAt)) / 1000),
      );
      return (
        `process-local circuit: ${issueKey} failed ${state.count} time(s) in the last ${ageS}s ` +
        `in this aicoder process. Refusing further attempts for ~${remainingS}s. ` +
        `Restart the process or wait out the window to retry.`
      );
    }
    return null;
  }

  /**
   * Record a failure for (workspace, issueKey). If the prior failure was
   * outside the window, this starts a fresh count of 1; otherwise the
   * count increments.
   */
  recordFailure(workspace: string, issueKey: string): void {
    const key = this.keyFor(workspace, issueKey);
    const now = this.now();
    const prior = this.state.get(key);
    if (!prior || now - prior.firstFailAt > this.windowMs) {
      this.state.set(key, { count: 1, firstFailAt: now, lastFailAt: now });
      return;
    }
    this.state.set(key, {
      count: prior.count + 1,
      firstFailAt: prior.firstFailAt,
      lastFailAt: now,
    });
  }

  /**
   * Clear failures for (workspace, issueKey). Called on success so a
   * legitimate completion resets the budget.
   */
  clear(workspace: string, issueKey: string): void {
    this.state.delete(this.keyFor(workspace, issueKey));
  }

  /** Diagnostics. */
  snapshot(): Array<{ key: string; state: RetryState }> {
    return Array.from(this.state.entries()).map(([key, state]) => ({
      key,
      state: { ...state },
    }));
  }

  /** Test helper. */
  __resetForTests(): void {
    this.state.clear();
  }
}
