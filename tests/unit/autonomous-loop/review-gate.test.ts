import { describe, it, expect } from "vitest";
import {
  reviewGate,
  formatGateBlockComment,
  initReviewGateState,
  updateGateState,
  type ReviewGateFinding,
} from "../../../src/autonomous-loop/review-gate";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const criticalFinding: ReviewGateFinding = {
  severity: "critical",
  category: "security",
  file: "src/auth.ts",
  message: "Circuit breaker race condition allows bypass",
};

const highFinding: ReviewGateFinding = {
  severity: "high",
  category: "qa",
  file: "src/circuit-breaker.ts",
  message: "Empty test file — no assertions",
};

const mediumFinding: ReviewGateFinding = {
  severity: "medium",
  category: "quality",
  file: "src/utils.ts",
  message: "Missing error handling in retry logic",
};

const lowFinding: ReviewGateFinding = {
  severity: "low",
  category: "quality",
  file: "src/config.ts",
  message: "Console.log left in production code",
};

// ── reviewGate ────────────────────────────────────────────────────────────────

describe("reviewGate", () => {
  describe("no review findings (no review occurred)", () => {
    it("blocks Done when no review occurred (reviewOccurred=false)", () => {
      const result = reviewGate([], false, false);
      expect(result.canMarkDone).toBe(false);
      expect(result.blockedBy).toEqual(["No review found"]);
      expect(result.criticalCount).toBe(0);
      expect(result.highCount).toBe(0);
    });
  });

  describe("clean review (review occurred but no blocking findings)", () => {
    it("allows Done when review occurred and findings are empty (clean review)", () => {
      const result = reviewGate([], false, true);
      expect(result.canMarkDone).toBe(true);
      expect(result.blockedBy).toHaveLength(0);
    });

    it("allows Done when review occurred with only low findings", () => {
      const result = reviewGate([lowFinding], false, true);
      expect(result.canMarkDone).toBe(true);
    });

    it("allows Done when review occurred with only medium findings", () => {
      const result = reviewGate([mediumFinding], false, true);
      expect(result.canMarkDone).toBe(true);
    });

    it("allows Done when review occurred with medium + low findings", () => {
      const result = reviewGate([mediumFinding, lowFinding], false, true);
      expect(result.canMarkDone).toBe(true);
    });
  });

  describe("critical findings block Done", () => {
    it("blocks Done with a single critical finding", () => {
      const result = reviewGate([criticalFinding], false, true);
      expect(result.canMarkDone).toBe(false);
      expect(result.criticalCount).toBe(1);
      expect(result.highCount).toBe(0);
      expect(result.blockedBy).toHaveLength(1);
      expect(result.blockedBy[0]).toContain("CRITICAL");
      expect(result.blockedBy[0]).toContain("src/auth.ts");
    });

    it("blocks Done with multiple critical findings", () => {
      const result = reviewGate([
        criticalFinding,
        { ...criticalFinding, file: "src/api.ts", message: "SQL injection vulnerability" },
      ], false, true);
      expect(result.canMarkDone).toBe(false);
      expect(result.criticalCount).toBe(2);
      expect(result.blockedBy).toHaveLength(2);
    });
  });

  describe("high findings block Done", () => {
    it("blocks Done with a single high finding", () => {
      const result = reviewGate([highFinding], false, true);
      expect(result.canMarkDone).toBe(false);
      expect(result.highCount).toBe(1);
      expect(result.criticalCount).toBe(0);
    });

    it("blocks Done with both critical and high findings", () => {
      const result = reviewGate([criticalFinding, highFinding], false, true);
      expect(result.canMarkDone).toBe(false);
      expect(result.criticalCount).toBe(1);
      expect(result.highCount).toBe(1);
      expect(result.blockedBy).toHaveLength(2);
    });
  });

  describe("force-done override", () => {
    it("allows Done with forceDone=true even with critical findings", () => {
      const result = reviewGate([criticalFinding, highFinding], true, true);
      expect(result.canMarkDone).toBe(true);
      expect(result.blockedBy).toHaveLength(0);
      expect(result.criticalCount).toBe(0);
      expect(result.highCount).toBe(0);
    });

    it("allows Done with forceDone=true even without a review", () => {
      const result = reviewGate([], true, false);
      expect(result.canMarkDone).toBe(true);
    });
  });

  describe("mixed findings", () => {
    it("blocks Done with critical + medium (only critical blocks)", () => {
      const result = reviewGate([criticalFinding, mediumFinding], false, true);
      expect(result.canMarkDone).toBe(false);
      expect(result.criticalCount).toBe(1);
      expect(result.blockedBy).toHaveLength(1); // only critical is blocking
    });

    it("blocks Done with high + low (only high blocks)", () => {
      const result = reviewGate([highFinding, lowFinding], false, true);
      expect(result.canMarkDone).toBe(false);
      expect(result.highCount).toBe(1);
      expect(result.blockedBy).toHaveLength(1);
    });
  });

  describe("IR-94 scenario", () => {
    it("blocks Done for unfixed circuit breaker, empty test, no retry", () => {
      const findings: ReviewGateFinding[] = [
        { severity: "critical", category: "security", file: "src/circuit-breaker.ts", message: "Race condition in circuit breaker reset logic" },
        { severity: "high", category: "qa", file: "src/circuit-breaker.test.ts", message: "Empty test file — no assertions" },
        { severity: "high", category: "quality", file: "src/circuit-breaker.ts", message: "No retry implementation for transient failures" },
      ];
      const result = reviewGate(findings, false, true);
      expect(result.canMarkDone).toBe(false);
      expect(result.criticalCount).toBe(1);
      expect(result.highCount).toBe(2);
      expect(result.blockedBy).toHaveLength(3);
    });
  });
});

