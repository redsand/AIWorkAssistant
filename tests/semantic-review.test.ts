import { describe, it, expect, vi, beforeEach } from "vitest";
import { semanticReview } from "../src/autonomous-loop/semantic-review";
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

function mockResponse(content: unknown) {
  chat.mockResolvedValue({
    content: JSON.stringify(content),
    model: "test-model",
    done: true,
  });
}

describe("semanticReview", () => {
  beforeEach(() => {
    chat.mockReset();
  });

  it("returns no findings for a clean diff", async () => {
    mockResponse({
      findings: [],
      summary: "Looks correct.",
      riskLevel: "low",
      recommendation: "approve",
    });

    const result = await semanticReview("diff --git a/src/a.ts b/src/a.ts", "Fix typo", config);

    expect(result.findings).toEqual([]);
    expect(result.riskLevel).toBe("low");
    expect(result.recommendation).toBe("approve");
  });

  it("returns a critical finding for a data race", async () => {
    mockResponse({
      findings: [
        {
          severity: "critical",
          category: "correctness",
          file: "src/run-state.ts",
          line: 42,
          message: "ctx.run_state is written outside _kpi_lock, causing a data race.",
          suggestedFix: "Move the write under _kpi_lock.",
        },
      ],
      summary: "Shared state is not protected.",
      riskLevel: "critical",
      recommendation: "reject",
    });

    const result = await semanticReview("ctx.run_state = next", "Fix IR-93 run_state locking", config);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      severity: "critical",
      category: "correctness",
      file: "src/run-state.ts",
      line: 42,
    });
    expect(result.recommendation).toBe("reject");
  });

  it("returns a high finding for an empty test", async () => {
    mockResponse({
      findings: [
        {
          severity: "high",
          category: "testing",
          file: "tests/circuit-breaker.test.ts",
          message: "The added test file has no assertions and does not exercise the fix.",
        },
      ],
      summary: "Test coverage is a stub.",
      riskLevel: "high",
      recommendation: "request_changes",
    });

    const result = await semanticReview("diff --git a/tests/circuit-breaker.test.ts b/tests/circuit-breaker.test.ts", "Fix IR-94", config);

    expect(result.findings[0].severity).toBe("high");
    expect(result.findings[0].category).toBe("testing");
    expect(result.riskLevel).toBe("high");
  });

  it("returns a critical finding when the diff does not address the issue", async () => {
    mockResponse({
      findings: [
        {
          severity: "critical",
          category: "correctness",
          file: "src/auth.ts",
          message: "The issue asks for timing-safe token comparison, but the diff only changes formatting.",
        },
      ],
      summary: "The change is incomplete.",
      riskLevel: "critical",
      recommendation: "reject",
    });

    const result = await semanticReview("diff --git a/src/auth.ts b/src/auth.ts\n+ ", "Fix timing-safe auth comparison", config);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].message).toContain("timing-safe");
    expect(result.recommendation).toBe("reject");
  });
});

describe("AutonomousLoopReviewer semantic integration", () => {
  beforeEach(() => {
    chat.mockReset();
  });

  it("merges semantic findings into review checks and flags critical findings", async () => {
    mockResponse({
      findings: [
        {
          severity: "critical",
          category: "security",
          file: "src/auth.ts",
          message: "Empty PR claims to fix a security issue but changes no security code.",
        },
      ],
      summary: "Security fix is missing.",
      riskLevel: "critical",
      recommendation: "reject",
    });

    const reviewer = new AutonomousLoopReviewer({ semanticReview: config });
    const [result] = await reviewer.reviewBatch([
      {
        id: "IR-66",
        type: "pr",
        content: "diff --git a/README.md b/README.md\n+docs",
        metadata: {
          diff: "diff --git a/README.md b/README.md\n+docs",
          issueContext: "Fix security vulnerability in auth token comparison",
        },
      },
    ]);

    expect(result.level).toBe("flag");
    expect(result.semanticFindings).toHaveLength(1);
    expect(result.checks.some((check) => check.name === "semantic-security")).toBe(true);
  });

  it("deduplicates identical semantic findings across review rounds", async () => {
    const finding = {
      severity: "critical",
      category: "correctness",
      file: "src/run-state.ts",
      message: "ctx.run_state is written outside _kpi_lock.",
    };
    mockResponse({
      findings: [finding],
      summary: "Race remains.",
      riskLevel: "critical",
      recommendation: "reject",
    });

    const reviewer = new AutonomousLoopReviewer({ semanticReview: config });
    const output = {
      id: "IR-93",
      type: "pr",
      content: "diff --git a/src/run-state.ts b/src/run-state.ts\n+ctx.run_state = next",
      metadata: {
        diff: "diff --git a/src/run-state.ts b/src/run-state.ts\n+ctx.run_state = next",
        issueContext: "Fix run_state locking",
      },
    };

    const [first] = await reviewer.reviewBatch([output]);
    const [second] = await reviewer.reviewBatch([{ ...output, id: "IR-93-round-2" }]);

    expect(first.semanticFindings).toHaveLength(1);
    expect(second.semanticFindings).toHaveLength(0);
    expect(second.level).toBe("auto");
    expect(second.checks.some((check) => check.name === "semantic-correctness")).toBe(false);
  });
});
