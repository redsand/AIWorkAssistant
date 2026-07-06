export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  category: "security" | "qa" | "quality" | "regression";
  file: string;
  line?: number;
  message: string;
  suggestion: string;
}

/**
 * Whether an aicoder-authored PR's findings are severe enough to force
 * rework rather than merge. Must match the bar applied to non-aicoder PRs
 * (critical/high severity, or a qa/test-gap finding) — a prior version also
 * blocked on any finding that merely named a real file, which fired on
 * nearly every review and made aicoder PRs unable to converge.
 */
export function hasActionableFindings(findings: ReviewFinding[]): boolean {
  return findings.some(
    (f) =>
      f.category === "qa" ||
      f.severity === "critical" ||
      f.severity === "high",
  );
}
