import { describe, it, expect } from "vitest";
import {
  determineRoutingTier,
  type RoutingDecision,
} from "../../../src/context-engine/context-packet";
import type { ClaimKitQueryResult } from "../../../src/context-engine/adapters/claimkit-adapter";

function makeCKResult(overrides: Partial<ClaimKitQueryResult> = {}): ClaimKitQueryResult {
  return {
    answer: "Test answer",
    citations: [],
    confidence: 0.8,
    contradictions: [],
    missingEvidence: [],
    answerability: "answerable",
    metadata: {
      sourceIds: ["src-1"],
      claimCount: 3,
      processingTimeMs: 100,
      retrievalScore: 0.85,
    },
    ...overrides,
  };
}

describe("determineRoutingTier", () => {
  describe("CK primary tier (confidence > 0.7 AND answerable)", () => {
    it("routes to claimkit when confidence is 0.75 and answerable", () => {
      const result = makeCKResult({ confidence: 0.75, answerability: "answerable" });
      const decision = determineRoutingTier(result);
      expect(decision.tier).toBe("ck_primary");
      expect(decision.preferredSource).toBe("claimkit");
      expect(decision.overallWinner).toBe("claimkit");
      expect(decision.routingReason).toBe("high_confidence");
    });

    it("routes to claimkit when confidence is exactly 0.7 is NOT CK primary (boundary)", () => {
      const result = makeCKResult({ confidence: 0.7, answerability: "answerable" });
      const decision = determineRoutingTier(result);
      expect(decision.tier).toBe("blended");
    });

    it("routes to claimkit at very high confidence 0.95", () => {
      const result = makeCKResult({ confidence: 0.95, answerability: "answerable" });
      const decision = determineRoutingTier(result);
      expect(decision.tier).toBe("ck_primary");
      expect(decision.preferredSource).toBe("claimkit");
    });

    it("does NOT route to CK primary when partially-answerable even with high confidence", () => {
      const result = makeCKResult({ confidence: 0.8, answerability: "partially-answerable" });
      const decision = determineRoutingTier(result);
      expect(decision.tier).not.toBe("ck_primary");
    });
  });

  describe("RAG primary tier (confidence < 0.3 OR not_answerable OR CK unavailable)", () => {
    it("routes to RAG when confidence is 0.25", () => {
      const result = makeCKResult({ confidence: 0.25, answerability: "answerable" });
      const decision = determineRoutingTier(result);
      expect(decision.tier).toBe("rag_primary");
      expect(decision.preferredSource).toBe("rag");
      expect(decision.overallWinner).toBe("rag");
      expect(decision.routingReason).toBe("low_confidence");
    });

    it("routes to RAG when confidence is exactly 0.3 is NOT RAG primary (boundary)", () => {
      const result = makeCKResult({ confidence: 0.3, answerability: "answerable" });
      const decision = determineRoutingTier(result);
      expect(decision.tier).toBe("blended");
    });

    it("routes to RAG when answerability is not_answerable", () => {
      const result = makeCKResult({ confidence: 0.6, answerability: "not_answerable" });
      const decision = determineRoutingTier(result);
      expect(decision.tier).toBe("rag_primary");
      expect(decision.routingReason).toBe("not_answerable");
    });

    it("routes to RAG when CK result is null (unavailable)", () => {
      const decision = determineRoutingTier(null);
      expect(decision.tier).toBe("rag_primary");
      expect(decision.preferredSource).toBe("rag");
      expect(decision.overallWinner).toBe("rag");
      expect(decision.routingReason).toBe("ck_unavailable");
    });

    it("routes to RAG when confidence is very low 0.05", () => {
      const result = makeCKResult({ confidence: 0.05, answerability: "answerable" });
      const decision = determineRoutingTier(result);
      expect(decision.tier).toBe("rag_primary");
    });
  });

  describe("Blended tier (0.3-0.7, answerable or partially-answerable)", () => {
    it("routes to blended when confidence is 0.5 and answerable", () => {
      const result = makeCKResult({ confidence: 0.5, answerability: "answerable" });
      const decision = determineRoutingTier(result);
      expect(decision.tier).toBe("blended");
      expect(decision.preferredSource).toBe("blended");
      expect(decision.overallWinner).toBe("tie");
      expect(decision.routingReason).toBe("uncertain");
    });

    it("routes to blended at lower boundary 0.3", () => {
      const result = makeCKResult({ confidence: 0.3, answerability: "answerable" });
      const decision = determineRoutingTier(result);
      expect(decision.tier).toBe("blended");
    });

    it("routes to blended at upper boundary 0.7", () => {
      const result = makeCKResult({ confidence: 0.7, answerability: "answerable" });
      const decision = determineRoutingTier(result);
      expect(decision.tier).toBe("blended");
    });

    it("routes to blended when partially-answerable with moderate confidence", () => {
      const result = makeCKResult({ confidence: 0.5, answerability: "partially-answerable" });
      const decision = determineRoutingTier(result);
      expect(decision.tier).toBe("blended");
      expect(decision.routingReason).toBe("uncertain");
    });
  });

  describe("RoutingDecision type structure", () => {
    it("returns all required fields", () => {
      const result = makeCKResult({ confidence: 0.85, answerability: "answerable" });
      const decision = determineRoutingTier(result);
      expect(decision).toHaveProperty("tier");
      expect(decision).toHaveProperty("preferredSource");
      expect(decision).toHaveProperty("overallWinner");
      expect(decision).toHaveProperty("routingReason");
    });
  });
});
