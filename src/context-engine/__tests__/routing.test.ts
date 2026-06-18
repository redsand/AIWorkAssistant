import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { determineRoutingStrategy } from "../context-packet";
import { env } from "../../config/env";
import type { ClaimKitQueryResult } from "../adapters/claimkit-adapter";

// determineRoutingStrategy reads three env fields at call time. `env` is a
// mutable exported object, so we snapshot and restore the relevant fields
// around each test rather than re-mocking the whole module.

function probe(
  confidence: number,
  answerability: ClaimKitQueryResult["answerability"],
): ClaimKitQueryResult {
  return { confidence, answerability } as ClaimKitQueryResult;
}

describe("determineRoutingStrategy", () => {
  let saved: {
    routing: boolean;
    high: number;
    low: number;
  };

  beforeEach(() => {
    saved = {
      routing: env.CLAIMKIT_FIRST_ROUTING,
      high: env.CLAIMKIT_HIGH_CONFIDENCE_THRESHOLD,
      low: env.CLAIMKIT_LOW_CONFIDENCE_THRESHOLD,
    };
    env.CLAIMKIT_FIRST_ROUTING = true;
    env.CLAIMKIT_HIGH_CONFIDENCE_THRESHOLD = 0.8;
    env.CLAIMKIT_LOW_CONFIDENCE_THRESHOLD = 0.5;
  });

  afterEach(() => {
    env.CLAIMKIT_FIRST_ROUTING = saved.routing;
    env.CLAIMKIT_HIGH_CONFIDENCE_THRESHOLD = saved.high;
    env.CLAIMKIT_LOW_CONFIDENCE_THRESHOLD = saved.low;
  });

  it("returns rag_first when ClaimKit-first routing is disabled", () => {
    env.CLAIMKIT_FIRST_ROUTING = false;
    expect(determineRoutingStrategy(probe(0.95, "answerable"))).toBe("rag_first");
  });

  it("returns rag_first when the probe is null (probe unavailable or threw)", () => {
    expect(determineRoutingStrategy(null)).toBe("rag_first");
  });

  it("returns claimkit_first_skip_rag for high confidence + answerable", () => {
    expect(determineRoutingStrategy(probe(0.95, "answerable"))).toBe(
      "claimkit_first_skip_rag",
    );
  });

  it("returns claimkit_first_skip_rag at exactly the high threshold", () => {
    expect(determineRoutingStrategy(probe(0.8, "answerable"))).toBe(
      "claimkit_first_skip_rag",
    );
  });

  it("returns claimkit_first_skip_rag for high confidence + partially-answerable", () => {
    expect(determineRoutingStrategy(probe(0.85, "partially-answerable"))).toBe(
      "claimkit_first_skip_rag",
    );
  });

  it("returns claimkit_first_parallel for medium confidence", () => {
    expect(determineRoutingStrategy(probe(0.65, "answerable"))).toBe(
      "claimkit_first_parallel",
    );
  });

  it("returns claimkit_first_parallel at exactly the low threshold", () => {
    expect(determineRoutingStrategy(probe(0.5, "answerable"))).toBe(
      "claimkit_first_parallel",
    );
  });

  it("returns claimkit_first_parallel just below the high threshold", () => {
    expect(determineRoutingStrategy(probe(0.79, "partially-answerable"))).toBe(
      "claimkit_first_parallel",
    );
  });

  it("returns claimkit_first_fallback for low confidence + answerable", () => {
    expect(determineRoutingStrategy(probe(0.3, "answerable"))).toBe(
      "claimkit_first_fallback",
    );
  });

  it("returns claimkit_first_fallback just below the low threshold", () => {
    expect(determineRoutingStrategy(probe(0.49, "answerable"))).toBe(
      "claimkit_first_fallback",
    );
  });

  it("returns claimkit_first_fallback for not_answerable regardless of high confidence", () => {
    expect(determineRoutingStrategy(probe(0.99, "not_answerable"))).toBe(
      "claimkit_first_fallback",
    );
  });

  it("respects custom thresholds from env", () => {
    env.CLAIMKIT_HIGH_CONFIDENCE_THRESHOLD = 0.9;
    env.CLAIMKIT_LOW_CONFIDENCE_THRESHOLD = 0.6;
    // 0.85 is now below the (raised) high threshold but above the low one.
    expect(determineRoutingStrategy(probe(0.85, "answerable"))).toBe(
      "claimkit_first_parallel",
    );
    // 0.55 is now below the (raised) low threshold.
    expect(determineRoutingStrategy(probe(0.55, "answerable"))).toBe(
      "claimkit_first_fallback",
    );
  });
});
