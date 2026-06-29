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

function maxForBucket(
  providerName: string,
  modelName: string | null,
  tag: string | null,
): number {
  const providerSlug = sanitizeForEnv(providerName);
  // Most specific: AI_MAX_CONCURRENT_<PROVIDER>__<MODEL>__<TAG>
  if (modelName && tag) {
    const modelSlug = sanitizeForEnv(modelName);
    const tagSlug = sanitizeForEnv(tag);
    const perTag = process.env[`AI_MAX_CONCURRENT_${providerSlug}__${modelSlug}__${tagSlug}`];
    if (perTag !== undefined && perTag !== "") {
      const n = parseInt(perTag, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  // Per-(provider, model)
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

function bucketKey(
  providerName: string,
  modelName: string | null,
  tag: string | null,
): string {
  const base = modelName ? `${providerName}::${modelName}` : providerName;
  return tag ? `${base}#${tag}` : base;
}

/**
 * One acquired slot. Tracking the acquire timestamp lets the periodic
 * reaper detect "leaked" slots (a provider call that started but never
 * released because of an unhandled exception, a missed finally, or a
 * generator that was never iterated to completion). Without this, leaked
 * slots accumulate and eventually starve the bucket — we observed
 * ollama/deepseek-v4-pro:cloud sitting at 7/10 with no in-flight chat
 * (2026-06-21).
 */
interface AcquiredSlot {
  id: number;
  acquiredAt: number;
}

// 2-minute reaper window — well past any normal Ollama Cloud streaming
// chat (typical 10-60s) but short enough that leaked slots self-heal
// before the bucket fills. Was 10 min initially; observed in production
// (2026-06-21) that ClaimKit query-time seeding fires fire-and-forget
// LLM calls whose slots can hang around for the full axios timeout
// (~120s) and saturate the bucket within a few chat turns.
const MAX_SLOT_AGE_MS = (() => {
  const raw = process.env.AI_SLOT_MAX_AGE_MS;
  if (!raw) return 2 * 60 * 1000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 2 * 60 * 1000;
})();

// Also poll more often so reclaim is responsive even when a burst hits.
const SLOT_REAPER_INTERVAL_MS = 15_000;

/**
 * A queue entry. We carry both the resolver (to wake the caller when a
 * slot opens) and a rejecter so an aborted caller can be evicted and
 * told why. Tracking it as an object instead of a bare function lets the
 * abort path splice the right ticket out of the queue.
 */
interface QueueTicket {
  resolve: () => void;
  reject: (err: Error) => void;
}

class ConcurrencyBucket {
  readonly slots = new Map<number, AcquiredSlot>();
  readonly queue: QueueTicket[] = [];
  constructor(
    public readonly provider: string,
    public readonly model: string | null,
    public readonly tag: string | null,
    public readonly max: number,
  ) {}

  get active(): number {
    return this.slots.size;
  }
}

class AIRequestLimiter {
  private readonly buckets = new Map<string, ConcurrencyBucket>();
  private nextSlotId = 1;
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodic stale-slot reaper. Without this, a leaked slot (provider
    // call started but never released — observed cause: external abort
    // racing the finally) accumulates forever and starves the bucket. The
    // reaper is a defense-in-depth measure; the right fix for a leak is
    // still to find and patch the missing release.
    if (typeof setInterval === "function") {
      this.reaperTimer = setInterval(() => this.reapStaleSlots(), SLOT_REAPER_INTERVAL_MS);
      if (typeof this.reaperTimer.unref === "function") this.reaperTimer.unref();
    }
  }

  private getBucket(
    providerName: string,
    modelName: string | null,
    tag: string | null,
  ): ConcurrencyBucket {
    const key = bucketKey(providerName, modelName, tag);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new ConcurrencyBucket(
        providerName,
        modelName,
        tag,
        maxForBucket(providerName, modelName, tag),
      );
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  /**
   * Acquire a concurrency slot for the named (provider, model[, tag]).
   * The model is optional; omit only when the caller doesn't know it
   * (legacy / test paths). The tag is an opt-in "lane" that gives a
   * caller its own isolated slot pool (e.g. ClaimKit's background
   * extracts shouldn't share the foreground chat's bucket — pass
   * tag="claimkit" to put them in `ollama::model#claimkit`).
   *
   * Queues if the bucket is at capacity. Throws if the queue timeout
   * expires OR if the optional signal aborts while we're queued. The
   * signal-driven eviction is the load-bearing fix for callers (like
   * ClaimKit) whose per-attempt timer can fire before the queue slot
   * opens — without it, the caller's AbortController would already be
   * aborted by the time axios was finally invoked, and every "timed out"
   * log entry would actually represent a request that never left the
   * queue. Returns a slot id the caller MUST pass to release.
   */
  async acquire(
    providerName: string = "default",
    modelName: string | null = null,
    tagOrSignal?: string | null | AbortSignal,
    maybeSignal?: AbortSignal,
  ): Promise<number> {
    // Overload-resolution: callers that don't tag can still pass a signal as
    // the 3rd arg. Detect AbortSignal duck-typed (handles polyfills).
    let tag: string | null = null;
    let signal: AbortSignal | undefined;
    if (
      tagOrSignal &&
      typeof tagOrSignal === "object" &&
      "aborted" in tagOrSignal &&
      typeof (tagOrSignal as AbortSignal).addEventListener === "function"
    ) {
      signal = tagOrSignal as AbortSignal;
    } else {
      tag = (tagOrSignal as string | null | undefined) ?? null;
      signal = maybeSignal;
    }

    if (signal?.aborted) {
      // Don't even enter the queue — caller already gave up.
      throw new Error("AI request aborted before queue entry");
    }

    const bucket = this.getBucket(providerName, modelName, tag);

    while (bucket.active >= bucket.max) {
      let evict: (() => void) | null = null;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const ticket: QueueTicket = {
          resolve: () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (evict) signal?.removeEventListener("abort", evict);
            resolve();
          },
          reject: (err: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (evict) signal?.removeEventListener("abort", evict);
            const idx = bucket.queue.indexOf(ticket);
            if (idx !== -1) bucket.queue.splice(idx, 1);
            reject(err);
          },
        };
        const timer = setTimeout(() => {
          const target = modelName ? `${providerName}/${modelName}` : providerName;
          ticket.reject(
            new Error(
              `AI request queued for ${QUEUE_TIMEOUT_MS / 1000}s but no slot opened — too many concurrent requests to ${target} (${bucket.max} max).`,
            ),
          );
        }, QUEUE_TIMEOUT_MS);
        if (signal) {
          evict = () => {
            ticket.reject(new Error("AI request aborted while queued"));
          };
          signal.addEventListener("abort", evict, { once: true });
        }
        bucket.queue.push(ticket);
      });
      // After being woken: loop guards against the race where another
      // acquire snuck in via fast-path between release() decrementing and
      // us being scheduled.
    }

    const id = this.nextSlotId++;
    bucket.slots.set(id, { id, acquiredAt: Date.now() });
    return id;
  }

  /**
   * Release a slot for the named (provider, model[, tag]). Pass the slot
   * id returned by acquire so we can detect double-release. Wakes the
   * next queued caller (if any). The tag must match what was passed to
   * acquire — different lanes have separate buckets.
   */
  release(
    providerName: string = "default",
    modelName: string | null = null,
    slotIdOrTag?: number | string | null,
    maybeSlotId?: number,
  ): void {
    // Overload: legacy callers pass (provider, model, slotId). New callers
    // pass (provider, model, tag, slotId). Disambiguate by type.
    let tag: string | null = null;
    let slotId: number | undefined;
    if (typeof slotIdOrTag === "number") {
      slotId = slotIdOrTag;
    } else {
      tag = slotIdOrTag ?? null;
      slotId = maybeSlotId;
    }

    const bucket = this.getBucket(providerName, modelName, tag);
    if (slotId !== undefined) {
      bucket.slots.delete(slotId);
    } else {
      // Legacy no-id release — drop the oldest slot in the bucket so the
      // count stays correct. Tests and any forgotten caller path.
      const oldest = bucket.slots.keys().next().value;
      if (oldest !== undefined) bucket.slots.delete(oldest);
    }
    const next = bucket.queue.shift();
    if (next) next.resolve();
  }

  /**
   * Walk every bucket and forcibly release slots older than
   * AI_SLOT_MAX_AGE_MS. Runs on a setInterval; safe to call manually.
   * Returns the count of slots reaped.
   */
  reapStaleSlots(): number {
    const now = Date.now();
    let reaped = 0;
    for (const bucket of this.buckets.values()) {
      for (const slot of [...bucket.slots.values()]) {
        if (now - slot.acquiredAt > MAX_SLOT_AGE_MS) {
          bucket.slots.delete(slot.id);
          reaped++;
          const ageS = Math.round((now - slot.acquiredAt) / 1000);
          const target = bucket.model
            ? `${bucket.provider}/${bucket.model}`
            : bucket.provider;
          console.warn(
            `[aiRequestLimiter] reaped stale slot ${slot.id} on ${target} (age ${ageS}s > ${MAX_SLOT_AGE_MS / 1000}s). ` +
              `This indicates a leak — a provider call acquired but never released.`,
          );
          const next = bucket.queue.shift();
          if (next) next.resolve();
        }
      }
    }
    return reaped;
  }

  /**
   * Per-bucket snapshot for diagnostics / health endpoints. Includes the
   * oldest slot age so the operator can see when leaks are accumulating.
   */
  get stats(): Array<{
    provider: string;
    model: string | null;
    tag: string | null;
    active: number;
    queued: number;
    max: number;
    oldestSlotAgeMs: number | null;
  }> {
    const now = Date.now();
    return Array.from(this.buckets.values()).map((b) => {
      let oldestAge: number | null = null;
      for (const s of b.slots.values()) {
        const age = now - s.acquiredAt;
        if (oldestAge === null || age > oldestAge) oldestAge = age;
      }
      return {
        provider: b.provider,
        model: b.model,
        tag: b.tag,
        active: b.active,
        queued: b.queue.length,
        max: b.max,
        oldestSlotAgeMs: oldestAge,
      };
    });
  }

  /**
   * Force-clear all slots in every bucket. Used by the admin reset
   * endpoint when an operator confirms a leak and wants to recover
   * without restarting the process. Wakes every queued caller.
   */
  clearAllSlots(): number {
    let cleared = 0;
    for (const bucket of this.buckets.values()) {
      cleared += bucket.slots.size;
      bucket.slots.clear();
      while (bucket.queue.length > 0) {
        const next = bucket.queue.shift();
        if (next) next.resolve();
      }
    }
    return cleared;
  }

  /** Reset all buckets — for tests. */
  __resetForTests(): void {
    this.buckets.clear();
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    this.reaperTimer = null;
  }
}

export const aiRequestLimiter = new AIRequestLimiter();
