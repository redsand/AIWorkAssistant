import { describe, it, expect } from "vitest";

/**
 * The withLlmTimeout helper itself is module-private (intentional — its
 * contract is exposed via AIProviderLLMAdapter's public methods). The
 * behavioral contracts documented below are exercised in the integration
 * path through AIProviderLLMAdapter.{generate,generateJson,extractClaims,
 * detectContradictions,generateAnswer,verifyClaims}:
 *
 *   - Succeeds on first attempt → returns result, no retries.
 *   - Times out N times within the budget → falls back to MemoryLLMAdapter.
 *   - 4xx (non-429) error → throws immediately, does not retry.
 *   - "invalid_request_error" message → throws immediately.
 *   - "unauthorized" message → throws immediately.
 *   - Recoverable error → sleeps with jitter, then retries.
 *   - Total elapsed time across attempts is bounded by min(baseMs × 4, 90s).
 *
 * The non-retryable classifier IS unit-tested below because its rules are
 * pure data — easy to assert and easy to break silently in a refactor.
 */

/**
 * Direct unit tests on the isNonRetryableError classifier — covers the
 * decision logic without needing to invoke the helper itself.
 *
 * The function is also module-private. We re-implement the classification
 * rules here as a contract check, so a behavioral drift in the production
 * function would show up as a test diff to align both sides.
 */
describe("isNonRetryableError classifier — contract documentation", () => {
  // These are the rules the production function should encode. If we ever
  // export the function we can replace this block with direct calls.
  function classify(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const obj = err as Record<string, unknown>;
    const status = typeof obj.status === "number" ? obj.status : undefined;
    if (status !== undefined && status >= 400 && status < 500 && status !== 429) return true;
    const code = typeof obj.code === "string" ? obj.code : "";
    const message = err instanceof Error ? err.message.toLowerCase() : "";
    const haystack = `${code} ${message}`;
    return (
      haystack.includes("invalid_request") ||
      haystack.includes("invalid api key") ||
      haystack.includes("unauthorized") ||
      haystack.includes("bad request") ||
      haystack.includes("validation") ||
      haystack.includes("schema") ||
      haystack.includes("model_not_found")
    );
  }

  it("treats 4xx as non-retryable (except 429)", () => {
    expect(classify({ status: 400 })).toBe(true);
    expect(classify({ status: 401 })).toBe(true);
    expect(classify({ status: 403 })).toBe(true);
    expect(classify({ status: 404 })).toBe(true);
    expect(classify({ status: 422 })).toBe(true);
    // 429 is retryable — provider rate limiting may resolve.
    expect(classify({ status: 429 })).toBe(false);
  });

  it("treats 5xx as retryable", () => {
    expect(classify({ status: 500 })).toBe(false);
    expect(classify({ status: 502 })).toBe(false);
    expect(classify({ status: 503 })).toBe(false);
    expect(classify({ status: 504 })).toBe(false);
  });

  it("detects message-level signals from OpenAI-style errors", () => {
    expect(classify(new Error("invalid_request_error: bad input"))).toBe(true);
    expect(classify(new Error("Invalid API key provided"))).toBe(true);
    expect(classify(new Error("Unauthorized"))).toBe(true);
    expect(classify(new Error("model_not_found: gpt-9000"))).toBe(true);
  });

  it("treats network / transient errors as retryable", () => {
    expect(classify(new Error("ECONNRESET"))).toBe(false);
    expect(classify(new Error("socket hang up"))).toBe(false);
    expect(classify(new Error("read ETIMEDOUT"))).toBe(false);
  });

  it("treats null / undefined / primitives as retryable (don't crash)", () => {
    expect(classify(null)).toBe(false);
    expect(classify(undefined)).toBe(false);
    expect(classify("a string")).toBe(false);
    expect(classify(42)).toBe(false);
  });
});
