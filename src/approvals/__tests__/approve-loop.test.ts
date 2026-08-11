/**
 * Regression test for the approval-loop bug: approving an action must
 * actually execute it, not re-enter the policy engine and enqueue another
 * approval for the same action.
 *
 * Root cause (observed 2026-08-11, session ed74f889): ApprovalQueue.approve()
 * called dispatchToolCall() without skipPolicyCheck=true. Since the tool
 * dispatcher re-runs policyEngine.evaluate() on every call, a medium/high
 * risk action like hawk_ir.create_case was re-flagged as approval_required
 * every time — approving it just spawned a fresh approval, forever.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const dispatchToolCall = vi.fn();

vi.mock("../../agent/tool-dispatcher", () => ({
  dispatchToolCall: (...args: unknown[]) => dispatchToolCall(...args),
}));

vi.mock("../../audit/logger", () => ({
  auditLogger: { log: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../database", () => ({
  approvalDatabase: {
    list: vi.fn().mockReturnValue({ approvals: [] }),
    save: vi.fn(),
  },
}));

describe("ApprovalQueue.approve", () => {
  beforeEach(() => {
    dispatchToolCall.mockReset();
    dispatchToolCall.mockResolvedValue({ success: true, data: { ok: true } });
  });

  it("executes the underlying tool with skipPolicyCheck=true so it cannot re-enqueue itself", async () => {
    const { approvalQueue } = await import("../queue.js");

    const approval = {
      id: "approval-1",
      action: {
        id: "action-1",
        type: "hawk_ir.create_case",
        description: "Execute hawk_ir.create_case",
        params: { name: "Test case" },
        userId: "user-1",
        timestamp: new Date(),
      },
      decision: {
        action: {} as any,
        result: "approval_required" as const,
        riskLevel: "medium" as const,
        reason: "Creating a HAWK IR case requires approval",
      },
      status: "pending" as const,
      requestedAt: new Date(),
    };

    await approvalQueue.enqueue(approval as any);
    const result = await approvalQueue.approve("approval-1", "user-1");

    expect(dispatchToolCall).toHaveBeenCalledTimes(1);
    expect(dispatchToolCall).toHaveBeenCalledWith(
      "hawk_ir.create_case",
      { name: "Test case" },
      "user-1",
      true,
    );
    expect(result.success).toBe(true);
    expect(result.approval.status).toBe("executed");
    expect(result.approval.executionResult?.success).toBe(true);
  });
});
