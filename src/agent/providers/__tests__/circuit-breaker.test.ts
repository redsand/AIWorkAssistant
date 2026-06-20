import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  providerCircuitBreaker,
  __test as breakerInternals,
} from "../circuit-breaker";

beforeAll(() => {
  // Ensure deterministic thresholds. The module reads env at import time;
  // tests below rely on the defaults (threshold=3, cooldown=300000ms).
});

afterEach(() => {
  providerCircuitBreaker.__resetForTests();
});

describe("providerCircuitBreaker — failure classification", () => {
  const { isCircuitWorthyFailure } = breakerInternals;

  it("counts upstream rate-limit / queue-saturation errors", () => {
    expect(
      isCircuitWorthyFailure(
        "AI request queued for 120s but no slot opened — too many concurrent requests",
      ),
    ).toBe(true);
    expect(isCircuitWorthyFailure("rate limit exceeded")).toBe(true);
    expect(
      isCircuitWorthyFailure("Ollama API request failed after 2 retries"),
    ).toBe(true);
  });

  it("counts upstream connection / server errors", () => {
    expect(isCircuitWorthyFailure("ECONNREFUSED 127.0.0.1:11434")).toBe(true);
    expect(isCircuitWorthyFailure("socket hang up")).toBe(true);
    expect(isCircuitWorthyFailure("Server error (502)")).toBe(true);
    expect(isCircuitWorthyFailure("stream failed")).toBe(true);
    expect(isCircuitWorthyFailure("ETIMEDOUT")).toBe(true);
  });

  it("does NOT count user cancellations or 4xx config errors", () => {
    expect(isCircuitWorthyFailure("aborted by user")).toBe(false);
    expect(isCircuitWorthyFailure("Run cancelled by user")).toBe(false);
    expect(isCircuitWorthyFailure("400 invalid request shape")).toBe(false);
    expect(isCircuitWorthyFailure("401 unauthorized")).toBe(false);
    expect(isCircuitWorthyFailure("403 forbidden")).toBe(false);
    expect(isCircuitWorthyFailure("404 model not found")).toBe(false);
  });

  it("ignores empty / unknown messages", () => {
    expect(isCircuitWorthyFailure("")).toBe(false);
    expect(isCircuitWorthyFailure("something weird happened")).toBe(false);
  });
});

describe("providerCircuitBreaker — trip behavior", () => {
  it("does not trip on first or second consecutive failure", () => {
    providerCircuitBreaker.recordFailure(
      "ollama",
      "kimi-k2.7-code:cloud",
      new Error("no slot opened — 3 max"),
    );
    expect(
      providerCircuitBreaker.precheck("ollama", "kimi-k2.7-code:cloud"),
    ).toBeNull();
    providerCircuitBreaker.recordFailure(
      "ollama",
      "kimi-k2.7-code:cloud",
      new Error("no slot opened — 3 max"),
    );
    expect(
      providerCircuitBreaker.precheck("ollama", "kimi-k2.7-code:cloud"),
    ).toBeNull();
  });

  it("trips on the 3rd consecutive circuit-worthy failure", () => {
    for (let i = 0; i < 3; i++) {
      providerCircuitBreaker.recordFailure(
        "ollama",
        "kimi-k2.7-code:cloud",
        new Error("no slot opened — 3 max"),
      );
    }
    const tripped = providerCircuitBreaker.precheck(
      "ollama",
      "kimi-k2.7-code:cloud",
    );
    expect(tripped).toBeInstanceOf(Error);
    expect(tripped?.message).toMatch(/degraded/);
    expect(tripped?.message).toMatch(/3 consecutive/);
    expect(tripped?.message).toMatch(/ollama\/kimi-k2\.7-code:cloud/);
  });

  it("isolates state by (provider, model) so a tripped pair does not block another", () => {
    for (let i = 0; i < 3; i++) {
      providerCircuitBreaker.recordFailure(
        "ollama",
        "kimi-k2.7-code:cloud",
        new Error("no slot opened"),
      );
    }
    expect(
      providerCircuitBreaker.precheck("ollama", "kimi-k2.7-code:cloud"),
    ).not.toBeNull();
    // Different model, same provider — should NOT be tripped.
    expect(
      providerCircuitBreaker.precheck("ollama", "kimi-k2.7-code"),
    ).toBeNull();
    // Different provider entirely.
    expect(providerCircuitBreaker.precheck("zai", "glm-5.2")).toBeNull();
  });

  it("success at any point resets the failure counter", () => {
    providerCircuitBreaker.recordFailure(
      "ollama",
      "kimi",
      new Error("no slot opened"),
    );
    providerCircuitBreaker.recordFailure(
      "ollama",
      "kimi",
      new Error("no slot opened"),
    );
    providerCircuitBreaker.recordSuccess("ollama", "kimi");
    // After success, two MORE failures should not trip — we should be at 2/3, not 4/3.
    providerCircuitBreaker.recordFailure(
      "ollama",
      "kimi",
      new Error("no slot opened"),
    );
    providerCircuitBreaker.recordFailure(
      "ollama",
      "kimi",
      new Error("no slot opened"),
    );
    expect(providerCircuitBreaker.precheck("ollama", "kimi")).toBeNull();
  });

  it("non-circuit-worthy failures do not advance the counter", () => {
    providerCircuitBreaker.recordFailure(
      "ollama",
      "kimi",
      new Error("400 invalid request"),
    );
    providerCircuitBreaker.recordFailure(
      "ollama",
      "kimi",
      new Error("aborted by user"),
    );
    providerCircuitBreaker.recordFailure(
      "ollama",
      "kimi",
      new Error("no slot opened"),
    );
    // Only 1 circuit-worthy failure recorded — should NOT be tripped.
    expect(providerCircuitBreaker.precheck("ollama", "kimi")).toBeNull();
  });

  it("cooldown expires after the configured window", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    vi.setSystemTime(start);

    for (let i = 0; i < 3; i++) {
      providerCircuitBreaker.recordFailure(
        "ollama",
        "kimi",
        new Error("no slot opened"),
      );
    }
    expect(providerCircuitBreaker.precheck("ollama", "kimi")).not.toBeNull();

    // Advance past the 5-minute default cooldown.
    vi.setSystemTime(start + 5 * 60_000 + 1);
    expect(providerCircuitBreaker.precheck("ollama", "kimi")).toBeNull();

    vi.useRealTimers();
  });

  it("snapshot() exposes per-pair state", () => {
    providerCircuitBreaker.recordFailure(
      "ollama",
      "kimi",
      new Error("no slot opened"),
    );
    providerCircuitBreaker.recordFailure(
      "zai",
      "glm-5.2",
      new Error("rate limit"),
    );
    const snap = providerCircuitBreaker.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap.find((s) => s.key === "ollama/kimi")?.consecutiveFailures).toBe(
      1,
    );
    expect(snap.find((s) => s.key === "zai/glm-5.2")?.consecutiveFailures).toBe(
      1,
    );
  });

  it("treats unspecified model as '_default' so calls with no model still share state", () => {
    providerCircuitBreaker.recordFailure(
      "ollama",
      undefined,
      new Error("no slot opened"),
    );
    providerCircuitBreaker.recordFailure(
      "ollama",
      null,
      new Error("no slot opened"),
    );
    providerCircuitBreaker.recordFailure(
      "ollama",
      "",
      new Error("no slot opened"),
    );
    // All three normalize to the same key — should be tripped.
    expect(providerCircuitBreaker.precheck("ollama")).not.toBeNull();
  });
});
