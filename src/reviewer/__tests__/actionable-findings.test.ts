import { describe, expect, it } from "vitest";
import { hasActionableFindings, type ReviewFinding } from "../actionable-findings";

/**
 * Regression: hasActionableFindings used to also fire on
 * `Boolean(f.file && f.file !== "unknown")`, which is true for nearly every
 * real finding — so any aicoder PR with even a single low-severity nit was
 * forced into rework forever, regardless of the bar applied to non-aicoder
 * PRs (critical/high severity, or a qa/test-gap finding). That blanket
 * clause made aicoder PRs unable to converge (e.g. claimkit #47/#48).
 */
function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "low",
    category: "quality",
    file: "src/example.ts",
    message: "nit",
    suggestion: "consider renaming",
    ...overrides,
  };
}

describe("hasActionableFindings", () => {
  it("is not actionable for a low-severity finding that names a real file", () => {
    expect(hasActionableFindings([finding()])).toBe(false);
  });

  it("is not actionable for a medium, non-qa finding", () => {
    expect(hasActionableFindings([finding({ severity: "medium" })])).toBe(false);
  });

  it("is actionable for a high-severity finding", () => {
    expect(hasActionableFindings([finding({ severity: "high" })])).toBe(true);
  });

  it("is actionable for a critical-severity finding", () => {
    expect(hasActionableFindings([finding({ severity: "critical" })])).toBe(true);
  });

  it("is actionable for any qa/test-gap finding regardless of severity", () => {
    expect(hasActionableFindings([finding({ severity: "low", category: "qa" })])).toBe(true);
  });

  it("is not actionable for an empty findings list", () => {
    expect(hasActionableFindings([])).toBe(false);
  });
});
