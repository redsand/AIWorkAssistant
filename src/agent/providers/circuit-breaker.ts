/**
 * Per-(provider, model) circuit breaker.
 *
 * Watches for upstream-class failures (queue timeout, rate limit, server
 * error, connection error, socket hang up) and trips after N consecutive
 * occurrences for the same provider+model. Once tripped, subsequent calls
 * to that pair fail fast for a cooldown period instead of sitting in the
 * limiter queue for AI_QUEUE_TIMEOUT_MS.
 *
 * This was added 2026-06-19 after a 22-in-a-row failure streak on
 * ollama/kimi-k2.7-code:cloud where each call sat in the queue for ~120s
 * before timing out, dragging zai and local-ollama calls down with them.
 *
 * Configuration:
 *   PROVIDER_CIRCUIT_FAILURE_THRESHOLD  failures-in-a-row before tripping (default 3)
 *   PROVIDER_CIRCUIT_COOLDOWN_MS        how long the trip lasts          (default 300000 = 5 min)
 *
 * Success of any kind clears the failure counter and the cooldown.
 *
 * Failures NOT counted:
 *   - user cancellation (AbortError-class)
 *   - 4xx errors (won't repeat unless the request changes)
 */

const FAILURE_THRESHOLD = parseInt(
  process.env.PROVIDER_CIRCUIT_FAILURE_THRESHOLD || "3",
  10,
);
const COOLDOWN_MS = parseInt(
  process.env.PROVIDER_CIRCUIT_COOLDOWN_MS || "300000",
  10,
);

interface BreakerState {
  consecutiveFailures: number;
  degradedUntil: number; // epoch ms; 0 if not currently tripped
  lastError?: string;
}

export interface BreakerSnapshot {
  key: string;
  provider: string;
  model: string;
  consecutiveFailures: number;
  degradedUntil: number;
  isOpen: boolean;
  lastError?: string;
}

/**
 * Recognize failure messages that mean "the upstream is currently unable
 * to serve us" — these are the ones worth tripping on. User cancellation,
 * config errors, etc. are *not* in this set.
 */
function isCircuitWorthyFailure(msg: string): boolean {
  if (!msg) return false;
  // User-initiated aborts should never trip the breaker.
  if (/abort|cancel|cancelled by user/i.test(msg)) return false;
  // Don't trip on shape/auth errors — they won't fix themselves.
  if (/400|401|403|404|invalid|schema|unauthori[sz]ed|forbidden/i.test(msg)) return false;
  return /no slot opened|queued for \d+s|timed? out|rate.?limit|server error \(5\d\d\)|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|stream failed|after \d+ retries|fetch failed/i.test(
    msg,
  );
}

class ProviderCircuitBreaker {
  private readonly state = new Map<string, BreakerState>();

  private key(provider: string, model?: string | null): string {
    return `${provider}/${model || "_default"}`;
  }

  /**
   * Returns an Error if calls are currently short-circuited for this pair,
   * otherwise null. Call this BEFORE acquiring the limiter slot so a tripped
   * breaker fails in microseconds instead of after a queue wait.
   */
  precheck(provider: string, model?: string | null): Error | null {
    const k = this.key(provider, model);
    const s = this.state.get(k);
    if (!s) return null;
    if (s.degradedUntil <= Date.now()) return null;
    const remaining = Math.ceil((s.degradedUntil - Date.now()) / 1000);
    const detail = s.lastError ? ` Last error: ${s.lastError}` : "";
    return new Error(
      `${k} is degraded — circuit breaker tripped after ${s.consecutiveFailures} consecutive failure(s). ` +
        `Cooling down for ~${remaining}s. Switch to a different provider/model or wait.${detail}`,
    );
  }

  /** Mark a successful call. Clears state for this pair. */
  recordSuccess(provider: string, model?: string | null): void {
    this.state.delete(this.key(provider, model));
  }

  /**
   * Record a failure. Trips the breaker if FAILURE_THRESHOLD consecutive
   * circuit-worthy failures have occurred. Non-circuit-worthy failures are
   * ignored (don't count toward the threshold and don't reset it either).
   */
  recordFailure(
    provider: string,
    model: string | null | undefined,
    error: unknown,
  ): void {
    const msg = error instanceof Error ? error.message : String(error);
    if (!isCircuitWorthyFailure(msg)) return;

    const k = this.key(provider, model);
    const prior = this.state.get(k);
    const next: BreakerState = {
      consecutiveFailures: (prior?.consecutiveFailures ?? 0) + 1,
      degradedUntil: prior?.degradedUntil ?? 0,
      lastError: msg.slice(0, 300),
    };
    if (next.consecutiveFailures >= FAILURE_THRESHOLD) {
      next.degradedUntil = Date.now() + COOLDOWN_MS;
    }
    this.state.set(k, next);
  }

  /** Diagnostics: every pair the breaker has ever seen + current state. */
  snapshot(): BreakerSnapshot[] {
    const now = Date.now();
    return Array.from(this.state.entries()).map(([k, s]) => {
      const [provider, model] = k.split("/");
      return {
        key: k,
        provider,
        model,
        consecutiveFailures: s.consecutiveFailures,
        degradedUntil: s.degradedUntil,
        isOpen: s.degradedUntil > now,
        lastError: s.lastError,
      };
    });
  }

  /** Reset all state — for tests. */
  __resetForTests(): void {
    this.state.clear();
  }
}

export const providerCircuitBreaker = new ProviderCircuitBreaker();

// Exposed for tests that need to assert the classification.
export const __test = { isCircuitWorthyFailure };
