import { afterEach, describe, expect, it } from "vitest";

import { aiRequestLimiter } from "../ai-request-limiter";

afterEach(() => {
  aiRequestLimiter.__resetForTests();
});

describe("aiRequestLimiter — per-provider buckets", () => {
  it("acquires and releases a slot for a single provider", async () => {
    await aiRequestLimiter.acquire("ollama");
    expect(aiRequestLimiter.stats).toContainEqual(
      expect.objectContaining({ provider: "ollama", active: 1 }),
    );
    aiRequestLimiter.release("ollama");
    expect(
      aiRequestLimiter.stats.find((b) => b.provider === "ollama")?.active,
    ).toBe(0);
  });

  it("one provider hitting its cap does NOT starve another provider", async () => {
    // Default max=3. Fill ollama bucket completely.
    await aiRequestLimiter.acquire("ollama");
    await aiRequestLimiter.acquire("ollama");
    await aiRequestLimiter.acquire("ollama");

    // zai should still be able to acquire without queuing.
    const start = Date.now();
    await aiRequestLimiter.acquire("zai");
    expect(Date.now() - start).toBeLessThan(50);
    aiRequestLimiter.release("zai");

    // Cleanup
    aiRequestLimiter.release("ollama");
    aiRequestLimiter.release("ollama");
    aiRequestLimiter.release("ollama");
  });

  it("respects per-bucket capacity — a 4th ollama call queues even with zai slots free", async () => {
    await aiRequestLimiter.acquire("ollama");
    await aiRequestLimiter.acquire("ollama");
    await aiRequestLimiter.acquire("ollama");

    let fourthResolved = false;
    const fourth = aiRequestLimiter.acquire("ollama").then(() => {
      fourthResolved = true;
    });

    // Give the event loop a tick — bucket is full, fourth should NOT resolve.
    await new Promise((r) => setTimeout(r, 25));
    expect(fourthResolved).toBe(false);

    // Releasing a slot wakes the fourth caller.
    aiRequestLimiter.release("ollama");
    await fourth;
    expect(fourthResolved).toBe(true);

    aiRequestLimiter.release("ollama");
    aiRequestLimiter.release("ollama");
    aiRequestLimiter.release("ollama");
  });

  it("error message names the saturated provider", async () => {
    const originalTimeout = process.env.AI_QUEUE_TIMEOUT_MS;
    process.env.AI_QUEUE_TIMEOUT_MS = "150";
    // Module-load reads env, but we already loaded it. Re-import to pick up new env.
    const fresh = await import(
      "../ai-request-limiter?fresh=" + Date.now()
    ).catch(() => null);
    const limiter = fresh?.aiRequestLimiter ?? aiRequestLimiter;

    await limiter.acquire("ollama");
    await limiter.acquire("ollama");
    await limiter.acquire("ollama");

    let caught: Error | null = null;
    try {
      await limiter.acquire("ollama");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toMatch(/ollama/);
    expect(caught?.message).toMatch(/no slot opened/);

    process.env.AI_QUEUE_TIMEOUT_MS = originalTimeout;
    limiter.release("ollama");
    limiter.release("ollama");
    limiter.release("ollama");
  });

  it("default bucket exists for callers that omit the provider name", async () => {
    await aiRequestLimiter.acquire();
    expect(
      aiRequestLimiter.stats.find((b) => b.provider === "default")?.active,
    ).toBe(1);
    aiRequestLimiter.release();
  });

  it("each provider has independent stats", async () => {
    await aiRequestLimiter.acquire("ollama");
    await aiRequestLimiter.acquire("zai");
    await aiRequestLimiter.acquire("zai");
    const stats = aiRequestLimiter.stats;
    const ollama = stats.find((b) => b.provider === "ollama");
    const zai = stats.find((b) => b.provider === "zai");
    expect(ollama?.active).toBe(1);
    expect(zai?.active).toBe(2);
    aiRequestLimiter.release("ollama");
    aiRequestLimiter.release("zai");
    aiRequestLimiter.release("zai");
  });
});
