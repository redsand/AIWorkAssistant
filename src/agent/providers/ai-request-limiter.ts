/**
 * Per-provider AI request concurrency limiter.
 *
 * Each AI provider (ollama, zai, openai, opencode, …) gets its own slot
 * bucket so that one provider hanging upstream cannot starve all other
 * providers of throughput. A single hung Ollama Cloud call used to take
 * a global slot for 5–17 minutes, queueing zai and local-ollama requests
 * until they hit the 120s queue timeout — observed across 22 consecutive
 * Ollama Cloud failures (2026-06-19).
 *
 * Defaults:
 *   - Per-provider concurrency: AI_MAX_CONCURRENT (default 3)
 *   - Per-provider override:    AI_MAX_CONCURRENT_<PROVIDER>=N  (e.g. AI_MAX_CONCURRENT_OLLAMA=2)
 *   - Queue timeout:            AI_QUEUE_TIMEOUT_MS (default 120000)
 *
 * Callers MUST pass their provider name to acquire/release so the bucket
 * accounting stays consistent. Calling acquire() with no name routes to a
 * "default" bucket (used by tests and any legacy caller).
 */

const DEFAULT_MAX_CONCURRENT = parseInt(
  process.env.AI_MAX_CONCURRENT || "3",
  10,
);
const QUEUE_TIMEOUT_MS = parseInt(
  process.env.AI_QUEUE_TIMEOUT_MS || "120000",
  10,
);

function maxForProvider(name: string): number {
  const envKey = `AI_MAX_CONCURRENT_${name.toUpperCase()}`;
  const raw = process.env[envKey];
  if (raw !== undefined && raw !== "") {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_CONCURRENT;
}

class ProviderBucket {
  active = 0;
  readonly queue: Array<() => void> = [];
  constructor(
    public readonly name: string,
    public readonly max: number,
  ) {}
}

class AIRequestLimiter {
  private readonly buckets = new Map<string, ProviderBucket>();

  private getBucket(name: string): ProviderBucket {
    let bucket = this.buckets.get(name);
    if (!bucket) {
      bucket = new ProviderBucket(name, maxForProvider(name));
      this.buckets.set(name, bucket);
    }
    return bucket;
  }

  /**
   * Acquire a concurrency slot from the named provider's bucket. Queues if
   * the bucket is at capacity. Throws if the queue timeout expires.
   */
  async acquire(providerName: string = "default"): Promise<void> {
    const bucket = this.getBucket(providerName);
    if (bucket.active < bucket.max) {
      bucket.active++;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = bucket.queue.indexOf(ticket);
        if (idx !== -1) bucket.queue.splice(idx, 1);
        reject(
          new Error(
            `AI request queued for ${QUEUE_TIMEOUT_MS / 1000}s but no slot opened — too many concurrent requests to ${providerName} (${bucket.max} max).`,
          ),
        );
      }, QUEUE_TIMEOUT_MS);

      const ticket = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      bucket.queue.push(ticket);
    });

    bucket.active++;
  }

  /**
   * Release a slot for the named provider and wake the next queued caller
   * (if any) for that provider. Always call this in a finally block after
   * acquire() with the SAME provider name.
   */
  release(providerName: string = "default"): void {
    const bucket = this.getBucket(providerName);
    bucket.active = Math.max(0, bucket.active - 1);
    const next = bucket.queue.shift();
    if (next) next();
  }

  /** Per-bucket snapshot for diagnostics / health endpoints. */
  get stats(): Array<{
    provider: string;
    active: number;
    queued: number;
    max: number;
  }> {
    return Array.from(this.buckets.values()).map((b) => ({
      provider: b.name,
      active: b.active,
      queued: b.queue.length,
      max: b.max,
    }));
  }

  /** Reset all buckets — for tests. */
  __resetForTests(): void {
    this.buckets.clear();
  }
}

export const aiRequestLimiter = new AIRequestLimiter();
