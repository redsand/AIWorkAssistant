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
 */

const MAX_CONCURRENT = parseInt(process.env.ZAI_MAX_CONCURRENT || "2", 10);
const QUEUE_TIMEOUT_MS = parseInt(process.env.ZAI_QUEUE_TIMEOUT_MS || "120000", 10);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ZaiRateLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  /** Timestamp (ms) until which all new attempts should wait. */
  private cooldownUntil = 0;

  /**
   * Acquire a concurrency slot. Waits for any global cooldown first, then
   * queues if we're at the concurrency limit. Throws if the queue timeout
   * expires before a slot opens.
   */
  async acquire(): Promise<void> {
    // Honour any active global cooldown before entering the queue.
    const coolingFor = this.cooldownUntil - Date.now();
    if (coolingFor > 0) {
      console.warn(`[ZaiRateLimiter] Global cooldown active — waiting ${Math.round(coolingFor / 1000)}s`);
      await sleep(coolingFor);
    }

    if (this.active < MAX_CONCURRENT) {
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
    const until = Date.now() + delayMs;
    if (until > this.cooldownUntil) {
      this.cooldownUntil = until;
      console.warn(
        `[ZaiRateLimiter] Rate limit hit — global cooldown set for ${Math.round(delayMs / 1000)}s ` +
        `(${this.queue.length} requests queued, ${this.active} active)`,
      );
    }
  }

  get stats() {
    return {
      active: this.active,
      queued: this.queue.length,
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - Date.now()),
    };
  }
}

export const zaiRateLimiter = new ZaiRateLimiter();
