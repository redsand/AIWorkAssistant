import { describe, it, expect } from "vitest";
import { dryRunResult, type DryRunResult } from "../../../src/agent/dry-run";

describe("dryRunResult()", () => {
  it("returns a valid DryRunResult with wouldExecute: true", () => {
    const result: DryRunResult = dryRunResult({
      toolName: "jira.create_issue",
      summary: "Would create Jira issue",
      targetSystem: "jira",
      changes: [{ field: "issue", description: "Create new Task" }],
      riskLevel: "medium",
      paramsPreview: { project: "PROJ" },
    });

    expect(result.wouldExecute).toBe(true);
    expect(result.toolName).toBe("jira.create_issue");
    expect(result.summary).toBe("Would create Jira issue");
    expect(result.targetSystem).toBe("jira");
    expect(result.riskLevel).toBe("medium");
    expect(result.changes).toHaveLength(1);
    expect(result.paramsPreview).toEqual({ project: "PROJ" });
  });

  it("defaults warnings to an empty array when omitted", () => {
    const result = dryRunResult({
      toolName: "jira.add_comment",
      summary: "Would add comment",
      targetSystem: "jira",
      changes: [],
      paramsPreview: {},
    });

    expect(result.warnings).toEqual([]);
  });

  it("preserves provided warnings", () => {
    const result = dryRunResult({
      toolName: "jira.close_issue",
      summary: "Would close issue",
      targetSystem: "jira",
      changes: [],
      riskLevel: "high",
      paramsPreview: {},
      warnings: ["Closing a Jira issue may be difficult to reverse."],
    });

    expect(result.warnings).toEqual([
      "Closing a Jira issue may be difficult to reverse.",
    ]);
  });

  it("carries through the optional externalUrl", () => {
    const result = dryRunResult({
      toolName: "gitlab.create_merge_request",
      summary: "Would create MR",
      targetSystem: "gitlab",
      changes: [],
      paramsPreview: {},
      externalUrl: "https://gitlab.com/foo/bar/-/merge_requests/1",
    });

    expect(result.externalUrl).toBe(
      "https://gitlab.com/foo/bar/-/merge_requests/1",
    );
  });
});
