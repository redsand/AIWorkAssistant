import { describe, it, expect, beforeEach } from "vitest";
import { policyEngine } from "../../../src/policy/engine";
import { Action } from "../../../src/policy/types";

describe("Policy Engine", () => {
  let testAction: Action;

  beforeEach(() => {
    testAction = {
      id: "test-1",
      type: "test.action",
      description: "Test action",
      params: {},
      userId: "test-user",
      timestamp: new Date(),
    };
  });

  describe("evaluate", () => {
    it("should allow low-risk read actions", async () => {
      testAction.type = "jira.issue.read";
      testAction.description = "Read Jira issue";

      const decision = await policyEngine.evaluate(testAction);

      expect(decision.result).toBe("allow");
      expect(decision.riskLevel).toBe("low");
    });

    it("should allow Jira comment creation", async () => {
      testAction.type = "jira.comment.create";
      testAction.description = "Post comment to Jira issue";

      const decision = await policyEngine.evaluate(testAction);

      expect(decision.result).toBe("allow");
    });

    it("should allow Jira issue creation", async () => {
      testAction.type = "jira.issue.create";
      testAction.description = "Create new Jira issue";

      const decision = await policyEngine.evaluate(testAction);

      expect(decision.result).toBe("allow");
    });

    it("should allow Jira issue updates", async () => {
      testAction.type = "jira.issue.update";
      testAction.description = "Update Jira issue fields";

      const decision = await policyEngine.evaluate(testAction);

      expect(decision.result).toBe("allow");
    });

    it("should allow calendar event creation", async () => {
      testAction.type = "calendar.event.create";
      testAction.description = "Create calendar event";

      const decision = await policyEngine.evaluate(testAction);

      expect(decision.result).toBe("allow");
    });

    it("should require approval for Jira issue deletes", async () => {
      testAction.type = "jira.issue.delete";
      testAction.description = "Delete Jira issue";

      const decision = await policyEngine.evaluate(testAction);

      expect(decision.result).toBe("approval_required");
      expect(decision.riskLevel).toBe("high");
    });

    it("should require approval for calendar event deletes", async () => {
      testAction.type = "calendar.event.delete";
      testAction.description = "Delete calendar event";

      const decision = await policyEngine.evaluate(testAction);

      expect(decision.result).toBe("approval_required");
      expect(decision.riskLevel).toBe("high");
    });

    it("should block bulk operations", async () => {
      testAction.type = "something.bulk";
      testAction.description = "Bulk operation";

      const decision = await policyEngine.evaluate(testAction);

      expect(decision.result).toBe("blocked");
      expect(decision.riskLevel).toBe("high");
    });

    it("should block shell commands", async () => {
      testAction.type = "shell.exec";
      testAction.description = "Execute shell command";

      const decision = await policyEngine.evaluate(testAction);

      expect(decision.result).toBe("blocked");
    });

    it("should require approval for unknown actions", async () => {
      testAction.type = "unknown.action";
      testAction.description = "Unknown action";

      const decision = await policyEngine.evaluate(testAction);

      expect(decision.result).toBe("approval_required");
    });
  });

  describe("canProceed", () => {
    it("should return true for allowed actions", async () => {
      testAction.type = "jira.issue.read";
      const decision = await policyEngine.evaluate(testAction);

      expect(policyEngine.canProceed(decision)).toBe(true);
    });

    it("should return true for Jira updates", async () => {
      testAction.type = "jira.issue.update";
      const decision = await policyEngine.evaluate(testAction);

      expect(policyEngine.canProceed(decision)).toBe(true);
    });

    it("should return false for approval-required delete actions", async () => {
      testAction.type = "jira.issue.delete";
      const decision = await policyEngine.evaluate(testAction);

      expect(policyEngine.canProceed(decision)).toBe(false);
    });

    it("should return false for blocked actions", async () => {
      testAction.type = "shell.exec";
      const decision = await policyEngine.evaluate(testAction);

      expect(policyEngine.canProceed(decision)).toBe(false);
    });
  });

  describe("requiresApproval", () => {
    it("should return true for delete actions", async () => {
      testAction.type = "jira.issue.delete";
      const decision = await policyEngine.evaluate(testAction);

      expect(policyEngine.requiresApproval(decision)).toBe(true);
    });

    it("should return false for allowed actions", async () => {
      testAction.type = "jira.issue.update";
      const decision = await policyEngine.evaluate(testAction);

      expect(policyEngine.requiresApproval(decision)).toBe(false);
    });
  });

  describe("isBlocked", () => {
    it("should return true for blocked actions", async () => {
      testAction.type = "shell.exec";
      const decision = await policyEngine.evaluate(testAction);

      expect(policyEngine.isBlocked(decision)).toBe(true);
    });

    it("should return false for delete actions (not blocked, just approval)", async () => {
      testAction.type = "jira.issue.delete";
      const decision = await policyEngine.evaluate(testAction);

      expect(policyEngine.isBlocked(decision)).toBe(false);
    });
  });

  describe("createApprovalRequest", () => {
    it("should create approval request with pending status", async () => {
      testAction.type = "jira.comment.create";
      const decision = await policyEngine.evaluate(testAction);

      const approval = await policyEngine.createApprovalRequest(
        testAction,
        decision,
      );

      expect(approval.status).toBe("pending");
      expect(approval.action).toEqual(testAction);
      expect(approval.decision).toEqual(decision);
      expect(approval.requestedAt).toBeInstanceOf(Date);
    });
  });
});
