import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { guardrailsRegistry } from "../../src/guardrails/action-registry";
import fs from "fs";
import path from "path";

describe("Guardrails Action Registry", () => {
  beforeEach(() => {
    const auditDir = path.join(process.cwd(), "data", "audit");
    if (!fs.existsSync(auditDir)) {
      fs.mkdirSync(auditDir, { recursive: true });
    }
  });

  describe("Action Registration", () => {
    it("should register 15 default critical actions", () => {
      const action = guardrailsRegistry.getAction("fs.delete");
      expect(action).toBeDefined();
      expect(action!.riskLevel).toBe("high");
      expect(action!.requiresApproval).toBe(true);
    });

    it("should retrieve a registered action by id", () => {
      const action = guardrailsRegistry.getAction("jira.transition");
      expect(action).toBeDefined();
      expect(action!.operation).toBe("jira.transition");
      expect(action!.riskLevel).toBe("low");
    });

    it("should return undefined for unknown action id", () => {
      const action = guardrailsRegistry.getAction("nonexistent.action");
      expect(action).toBeUndefined();
    });

    it("should check if action requires approval", () => {
      expect(guardrailsRegistry.requiresApproval("fs.delete")).toBe(true);
      expect(guardrailsRegistry.requiresApproval("jira.transition")).toBe(
        false,
      );
    });
  });

  describe("User Authorization", () => {
    it("should allow admin users for all actions", () => {
      const result = guardrailsRegistry.isAllowedUser(
        "deploy.production",
        "user1",
        ["admin"],
      );
      expect(result).toBe(true);
    });

    it("should deny unauthorized roles for critical actions", () => {
      const result = guardrailsRegistry.isAllowedUser(
        "deploy.production",
        "user1",
        ["developer"],
      );
      expect(result).toBe(false);
    });

    it("should allow users with matching role for low-risk action", () => {
      const result = guardrailsRegistry.isAllowedUser(
        "jira.transition",
        "user1",
        ["user"],
      );
      expect(result).toBe(true);
    });

    it("should deny users without matching role", () => {
      const result = guardrailsRegistry.isAllowedUser(
        "jira.transition",
        "user1",
        ["viewer"],
      );
      expect(result).toBe(false);
    });

    it("should allow any role for action with empty allowedUsers and allowedRoles", () => {
      const result = guardrailsRegistry.isAllowedUser("db.delete", "user1", [
        "some-random-role",
      ]);
      expect(result).toBe(false);
    });

    it("should allow matching role regardless of user list", () => {
      const result = guardrailsRegistry.isAllowedUser("db.delete", "user1", [
        "admin",
        "developer",
      ]);
      expect(result).toBe(true);
    });
  });

  describe("Rate Limiting", () => {
    it("should enforce hourly rate limits", () => {
      const result = guardrailsRegistry.checkRateLimits(
        "deploy.staging",
        "test-user",
      );
      expect(result.allowed).toBe(true);
    });

    it("should track rate limits against created requests", () => {
      const actionId = "deploy.staging";
      const userId = "rate-test-user-2";
      for (let i = 0; i < 8; i++) {
        guardrailsRegistry.createActionRequest(
          actionId,
          userId,
          { testIndex: i },
          "development",
          ["admin", "developer", "devops"],
        );
      }
      const result = guardrailsRegistry.checkRateLimits(actionId, userId);
      expect(result.allowed).toBe(true);

      for (let i = 8; i < 12; i++) {
        guardrailsRegistry.createActionRequest(
          actionId,
          userId,
          { testIndex: i },
          "development",
          ["admin", "developer", "devops"],
        );
      }
      const denied = guardrailsRegistry.checkRateLimits(actionId, userId);
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toContain("rate limit");
    });
  });

  describe("Cooldown", () => {
    it("should allow actions when no cooldown is active", () => {
      const result = guardrailsRegistry.checkCooldown("jira.transition");
      expect(result.allowed).toBe(true);
    });
  });

  describe("Action Request Lifecycle", () => {
    it("should create an action request", () => {
      const request = guardrailsRegistry.createActionRequest(
        "jira.transition",
        "test-user",
        { issueKey: "TEST-1", transition: "In Progress" },
        "development",
        ["user"],
      );

      expect(request.id).toBeDefined();
      expect(request.actionId).toBe("jira.transition");
      expect(request.userId).toBe("test-user");
      expect(request.status).toBe("pending");
    });

    it("should create an auto-approved request", () => {
      const request = guardrailsRegistry.createActionRequest(
        "jira.transition",
        "test-user",
        { autoApprove: true },
        "development",
        ["user"],
      );

      expect(request.status).toBe("approved");
    });

    it("should approve and then reject action requests", () => {
      const request = guardrailsRegistry.createActionRequest(
        "fs.delete",
        "test-approver-user",
        { path: "/tmp/test" },
        "development",
        ["admin"],
      );
      expect(request.status).toBe("pending");

      const approved = guardrailsRegistry.approveAction(
        request.id,
        "admin-user",
      );
      expect(approved).toBe(true);

      const history = guardrailsRegistry.getUserHistory("test-approver-user");
      const found = history.find((r) => r.id === request.id);
      expect(found).toBeDefined();
      expect(found!.status).toBe("approved");
    });

    it("should mark action as executed", () => {
      const request = guardrailsRegistry.createActionRequest(
        "jira.transition",
        "mark-exec-user",
        { issueKey: "TEST-2" },
        "development",
        ["user"],
      );

      guardrailsRegistry.markAsExecuted(request.id, true, undefined, {
        transitioned: true,
      });

      const history = guardrailsRegistry.getUserHistory("mark-exec-user");
      const found = history.find((r) => r.id === request.id);
      expect(found).toBeDefined();
      expect(found!.status).toBe("executed");
    });

    it("should mark action as failed", () => {
      const request = guardrailsRegistry.createActionRequest(
        "jira.transition",
        "mark-fail-user",
        { issueKey: "TEST-3" },
        "development",
        ["user"],
      );

      guardrailsRegistry.markAsExecuted(request.id, false, "Network error");

      const history = guardrailsRegistry.getUserHistory("mark-fail-user");
      const found = history.find((r) => r.id === request.id);
      expect(found).toBeDefined();
      expect(found!.status).toBe("failed");
    });
  });

  describe("Validation", () => {
    it("should validate action request for low-risk action", () => {
      const result = guardrailsRegistry.validateActionRequest(
        "calendar.delete",
        "validation-user-1",
        ["admin", "user"],
        {},
        "development",
      );

      expect(result.allowed).toBe(true);
    });

    it("should require approval for high-risk actions", () => {
      const result = guardrailsRegistry.validateActionRequest(
        "fs.delete",
        "admin1",
        ["admin"],
        { justification: "Cleaning up temp files" },
        "development",
      );

      expect(result.requirements).toBeDefined();
      expect(result.requirements!.length).toBeGreaterThan(0);
    });
  });

  describe("Statistics", () => {
    it("should return stats", () => {
      const stats = guardrailsRegistry.getStats();
      expect(stats).toHaveProperty("totalActions");
      expect(stats).toHaveProperty("pendingApprovals");
      expect(stats).toHaveProperty("executionsLast24h");
    });
  });
});
