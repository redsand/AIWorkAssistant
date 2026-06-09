/**
 * Global AI request concurrency limiter.
 *
 * All AI provider HTTP calls (chat + chatStream) acquire a slot from this
 * limiter before executing and release it in a finally block. This prevents
 * any single provider from exhausting upstream connection pools and keeps the
 * UI responsive when multiple subsystems hit AI simultaneously.
 *
 * Configurable via AI_MAX_CONCURRENT (default 3) and AI_QUEUE_TIMEOUT_MS
 * (default 120000).
 */

const MAX_CONCURRENT = parseInt(process.env.AI_MAX_CONCURRENT || "3", 10);
const QUEUE_TIMEOUT_MS = parseInt(process.env.AI_QUEUE_TIMEOUT_MS || "120000", 10);

class AIRequestLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  /**
   * Acquire a concurrency slot. Queues if at the concurrency limit.
   * Throws if the queue timeout expires before a slot opens.
   */
  async acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT) {
      this.active++;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.queue.indexOf(ticket);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(
          new Error(
            `AI request queued for ${QUEUE_TIMEOUT_MS / 1000}s but no slot opened — too many concurrent requests (${MAX_CONCURRENT} max).`,
          ),
        );
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
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  get stats() {
    return {
      active: this.active,
      queued: this.queue.length,
      max: MAX_CONCURRENT,
    };
  }
}

export const aiRequestLimiter = new AIRequestLimiter();
