import { describe, it, expect } from "vitest";
import {
  matchPattern,
  findApplicablePolicy,
  evaluatePolicy,
  isActionAllowed,
  isApprovalRequired,
  isActionBlocked,
} from "../../../src/policy/rules";
import type { Action } from "../../../src/policy/types";

const makeAction = (type: string): Action => ({
  id: "check",
  type,
  description: "Policy check",
  params: {},
  userId: "system",
  timestamp: new Date(),
});

describe("Policy Rules", () => {
  describe("matchPattern", () => {
    it("matches exact patterns", () => {
      expect(matchPattern("jira.issue.read", "jira.issue.read")).toBe(true);
    });

    it("rejects non-matching patterns", () => {
      expect(matchPattern("jira.issue.read", "jira.issue.delete")).toBe(false);
    });

    it("matches wildcard patterns", () => {
      expect(matchPattern("jira.*.read", "jira.issue.read")).toBe(true);
      expect(matchPattern("*.issue.read", "jira.issue.read")).toBe(true);
    });

    it("rejects wildcard patterns with wrong segment count", () => {
      expect(matchPattern("jira.*", "jira.issue.read")).toBe(false);
    });

    it("matches all-wildcard patterns with correct segments", () => {
      expect(matchPattern("*.*.read", "jira.issue.read")).toBe(true);
    });
  });

  describe("evaluatePolicy", () => {
    it("allows unknown actions by default", () => {
      const action = makeAction("unknown.action");
      const decision = evaluatePolicy(action);
      expect(decision.result).toBe("allow");
      expect(decision.riskLevel).toBe("low");
    });

    it("allows read actions", () => {
      const decision = evaluatePolicy(makeAction("jira.issue.read"));
      expect(decision.result).toBe("allow");
    });

    it("blocks shell exec", () => {
      const decision = evaluatePolicy(makeAction("shell.exec"));
      expect(decision.result).toBe("blocked");
    });

    it("requires approval for deletes", () => {
      const decision = evaluatePolicy(makeAction("jira.issue.delete"));
      expect(decision.result).toBe("approval_required");
    });
  });

  describe("isActionAllowed", () => {
    it("returns true for allowed actions", () => {
      expect(isActionAllowed("jira.issue.read")).toBe(true);
    });

    it("returns false for blocked actions", () => {
      expect(isActionAllowed("shell.exec")).toBe(false);
    });

    it("returns false for approval-required actions", () => {
      expect(isActionAllowed("jira.issue.delete")).toBe(false);
    });
  });

  describe("isApprovalRequired", () => {
    it("returns true for delete actions", () => {
      expect(isApprovalRequired("jira.issue.delete")).toBe(true);
    });

    it("returns false for allowed actions", () => {
      expect(isApprovalRequired("jira.issue.read")).toBe(false);
    });

    it("returns false for blocked actions", () => {
      expect(isApprovalRequired("shell.exec")).toBe(false);
    });
  });

  describe("isActionBlocked", () => {
    it("returns true for blocked actions", () => {
      expect(isActionBlocked("shell.exec")).toBe(true);
    });

    it("returns false for allowed actions", () => {
      expect(isActionBlocked("jira.issue.read")).toBe(false);
    });

    it("returns false for approval-required actions", () => {
      expect(isActionBlocked("jira.issue.delete")).toBe(false);
    });
  });

  describe("findApplicablePolicy", () => {
    it("returns undefined for unknown actions", () => {
      const policy = findApplicablePolicy("completely.unknown.action");
      expect(policy).toBeUndefined();
    });

    it("finds policy for known actions", () => {
      const policy = findApplicablePolicy("jira.issue.read");
      expect(policy).toBeDefined();
    });
  });
});
