import { afterEach, describe, expect, it } from "vitest";

import { aiRequestLimiter } from "../ai-request-limiter";

// Default per-(provider, model) cap at module-load. Bumped from 3 to 10
// on 2026-06-21 to match Ollama Pro's "10 concurrent per model" upstream
// cap on a single-tenant deployment.
const DEFAULT_MAX = parseInt(process.env.AI_MAX_CONCURRENT || "10", 10);

async function fillBucket(provider: string, model: string | null, n: number) {
  for (let i = 0; i < n; i++) await aiRequestLimiter.acquire(provider, model);
}

function drainBucket(provider: string, model: string | null, n: number) {
  for (let i = 0; i < n; i++) aiRequestLimiter.release(provider, model);
}

afterEach(() => {
  aiRequestLimiter.__resetForTests();
});

describe("aiRequestLimiter — per-(provider, model) buckets", () => {
  it("acquires and releases a slot for a single (provider, model)", async () => {
    await aiRequestLimiter.acquire("ollama", "deepseek-v4-pro:cloud");
    expect(aiRequestLimiter.stats).toContainEqual(
      expect.objectContaining({
        provider: "ollama",
        model: "deepseek-v4-pro:cloud",
        active: 1,
      }),
    );
    aiRequestLimiter.release("ollama", "deepseek-v4-pro:cloud");
    const stats = aiRequestLimiter.stats.find(
      (b) => b.provider === "ollama" && b.model === "deepseek-v4-pro:cloud",
    );
    expect(stats?.active).toBe(0);
  });

  it("different models under the same provider are independent buckets", async () => {
    // Fill the chat model's bucket completely.
    await fillBucket("ollama", "deepseek-v4-pro:cloud", DEFAULT_MAX);
    // A different ollama model — embeddings — should NOT contend.
    const start = Date.now();
    await aiRequestLimiter.acquire("ollama", "nomic-embed-text");
    expect(Date.now() - start).toBeLessThan(50);
    aiRequestLimiter.release("ollama", "nomic-embed-text");
    drainBucket("ollama", "deepseek-v4-pro:cloud", DEFAULT_MAX);
  });

  it("one provider hitting its cap does NOT starve another provider", async () => {
    await fillBucket("ollama", "deepseek-v4-pro:cloud", DEFAULT_MAX);
    const start = Date.now();
    await aiRequestLimiter.acquire("zai", "glm-5.2");
    expect(Date.now() - start).toBeLessThan(50);
    aiRequestLimiter.release("zai", "glm-5.2");
    drainBucket("ollama", "deepseek-v4-pro:cloud", DEFAULT_MAX);
  });

  it("respects per-bucket capacity — the (cap+1)th call queues", async () => {
    await fillBucket("ollama", "kimi-k2.7:cloud", DEFAULT_MAX);

    let resolvedAfter = false;
    const queued = aiRequestLimiter
      .acquire("ollama", "kimi-k2.7:cloud")
      .then(() => {
        resolvedAfter = true;
      });

    await new Promise((r) => setTimeout(r, 25));
    expect(resolvedAfter).toBe(false);

    // Releasing one slot wakes the queued caller.
    aiRequestLimiter.release("ollama", "kimi-k2.7:cloud");
    await queued;
    expect(resolvedAfter).toBe(true);

    drainBucket("ollama", "kimi-k2.7:cloud", DEFAULT_MAX);
  });

  it("error message names the saturated (provider, model) pair", async () => {
    const originalTimeout = process.env.AI_QUEUE_TIMEOUT_MS;
    process.env.AI_QUEUE_TIMEOUT_MS = "150";
    const fresh = await import(
      "../ai-request-limiter?fresh=" + Date.now()
    ).catch(() => null);
    const limiter = fresh?.aiRequestLimiter ?? aiRequestLimiter;

    // Saturate
    for (let i = 0; i < DEFAULT_MAX; i++) {
      await limiter.acquire("ollama", "kimi-k2.7:cloud");
    }

    let caught: Error | null = null;
    try {
      await limiter.acquire("ollama", "kimi-k2.7:cloud");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toMatch(/ollama\/kimi-k2\.7:cloud/);
    expect(caught?.message).toMatch(/no slot opened/);

    process.env.AI_QUEUE_TIMEOUT_MS = originalTimeout;
    for (let i = 0; i < DEFAULT_MAX; i++) {
      limiter.release("ollama", "kimi-k2.7:cloud");
    }
  });

  it("default bucket exists for callers that omit provider and model", async () => {
    await aiRequestLimiter.acquire();
    expect(
      aiRequestLimiter.stats.find(
        (b) => b.provider === "default" && b.model === null,
      )?.active,
    ).toBe(1);
    aiRequestLimiter.release();
  });

  it("provider-only call (no model) is its own bucket distinct from (provider, model)", async () => {
    await aiRequestLimiter.acquire("ollama");
    await aiRequestLimiter.acquire("ollama", "deepseek-v4-pro:cloud");
    const stats = aiRequestLimiter.stats;
    const providerOnly = stats.find(
      (b) => b.provider === "ollama" && b.model === null,
    );
    const withModel = stats.find(
      (b) => b.provider === "ollama" && b.model === "deepseek-v4-pro:cloud",
    );
    expect(providerOnly?.active).toBe(1);
    expect(withModel?.active).toBe(1);
    aiRequestLimiter.release("ollama");
    aiRequestLimiter.release("ollama", "deepseek-v4-pro:cloud");
  });

  it("each (provider, model) has independent stats", async () => {
    await aiRequestLimiter.acquire("ollama", "deepseek-v4-pro:cloud");
    await aiRequestLimiter.acquire("zai", "glm-5.2");
    await aiRequestLimiter.acquire("zai", "glm-5.2");
    const stats = aiRequestLimiter.stats;
    const deep = stats.find(
      (b) => b.provider === "ollama" && b.model === "deepseek-v4-pro:cloud",
    );
    const glm = stats.find(
      (b) => b.provider === "zai" && b.model === "glm-5.2",
    );
    expect(deep?.active).toBe(1);
    expect(glm?.active).toBe(2);
    aiRequestLimiter.release("ollama", "deepseek-v4-pro:cloud");
    aiRequestLimiter.release("zai", "glm-5.2");
    aiRequestLimiter.release("zai", "glm-5.2");
  });

  it("tagged calls go to a separate bucket from the untagged (provider, model)", async () => {
    await fillBucket("ollama", "kimi-k2.7:cloud", DEFAULT_MAX);
    // Untagged bucket is saturated. A tagged call ("claimkit") must NOT
    // contend — it has its own bucket.
    const start = Date.now();
    await aiRequestLimiter.acquire("ollama", "kimi-k2.7:cloud", "claimkit");
    expect(Date.now() - start).toBeLessThan(50);
    const stats = aiRequestLimiter.stats;
    const untagged = stats.find(
      (b) =>
        b.provider === "ollama" && b.model === "kimi-k2.7:cloud" && b.tag === null,
    );
    const tagged = stats.find(
      (b) =>
        b.provider === "ollama" &&
        b.model === "kimi-k2.7:cloud" &&
        b.tag === "claimkit",
    );
    expect(untagged?.active).toBe(DEFAULT_MAX);
    expect(tagged?.active).toBe(1);
    aiRequestLimiter.release("ollama", "kimi-k2.7:cloud", "claimkit");
    drainBucket("ollama", "kimi-k2.7:cloud", DEFAULT_MAX);
  });

  it("aborting a queued caller evicts the ticket and rejects fast", async () => {
    await fillBucket("ollama", "kimi-k2.7:cloud", DEFAULT_MAX);
    const controller = new AbortController();
    const start = Date.now();
    const queued = aiRequestLimiter.acquire(
      "ollama",
      "kimi-k2.7:cloud",
      null,
      controller.signal,
    );
    // Let the ticket land in the queue, then abort.
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    let caught: Error | null = null;
    try {
      await queued;
    } catch (err) {
      caught = err as Error;
    }
    const elapsed = Date.now() - start;
    expect(caught?.message).toMatch(/aborted while queued/);
    // Without the abort path, this would block until the QUEUE_TIMEOUT_MS
    // default of 120s (or until a slot opens, which it never does here).
    expect(elapsed).toBeLessThan(200);
    // And the ticket must NOT linger in the queue — releasing a slot
    // should hand it to nobody, not silently resolve the dead promise.
    const statsBefore = aiRequestLimiter.stats.find(
      (b) =>
        b.provider === "ollama" && b.model === "kimi-k2.7:cloud" && b.tag === null,
    );
    expect(statsBefore?.queued).toBe(0);
    drainBucket("ollama", "kimi-k2.7:cloud", DEFAULT_MAX);
  });

  it("a pre-aborted signal causes acquire to reject without entering the queue", async () => {
    const controller = new AbortController();
    controller.abort();
    let caught: Error | null = null;
    try {
      await aiRequestLimiter.acquire(
        "ollama",
        "kimi-k2.7:cloud",
        null,
        controller.signal,
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/aborted before queue entry/);
  });

  it("abort doesn't disturb other queued callers — they still get woken on release", async () => {
    await fillBucket("ollama", "kimi-k2.7:cloud", DEFAULT_MAX);
    const aborted = new AbortController();
    let abortedCaughtMessage: string | null = null;
    const abortedAcquire = aiRequestLimiter
      .acquire("ollama", "kimi-k2.7:cloud", null, aborted.signal)
      .catch((err: Error) => {
        abortedCaughtMessage = err.message;
      });

    let liveResolved = false;
    const liveAcquire = aiRequestLimiter
      .acquire("ollama", "kimi-k2.7:cloud")
      .then(() => {
        liveResolved = true;
      });

    await new Promise((r) => setTimeout(r, 10));
    aborted.abort();
    await abortedAcquire;
    expect(abortedCaughtMessage).toMatch(/aborted while queued/);
    expect(liveResolved).toBe(false);

    // Release one slot — the live caller (now first in queue) should wake.
    aiRequestLimiter.release("ollama", "kimi-k2.7:cloud");
    await liveAcquire;
    expect(liveResolved).toBe(true);

    aiRequestLimiter.release("ollama", "kimi-k2.7:cloud");
    drainBucket("ollama", "kimi-k2.7:cloud", DEFAULT_MAX - 1);
  });
});
