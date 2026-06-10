/**
 * Global rate limiter for the Z.ai API.
 * ZAI_MAX_CONCURRENT and ZAI_QUEUE_TIMEOUT_MS are configurable via .env.
 *
 * Problems solved:
 *  1. Thundering herd — concurrent requests all hit 429 and all retry at the
 *     same time. Now: the first 429 broadcasts a global cooldown; every waiting
 *     request honours it before attempting.
 *  2. Unbounded concurrency — ClaimKit's internal LLM call + the chat agentic
 *     loop can both be hitting Z.ai at the same time. Now: max N simultaneous
 *     HTTP calls; extras queue up.
 *  3. Runaway queues — a stuck session can pile up requests indefinitely. Now:
 *     queue slots time out after ZAI_QUEUE_TIMEOUT_MS.
 *  4. Cascade amplification — multiple 429s in quick succession now temporarily
 *     reduce concurrency to 1 and extend cooldowns.
 */

const DEFAULT_MAX_CONCURRENT = parseInt(process.env.ZAI_MAX_CONCURRENT || "2", 10);
const REDUCED_MAX_CONCURRENT = 1;
const QUEUE_TIMEOUT_MS = parseInt(process.env.ZAI_QUEUE_TIMEOUT_MS || "120000", 10);

/** After this many 429s in the sliding window, throttle down to 1 concurrent. */
const RATE_LIMIT_BURST_THRESHOLD = 3;
/** Sliding window for counting recent 429s. */
const RATE_LIMIT_WINDOW_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ZaiRateLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  /** Timestamp (ms) until which all new attempts should wait. */
  private cooldownUntil = 0;
  /** Sliding window of recent 429 timestamps. */
  private recent429s: number[] = [];
  /** True when we've throttled down because of burst 429s. */
  private burstThrottled = false;

  private getMaxConcurrent(): number {
    return this.burstThrottled ? REDUCED_MAX_CONCURRENT : DEFAULT_MAX_CONCURRENT;
  }

  private pruneRecent429s(now: number): void {
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    this.recent429s = this.recent429s.filter((t) => t > cutoff);
  }

  private checkBurstThrottle(now: number): void {
    this.pruneRecent429s(now);
    const crossed = this.recent429s.length >= RATE_LIMIT_BURST_THRESHOLD;
    if (crossed && !this.burstThrottled) {
      this.burstThrottled = true;
      console.warn(
        `[ZaiRateLimiter] Burst protection: ${this.recent429s.length} 429s in ${RATE_LIMIT_WINDOW_MS / 1000}s — ` +
        `reducing concurrency to ${REDUCED_MAX_CONCURRENT} until rates improve`,
      );
    } else if (!crossed && this.burstThrottled) {
      this.burstThrottled = false;
      console.warn(
        `[ZaiRateLimiter] Burst protection lifted: 429 rate subsided — restoring concurrency to ${DEFAULT_MAX_CONCURRENT}`,
      );
    }
  }

  /**
   * Acquire a concurrency slot. Waits for any global cooldown first, then
   * queues if we're at the concurrency limit. Throws if the queue timeout
   * expires before a slot opens.
   */
  async acquire(): Promise<void> {
    const now = Date.now();
    this.checkBurstThrottle(now);

    // Honour any active global cooldown before entering the queue.
    const coolingFor = this.cooldownUntil - now;
    if (coolingFor > 0) {
      console.warn(`[ZaiRateLimiter] Global cooldown active — waiting ${Math.round(coolingFor / 1000)}s`);
      await sleep(coolingFor);
    }

    const max = this.getMaxConcurrent();
    if (this.active < max) {
      this.active++;
      return;
    }

    // Wait in queue for a slot to open.
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.queue.indexOf(ticket);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new Error(
          `Z.ai request queued for ${QUEUE_TIMEOUT_MS / 1000}s but no slot opened — too many concurrent requests.`,
        ));
      }, QUEUE_TIMEOUT_MS);

      const ticket = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      this.queue.push(ticket);
    });

    this.active++;
  }

  /**
   * Release the current slot and wake the next queued request (if any).
   * Always call this in a finally block after acquire().
   */
  release(): void {
    this.active = Math.max(0, this.active - 1);
    // Re-check cooldown before handing off to the next waiter — if a cooldown
    // was set while this request was running, the next one should honour it.
    const next = this.queue.shift();
    if (next) {
      const coolingFor = this.cooldownUntil - Date.now();
      if (coolingFor > 0) {
        void sleep(coolingFor).then(next);
      } else {
        next();
      }
    }
  }

  /**
   * Called by any request that receives a 429. Broadcasts the cooldown to
   * all currently-queued requests so they hold off rather than pile in.
   */
  reportRateLimit(delayMs: number): void {
    const now = Date.now();
    this.recent429s.push(now);
    this.pruneRecent429s(now);
    this.checkBurstThrottle(now);

    const until = now + delayMs;
    if (until > this.cooldownUntil) {
      this.cooldownUntil = until;
      console.warn(
        `[ZaiRateLimiter] Rate limit hit — global cooldown set for ${Math.round(delayMs / 1000)}s ` +
        `(${this.queue.length} requests queued, ${this.active} active, ` +
        `${this.recent429s.length} 429s in last ${RATE_LIMIT_WINDOW_MS / 1000}s)` +
        (this.burstThrottled ? " [BURST THROTTLE ACTIVE]" : ""),
      );
    }
  }

  get stats() {
    return {
      active: this.active,
      queued: this.queue.length,
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - Date.now()),
      burstThrottled: this.burstThrottled,
      recent429s: this.recent429s.length,
    };
  }
}

export const zaiRateLimiter = new ZaiRateLimiter();
