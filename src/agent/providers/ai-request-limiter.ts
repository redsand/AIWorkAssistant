/**
 * Per-(provider, model) AI request concurrency limiter.
 *
 * Ollama Pro publishes "up to 10 concurrent connections per model" as the
 * upstream cap. To take full advantage we slot the limiter by both
 * provider AND model so a chat request on deepseek-v4-pro:cloud doesn't
 * contend with an embedding request on nomic-embed-text or a ClaimKit
 * extractor on a third model. Previously the bucket was keyed on
 * provider only and the three models shared one budget of 3, which
 * starved chat whenever ingestion was active.
 *
 * Defaults (2026-06-21 update, sized for Ollama Pro + sole tenant):
 *   - Per-(provider, model) concurrency: AI_MAX_CONCURRENT (default 10)
 *   - Per-provider override:    AI_MAX_CONCURRENT_<PROVIDER>=N    (applies to every model under that provider)
 *   - Per-(provider, model):    AI_MAX_CONCURRENT_<PROVIDER>__<MODEL>=N  (most specific wins)
 *   - Queue timeout:            AI_QUEUE_TIMEOUT_MS (default 120000)
 *
 * Callers MUST pass their provider name to acquire/release. The model
 * name is optional but strongly recommended — without it everything
 * under that provider shares one bucket (which is what the old code
 * did, kept for tests that don't know the model).
 */

const DEFAULT_MAX_CONCURRENT = parseInt(
  process.env.AI_MAX_CONCURRENT || "10",
  10,
);
const QUEUE_TIMEOUT_MS = parseInt(
  process.env.AI_QUEUE_TIMEOUT_MS || "120000",
  10,
);

/**
 * Sanitize a provider or model name into a stable, upper-case env-var
 * fragment. We allow A-Z, 0-9, and underscore; everything else (including
 * `:`, `/`, `.`, `-`) collapses to underscore so a model like
 * `deepseek-v4-pro:cloud` becomes `DEEPSEEK_V4_PRO_CLOUD`.
 */
function sanitizeForEnv(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9_]+/g, "_");
}

function maxForBucket(providerName: string, modelName: string | null): number {
  const providerSlug = sanitizeForEnv(providerName);
  // Most specific: AI_MAX_CONCURRENT_<PROVIDER>__<MODEL>
  if (modelName) {
    const modelSlug = sanitizeForEnv(modelName);
    const perModel = process.env[`AI_MAX_CONCURRENT_${providerSlug}__${modelSlug}`];
    if (perModel !== undefined && perModel !== "") {
      const n = parseInt(perModel, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  // Provider-wide
  const perProvider = process.env[`AI_MAX_CONCURRENT_${providerSlug}`];
  if (perProvider !== undefined && perProvider !== "") {
    const n = parseInt(perProvider, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_CONCURRENT;
}

function bucketKey(providerName: string, modelName: string | null): string {
  return modelName ? `${providerName}::${modelName}` : providerName;
}

class ConcurrencyBucket {
  active = 0;
  readonly queue: Array<() => void> = [];
  constructor(
    public readonly provider: string,
    public readonly model: string | null,
    public readonly max: number,
  ) {}
}

class AIRequestLimiter {
  private readonly buckets = new Map<string, ConcurrencyBucket>();

  private getBucket(providerName: string, modelName: string | null): ConcurrencyBucket {
    const key = bucketKey(providerName, modelName);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new ConcurrencyBucket(
        providerName,
        modelName,
        maxForBucket(providerName, modelName),
      );
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  /**
   * Acquire a concurrency slot for the named (provider, model). The model
   * is optional; omit only when the caller doesn't know it (legacy / test
   * paths). Queues if the bucket is at capacity. Throws if the queue
   * timeout expires.
   */
  async acquire(providerName: string = "default", modelName: string | null = null): Promise<void> {
    const bucket = this.getBucket(providerName, modelName);
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
        const target = modelName ? `${providerName}/${modelName}` : providerName;
        reject(
          new Error(
            `AI request queued for ${QUEUE_TIMEOUT_MS / 1000}s but no slot opened — too many concurrent requests to ${target} (${bucket.max} max).`,
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
   * Release a slot for the named (provider, model) and wake the next
   * queued caller (if any). MUST match the (provider, model) used at
   * acquire(); otherwise the wrong bucket's count drifts.
   */
  release(providerName: string = "default", modelName: string | null = null): void {
    const bucket = this.getBucket(providerName, modelName);
    bucket.active = Math.max(0, bucket.active - 1);
    const next = bucket.queue.shift();
    if (next) next();
  }

  /** Per-bucket snapshot for diagnostics / health endpoints. */
  get stats(): Array<{
    provider: string;
    model: string | null;
    active: number;
    queued: number;
    max: number;
  }> {
    return Array.from(this.buckets.values()).map((b) => ({
      provider: b.provider,
      model: b.model,
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
