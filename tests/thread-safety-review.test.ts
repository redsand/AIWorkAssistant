import { describe, it, expect, vi, beforeEach } from "vitest";
import { analyzeThreadSafety, semanticReview } from "../src/autonomous-loop/semantic-review";

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

function emptyLlmReview() {
  chat.mockResolvedValue({
    content: JSON.stringify({
      findings: [],
      summary: "No model findings.",
      riskLevel: "low",
      recommendation: "approve",
    }),
    model: "test-model",
    done: true,
  });
}

describe("thread safety static review", () => {
  beforeEach(() => {
    chat.mockReset();
  });

  it("emits info for lock-protected shared state", async () => {
    emptyLlmReview();
    const diff = [
      "diff --git a/src/worker.py b/src/worker.py",
      "@@ -10,0 +10,3 @@",
      "+with self._kpi_lock:",
      "+    self.run_state[case_id] = state",
      "+    self.metrics[case_id] = value",
    ].join("\n");

    const result = await semanticReview(diff, "Update shared run state", config);

    expect(result.findings).toContainEqual(expect.objectContaining({
      severity: "info",
      category: "correctness",
      file: "src/worker.py",
      line: 10,
    }));
    expect(result.recommendation).toBe("approve");
  });

  it("emits high for unprotected shared dictionary mutation", () => {
    const diff = [
      "diff --git a/src/worker.py b/src/worker.py",
      "@@ -20,0 +20,1 @@",
      "+self.run_state[case_id] = state",
    ].join("\n");

    const findings = analyzeThreadSafety(diff);

    expect(findings).toContainEqual(expect.objectContaining({
      severity: "high",
      category: "correctness",
      file: "src/worker.py",
      line: 20,
    }));
  });

  it("emits critical for dual-write legacy and context state updates", () => {
    const diff = [
      "diff --git a/src/worker.py b/src/worker.py",
      "@@ -30,0 +30,2 @@",
      "+self.run_state[case_id] = legacy_state",
      "+self.case_context[case_id] = new_context",
    ].join("\n");

    const findings = analyzeThreadSafety(diff);

    expect(findings).toContainEqual(expect.objectContaining({
      severity: "critical",
      category: "correctness",
      file: "src/worker.py",
      line: 30,
    }));
  });
});