// ── formatGateBlockComment ────────────────────────────────────────────────────

describe("formatGateBlockComment", () => {
  it("formats a readable blockage message", () => {
    const result = reviewGate([criticalFinding, highFinding], false, true);
    const comment = formatGateBlockComment(result);
    expect(comment).toContain("Cannot mark as Done");
    expect(comment).toContain("1 critical");
    expect(comment).toContain("1 high");
    expect(comment).toContain("CRITICAL");
    expect(comment).toContain("src/auth.ts");
    expect(comment).toContain("force-done");
  });

  it("includes only blocking findings in comment", () => {
    const result = reviewGate([criticalFinding, highFinding, mediumFinding], false, true);
    const comment = formatGateBlockComment(result);
    expect(comment).toContain("CRITICAL");
    expect(comment).toContain("HIGH");
    expect(comment).not.toContain("MEDIUM");
  });
});

// ── initReviewGateState / updateGateState ──────────────────────────────────────

describe("initReviewGateState", () => {
  it("starts with empty findings, no review, and no force-done", () => {
    const state = initReviewGateState();
    expect(state.lastFindings).toEqual([]);
    expect(state.reviewOccurred).toBe(false);
    expect(state.forceDoneUsed).toBe(false);
    expect(state.forceDoneAt).toBeUndefined();
  });
});

describe("updateGateState", () => {
  it("updates findings and marks review as occurred", () => {
    const state = initReviewGateState();
    const updated = updateGateState(state, [criticalFinding]);
    expect(updated.lastFindings).toEqual([criticalFinding]);
    expect(updated.reviewOccurred).toBe(true);
    expect(updated.forceDoneUsed).toBe(false);
  });

  it("preserves force-done when updating findings", () => {
    const state = { ...initReviewGateState(), forceDoneUsed: true, forceDoneAt: "2026-01-01T00:00:00Z" };
    const updated = updateGateState(state, [mediumFinding]);
    expect(updated.forceDoneUsed).toBe(true);
    expect(updated.forceDoneAt).toBe("2026-01-01T00:00:00Z");
    expect(updated.reviewOccurred).toBe(true);
  });
});