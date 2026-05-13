import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  hashFinding,
  validateSpecificity,
  type SemanticFinding,
} from "../src/autonomous-loop/semantic-review";
import { AutonomousLoopReviewer } from "../src/autonomous-loop/reviewer";

const chat = vi.fn();

vi.mock("../src/agent/providers/factory", () => ({
  getProvider: () => ({ chat }),
}));

const config = {
  model: "test-model",
  maxTokens: 4000,
  timeoutMs: 1000,
  includeDiff: true,
  includeIssueContext: true,
};

const specificFinding: SemanticFinding = {
  severity: "critical",
  category: "correctness",
  file: "src/hybrid_tools_mixin.py",
  line: 93,
  message: "Data race on ctx.run_state in hybrid_tools_mixin.py line 93 writes outside _kpi_lock.",
};

function mockFindings(findings: SemanticFinding[]) {
  chat.mockResolvedValue({
    content: JSON.stringify({
      findings,
      summary: "Review complete.",
      riskLevel: findings.some((finding) => finding.severity === "critical") ? "critical" : "low",
      recommendation: findings.length > 0 ? "reject" : "approve",
    }),
    model: "test-model",
    done: true,
  });
}

describe("semantic finding specificity and dedup", () => {
  beforeEach(() => {
    chat.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("allows specific actionable findings", () => {
    expect(validateSpecificity(specificFinding)).toEqual({ valid: true });
  });

  it("normalizes finding hashes for deduplication", () => {
    expect(hashFinding(specificFinding)).toContain("critical:correctness:src/hybrid_tools_mixin.py:data_race_hybrid_tools_mixin");
  });

  it("drops generic findings", async () => {
    mockFindings([
      {
        severity: "high",
        category: "security",
        file: "unknown",
        message: "Security-related files detected — review auth/credential changes carefully",
      },
    ]);

    const reviewer = new AutonomousLoopReviewer({ semanticReview: config });
    const [result] = await reviewer.reviewBatch([
      {
        id: "IR-99",
        type: "pr",
        content: "diff --git a/src/auth.ts b/src/auth.ts\n+change",
      },
    ]);

    expect(result.semanticFindings).toEqual([]);
    expect(result.level).toBe("flag");
    expect(result.checks.some((check) => check.message === "Reviewer produced only generic findings. Escalating to human review.")).toBe(true);
  });

  it("deduplicates duplicate findings across rounds", async () => {
    mockFindings([specificFinding]);

    const reviewer = new AutonomousLoopReviewer({ semanticReview: config });
    const output = {
      id: "IR-93",
      type: "pr",
      content: "diff --git a/src/hybrid_tools_mixin.py b/src/hybrid_tools_mixin.py\n+ctx.run_state = value",
    };

    const [first] = await reviewer.reviewBatch([output]);
    const [second] = await reviewer.reviewBatch([{ ...output, id: "IR-93-round-2" }]);

    expect(first.semanticFindings).toHaveLength(1);
    expect(second.semanticFindings).toHaveLength(0);
    expect(second.checks.some((check) => check.name === "semantic-correctness")).toBe(false);
  });

  it("all-generic findings trigger human escalation instead of requeue", async () => {
    mockFindings([
      {
        severity: "high",
        category: "security",
        file: "src/auth.ts",
        message: "Potential issue. Review carefully.",
      },
      {
        severity: "low",
        category: "security",
        file: "unknown",
        message: "Security-related files detected — review auth/credential changes carefully",
      },
    ]);

    const reviewer = new AutonomousLoopReviewer({ semanticReview: config });
    const [result] = await reviewer.reviewBatch([
      {
        id: "IR-99",
        type: "pr",
        content: "diff --git a/src/auth.ts b/src/auth.ts\n+change",
      },
    ]);

    expect(result.level).toBe("flag");
    expect(result.semanticFindings).toEqual([]);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "semantic-review-specificity",
      passed: false,
      message: "Reviewer produced only generic findings. Escalating to human review.",
    }));
  });
});
