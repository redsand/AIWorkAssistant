/**
 * Unit tests for src/guardrails/enforcement.ts
 *
 * Covers all exported functions and the GuardrailsEnforcer class methods:
 *   - preExecutionCheck (operation mapping, allow/block/approval-required paths)
 *   - postExecutionLog
 *   - requestApproval (success and failure)
 *   - getStats, getPendingApprovals, getUserHistory (delegation to registry)
 *   - mapOperationToAction (all branches via preExecutionCheck)
 *   - estimateImpact (all branches: delete/mass_delete, critical risk, production env)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock dependencies BEFORE importing the module under test
// ---------------------------------------------------------------------------

const mockGetAction = vi.fn();
const mockValidateActionRequest = vi.fn();
const mockCreateActionRequest = vi.fn();
const mockMarkAsExecuted = vi.fn();
const mockGetStats = vi.fn();
const mockGetPendingApprovals = vi.fn();
const mockGetUserHistory = vi.fn();

vi.mock("../../../src/guardrails/action-registry", () => ({
  guardrailsRegistry: {
    getAction: (...args: unknown[]) => mockGetAction(...args),
    validateActionRequest: (...args: unknown[]) =>
      mockValidateActionRequest(...args),
    createActionRequest: (...args: unknown[]) =>
      mockCreateActionRequest(...args),
    markAsExecuted: (...args: unknown[]) => mockMarkAsExecuted(...args),
    getStats: (...args: unknown[]) => mockGetStats(...args),
    getPendingApprovals: (...args: unknown[]) =>
      mockGetPendingApprovals(...args),
    getUserHistory: (...args: unknown[]) => mockGetUserHistory(...args),
  },
  RiskLevel: {
    LOW: "low",
    MEDIUM: "medium",
    HIGH: "high",
    CRITICAL: "critical",
  },
  ActionCategory: {
    DELETE: "delete",
    MASS_DELETE: "mass_delete",
    PRODUCTION_CHANGE: "production_change",
    DEPLOYMENT: "deployment",
    DATA_MODIFICATION: "data_modification",
    SYSTEM_CONFIG: "system_config",
    CALENDAR_MODIFICATION: "calendar_modification",
    INTEGRATION_MODIFICATION: "integration_modification",
    SECURITY_CHANGE: "security_change",
    DATABASE_CHANGE: "database_change",
  },
}));

vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
  },
}));

// Import after mocks are in place
import { guardrailsEnforcer } from "../../../src/guardrails/enforcement";
import axios from "axios";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseContext = (
  overrides?: Partial<{
    userId: string;
    userRoles: string[];
    environment: "development" | "staging" | "production";
    sessionId: string;
  }>,
) => ({
  userId: "user-1",
  userRoles: ["admin"],
  environment: "development" as const,
  ...overrides,
});

const makeAction = (
  overrides: Record<string, unknown> = {},
) => ({
  id: "test.action",
  category: "delete",
  riskLevel: "high",
  operation: "test.op",
  description: "Test action",
  requiresApproval: false,
  requiresMFA: false,
  requiresDryRun: false,
  cooldownPeriod: 0,
  rateLimits: { maxPerHour: 100, maxPerDay: 1000 },
  allowedUsers: [],
  allowedRoles: [],
  requiresConfirmation: false,
  requiresJustification: false,
  impacts: ["test_impact"],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GuardrailsEnforcer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress console.log noise during tests
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // preExecutionCheck
  // =========================================================================

  describe("preExecutionCheck", () => {
    it("allows unknown operations (no action mapping)", async () => {
      const result = await guardrailsEnforcer.preExecutionCheck(
        "unknown.operation",
        {},
        baseContext(),
      );

      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.estimatedImpact).toBeUndefined();
    });

    it("allows when getAction returns undefined for a mapped action id", async () => {
      // mapOperationToAction returns "fs.delete" for "fs.delete"
      mockGetAction.mockReturnValue(undefined);

      const result = await guardrailsEnforcer.preExecutionCheck(
        "fs.delete",
        { files: ["a.txt"] },
        baseContext(),
      );

      expect(result.allowed).toBe(true);
      expect(mockGetAction).toHaveBeenCalledWith("fs.delete");
    });

    it("blocks when validation disallows", async () => {
      const action = makeAction({ id: "fs.delete", requiresApproval: true });
      mockGetAction.mockReturnValue(action);
      mockValidateActionRequest.mockReturnValue({
        allowed: false,
        reason: "User not authorized",
      });

      const result = await guardrailsEnforcer.preExecutionCheck(
        "fs.delete",
        { files: ["a.txt"] },
        baseContext(),
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("User not authorized");
      expect(result.estimatedImpact).toBeDefined();
    });

    it("returns approval-required when action requires approval and validation has requirements", async () => {
      const action = makeAction({
        id: "fs.delete",
        requiresApproval: true,
        category: "delete",
      });
      mockGetAction.mockReturnValue(action);
      // To reach the approval-required block (line 82), validation.allowed must be true
      // AND action.requiresApproval must be true AND validation.requirements must be truthy.
      // The real registry would never return this combination, but the enforcer's code path
      // must handle it (e.g. a custom or overridden registry).
      mockValidateActionRequest.mockReturnValue({
        allowed: true,
        requirements: ["Manager approval required", "User confirmation required"],
      });
      mockCreateActionRequest.mockReturnValue({
        id: "req-001",
        actionId: "fs.delete",
        userId: "user-1",
        timestamp: new Date(),
        params: { files: ["a.txt"] },
        environment: "development",
        status: "pending",
      });

      const result = await guardrailsEnforcer.preExecutionCheck(
        "fs.delete",
        { files: ["a.txt"] },
        baseContext(),
      );

      expect(result.allowed).toBe(false);
      expect(result.requestId).toBe("req-001");
      expect(result.reason).toBe("Approval required");
      expect(result.requirements).toEqual([
        "Manager approval required",
        "User confirmation required",
      ]);
      expect(mockCreateActionRequest).toHaveBeenCalledWith(
        "fs.delete",
        "user-1",
        { files: ["a.txt"] },
        "development",
        ["admin"],
      );
    });

    it("allows when validation passes with no requirements", async () => {
      const action = makeAction({ id: "jira.transition" });
      mockGetAction.mockReturnValue(action);
      mockValidateActionRequest.mockReturnValue({ allowed: true });

      const result = await guardrailsEnforcer.preExecutionCheck(
        "jira.transition",
        {},
        baseContext(),
      );

      expect(result.allowed).toBe(true);
      expect(result.estimatedImpact).toBeDefined();
    });

    it("allows when validation returns allowed=true with requirements but no approval needed", async () => {
      const action = makeAction({ id: "calendar.delete", requiresApproval: false });
      mockGetAction.mockReturnValue(action);
      mockValidateActionRequest.mockReturnValue({
        allowed: true,
        requirements: ["User confirmation required"],
      });

      const result = await guardrailsEnforcer.preExecutionCheck(
        "calendar.delete",
        {},
        baseContext(),
      );

      expect(result.allowed).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Operation mapping branches
    // -----------------------------------------------------------------------

    describe("operation mapping", () => {
      beforeEach(() => {
        mockValidateActionRequest.mockReturnValue({ allowed: true });
      });

      it("maps fs.delete with <=5 files to fs.delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "fs.delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "fs.delete",
          { files: ["a", "b"] },
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("fs.delete");
      });

      it("maps fs.delete with >5 files to fs.mass_delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "fs.mass_delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "fs.delete",
          { files: Array(6).fill("file") },
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("fs.mass_delete");
      });

      it("maps file.delete with >5 files to fs.mass_delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "fs.mass_delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "file.delete",
          { files: Array(6).fill("file") },
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("fs.mass_delete");
      });

      it("maps file.delete with <=5 files to fs.delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "fs.delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "file.delete",
          { files: ["a"] },
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("fs.delete");
      });

      it("maps fs.delete with no files param to fs.delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "fs.delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "fs.delete",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("fs.delete");
      });

      it("maps db.delete with >10 records to db.mass_delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "db.mass_delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "db.delete",
          { records: Array(11).fill({}) },
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("db.mass_delete");
      });

      it("maps db.delete with <=10 records to db.delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "db.delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "db.delete",
          { records: Array(10).fill({}) },
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("db.delete");
      });

      it("maps database.delete to db.delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "db.delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "database.delete",
          { records: [] },
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("db.delete");
      });

      it("maps database.delete with >10 records to db.mass_delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "db.mass_delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "database.delete",
          { records: Array(11).fill({}) },
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("db.mass_delete");
      });

      it("maps database.delete with no records param to db.delete (fallback to empty array)", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "db.delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "database.delete",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("db.delete");
      });

      it("maps db.migrate to db.schema_change", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "db.schema_change" }));
        await guardrailsEnforcer.preExecutionCheck(
          "db.migrate",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("db.schema_change");
      });

      it("maps db.schema_change to db.schema_change", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "db.schema_change" }));
        await guardrailsEnforcer.preExecutionCheck(
          "db.schema_change",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("db.schema_change");
      });

      it("maps deploy with production environment to deploy.production", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "deploy.production" }));
        await guardrailsEnforcer.preExecutionCheck(
          "deploy",
          { environment: "production" },
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("deploy.production");
      });

      it("maps deploy with staging environment to deploy.staging", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "deploy.staging" }));
        await guardrailsEnforcer.preExecutionCheck(
          "deploy",
          { environment: "staging" },
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("deploy.staging");
      });

      it("maps deploy with no environment param to deploy.production (default)", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "deploy.production" }));
        await guardrailsEnforcer.preExecutionCheck(
          "deploy",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("deploy.production");
      });

      it("maps calendar.delete with >3 events to calendar.mass_delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "calendar.mass_delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "calendar.delete",
          { events: Array(4).fill({}) },
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("calendar.mass_delete");
      });

      it("maps calendar.delete with <=3 events to calendar.delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "calendar.delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "calendar.delete",
          { events: Array(3).fill({}) },
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("calendar.delete");
      });

      it("maps jira.delete to jira.delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "jira.delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "jira.delete",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("jira.delete");
      });

      it("maps jira.delete_issue to jira.delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "jira.delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "jira.delete_issue",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("jira.delete");
      });

      it("maps jira.transition to jira.transition", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "jira.transition" }));
        await guardrailsEnforcer.preExecutionCheck(
          "jira.transition",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("jira.transition");
      });

      it("maps jira.project.create to jira.project.create", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "jira.project.create" }));
        await guardrailsEnforcer.preExecutionCheck(
          "jira.project.create",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("jira.project.create");
      });

      it("maps jira.create_project to jira.project.create", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "jira.project.create" }));
        await guardrailsEnforcer.preExecutionCheck(
          "jira.create_project",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("jira.project.create");
      });

      it("maps gitlab.delete_branch to gitlab.delete_branch", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "gitlab.delete_branch" }));
        await guardrailsEnforcer.preExecutionCheck(
          "gitlab.delete_branch",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("gitlab.delete_branch");
      });

      it("maps gitlab.force_push to gitlab.force_push", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "gitlab.force_push" }));
        await guardrailsEnforcer.preExecutionCheck(
          "gitlab.force_push",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("gitlab.force_push");
      });

      it("maps roadmap.delete to roadmap.delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "roadmap.delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "roadmap.delete",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("roadmap.delete");
      });

      it("maps roadmap.delete_roadmap to roadmap.delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "roadmap.delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "roadmap.delete_roadmap",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("roadmap.delete");
      });

      it("maps github.milestone.create to github.milestone.create", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "github.milestone.create" }));
        await guardrailsEnforcer.preExecutionCheck(
          "github.milestone.create",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("github.milestone.create");
      });

      it("maps github.milestone.update to github.milestone.update", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "github.milestone.update" }));
        await guardrailsEnforcer.preExecutionCheck(
          "github.milestone.update",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("github.milestone.update");
      });

      it("maps github.milestone.delete to github.milestone.delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "github.milestone.delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "github.milestone.delete",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("github.milestone.delete");
      });

      it("maps gitlab.milestone.create to gitlab.milestone.create", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "gitlab.milestone.create" }));
        await guardrailsEnforcer.preExecutionCheck(
          "gitlab.milestone.create",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("gitlab.milestone.create");
      });

      it("maps gitlab.milestone.update to gitlab.milestone.update", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "gitlab.milestone.update" }));
        await guardrailsEnforcer.preExecutionCheck(
          "gitlab.milestone.update",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("gitlab.milestone.update");
      });

      it("maps gitlab.milestone.delete to gitlab.milestone.delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "gitlab.milestone.delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "gitlab.milestone.delete",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("gitlab.milestone.delete");
      });

      it("maps jira.sprint.create to jira.sprint.create", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "jira.sprint.create" }));
        await guardrailsEnforcer.preExecutionCheck(
          "jira.sprint.create",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("jira.sprint.create");
      });

      it("maps jira.sprint.update to jira.sprint.update", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "jira.sprint.update" }));
        await guardrailsEnforcer.preExecutionCheck(
          "jira.sprint.update",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("jira.sprint.update");
      });

      it("maps jira.sprint.delete to jira.sprint.delete", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "jira.sprint.delete" }));
        await guardrailsEnforcer.preExecutionCheck(
          "jira.sprint.delete",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("jira.sprint.delete");
      });

      it("maps system.config to system.config_change", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "system.config_change" }));
        await guardrailsEnforcer.preExecutionCheck(
          "system.config",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("system.config_change");
      });

      it("maps config.change to system.config_change", async () => {
        mockGetAction.mockReturnValue(makeAction({ id: "system.config_change" }));
        await guardrailsEnforcer.preExecutionCheck(
          "config.change",
          {},
          baseContext(),
        );
        expect(mockGetAction).toHaveBeenCalledWith("system.config_change");
      });
    });

    // -----------------------------------------------------------------------
    // Impact estimation branches
    // -----------------------------------------------------------------------

    describe("estimateImpact", () => {
      beforeEach(() => {
        mockValidateActionRequest.mockReturnValue({ allowed: true });
      });

      it("adds mass_data_loss and extended_recovery_time for DELETE with >100 items", async () => {
        const action = makeAction({
          id: "fs.delete",
          category: "delete",
          impacts: ["filesystem"],
        });
        mockGetAction.mockReturnValue(action);

        const result = await guardrailsEnforcer.preExecutionCheck(
          "fs.delete",
          { files: Array(101).fill("file") },
          baseContext(),
        );

        expect(result.allowed).toBe(true);
        expect(result.estimatedImpact).toContain("mass_data_loss");
        expect(result.estimatedImpact).toContain("extended_recovery_time");
      });

      it("adds significant_data_loss for DELETE with >10 items but <=100", async () => {
        const action = makeAction({
          id: "fs.delete",
          category: "delete",
          impacts: ["filesystem"],
        });
        mockGetAction.mockReturnValue(action);

        const result = await guardrailsEnforcer.preExecutionCheck(
          "fs.delete",
          { files: Array(11).fill("file") },
          baseContext(),
        );

        expect(result.estimatedImpact).toContain("significant_data_loss");
        expect(result.estimatedImpact).not.toContain("mass_data_loss");
      });

      it("does not add data loss labels for DELETE with <=10 items", async () => {
        const action = makeAction({
          id: "fs.delete",
          category: "delete",
          impacts: ["filesystem"],
        });
        mockGetAction.mockReturnValue(action);

        const result = await guardrailsEnforcer.preExecutionCheck(
          "fs.delete",
          { files: Array(5).fill("file") },
          baseContext(),
        );

        expect(result.estimatedImpact).not.toContain("mass_data_loss");
        expect(result.estimatedImpact).not.toContain("significant_data_loss");
      });

      it("uses items param for count when files/records are absent", async () => {
        const action = makeAction({
          id: "test.delete",
          category: "delete",
          impacts: [],
        });
        mockGetAction.mockReturnValue(action);

        // Force the mapping by using an operation that returns an action ID
        // but we need to bypass the operation mapper. Instead, let's use a known
        // mapped operation and override the action returned.
        mockGetAction.mockReturnValue(action);
        mockValidateActionRequest.mockReturnValue({ allowed: true });

        // Use fs.delete which maps to "fs.delete", then override the action
        const result = await guardrailsEnforcer.preExecutionCheck(
          "fs.delete",
          { items: Array(101).fill("item") },
          baseContext(),
        );

        // The estimateImpact uses items, files, and records arrays, taking the max
        expect(result.estimatedImpact).toContain("mass_data_loss");
      });

      it("adds potential_downtime and user_impact for CRITICAL risk actions", async () => {
        const action = makeAction({
          id: "deploy.production",
          category: "deployment",
          riskLevel: "critical",
          impacts: ["production"],
        });
        mockGetAction.mockReturnValue(action);
        mockValidateActionRequest.mockReturnValue({ allowed: true });

        const result = await guardrailsEnforcer.preExecutionCheck(
          "deploy",
          { environment: "staging" },
          baseContext(),
        );

        expect(result.estimatedImpact).toContain("potential_downtime");
        expect(result.estimatedImpact).toContain("user_impact");
      });

      it("does not add downtime labels for non-critical actions", async () => {
        const action = makeAction({
          id: "jira.transition",
          category: "data_modification",
          riskLevel: "low",
          impacts: ["jira"],
        });
        mockGetAction.mockReturnValue(action);

        const result = await guardrailsEnforcer.preExecutionCheck(
          "jira.transition",
          {},
          baseContext(),
        );

        expect(result.estimatedImpact).not.toContain("potential_downtime");
        expect(result.estimatedImpact).not.toContain("user_impact");
      });

      it("adds production_impact and customer_visible when params.environment is production", async () => {
        const action = makeAction({
          id: "deploy.staging",
          category: "deployment",
          riskLevel: "medium",
          impacts: ["staging"],
        });
        mockGetAction.mockReturnValue(action);

        const result = await guardrailsEnforcer.preExecutionCheck(
          "deploy",
          { environment: "staging" }, // deploy operation param
          baseContext(),
        );

        // params.environment is "staging" here, not "production", so no production labels
        expect(result.estimatedImpact).not.toContain("production_impact");

        // Now test with production params
        mockGetAction.mockReturnValue(action);
        const result2 = await guardrailsEnforcer.preExecutionCheck(
          "deploy",
          { environment: "production" },
          baseContext(),
        );

        expect(result2.estimatedImpact).toContain("production_impact");
        expect(result2.estimatedImpact).toContain("customer_visible");
      });

      it("deduplicates identical impacts", async () => {
        const action = makeAction({
          id: "deploy.production",
          category: "deployment",
          riskLevel: "critical",
          impacts: ["production", "user_impact"], // user_impact is also added by CRITICAL logic
        });
        mockGetAction.mockReturnValue(action);

        const result = await guardrailsEnforcer.preExecutionCheck(
          "deploy",
          { environment: "production" },
          baseContext(),
        );

        // "user_impact" should appear only once despite being in both action.impacts and added by CRITICAL
        const uiCount = result.estimatedImpact!.filter(
          (i) => i === "user_impact",
        ).length;
        expect(uiCount).toBe(1);
      });

      it("handles MASS_DELETE category the same as DELETE for impact", async () => {
        const action = makeAction({
          id: "fs.mass_delete",
          category: "mass_delete",
          riskLevel: "critical",
          impacts: ["filesystem"],
        });
        mockGetAction.mockReturnValue(action);

        const result = await guardrailsEnforcer.preExecutionCheck(
          "fs.delete",
          { files: Array(101).fill("f") },
          baseContext(),
        );

        expect(result.estimatedImpact).toContain("mass_data_loss");
        expect(result.estimatedImpact).toContain("extended_recovery_time");
        expect(result.estimatedImpact).toContain("potential_downtime");
        expect(result.estimatedImpact).toContain("user_impact");
      });
    });
  });

  // =========================================================================
  // postExecutionLog
  // =========================================================================

  describe("postExecutionLog", () => {
    it("delegates to guardrailsRegistry.markAsExecuted with success", async () => {
      mockMarkAsExecuted.mockReturnValue(undefined);

      await guardrailsEnforcer.postExecutionLog("req-001", true);

      expect(mockMarkAsExecuted).toHaveBeenCalledWith(
        "req-001",
        true,
        undefined,
        undefined,
      );
    });

    it("delegates with error and result", async () => {
      mockMarkAsExecuted.mockReturnValue(undefined);
      const error = "Something went wrong";
      const result = { affected: 5 };

      await guardrailsEnforcer.postExecutionLog("req-001", false, error, result);

      expect(mockMarkAsExecuted).toHaveBeenCalledWith(
        "req-001",
        false,
        "Something went wrong",
        { affected: 5 },
      );
    });
  });

  // =========================================================================
  // requestApproval
  // =========================================================================

  describe("requestApproval", () => {
    it("returns success when axios.post resolves", async () => {
      vi.mocked(axios.post).mockResolvedValue({ status: 200 });

      const result = await guardrailsEnforcer.requestApproval(
        "req-001",
        "Urgent fix needed",
      );

      expect(result).toEqual({
        success: true,
        message: "Approval request sent to queue",
      });
      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining("/approvals/guardrails"),
        {
          requestId: "req-001",
          type: "guardrails_action",
          justification: "Urgent fix needed",
        },
      );
    });

    it("returns failure when axios.post rejects", async () => {
      vi.mocked(axios.post).mockRejectedValue(new Error("Network error"));

      const result = await guardrailsEnforcer.requestApproval(
        "req-001",
        "Fix",
      );

      expect(result).toEqual({
        success: false,
        message: "Failed to request approval",
      });
    });

    it("sends POST to the configured apiBaseUrl /approvals/guardrails endpoint", async () => {
      vi.mocked(axios.post).mockResolvedValue({ status: 200 });

      await guardrailsEnforcer.requestApproval("req-002", "test");

      // The singleton was created with the default URL (http://localhost:3000)
      // because process.env.API_BASE_URL was not set at import time.
      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining("/approvals/guardrails"),
        expect.objectContaining({
          requestId: "req-002",
          type: "guardrails_action",
          justification: "test",
        }),
      );
    });
  });

  // =========================================================================
  // getStats
  // =========================================================================

  describe("getStats", () => {
    it("delegates to guardrailsRegistry.getStats", () => {
      const expectedStats = {
        totalActions: 42,
        pendingApprovals: 3,
        executionsLast24h: 10,
        topUsers: [{ userId: "u1", count: 20 }],
      };
      mockGetStats.mockReturnValue(expectedStats);

      const result = guardrailsEnforcer.getStats();

      expect(result).toEqual(expectedStats);
      expect(mockGetStats).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // getPendingApprovals
  // =========================================================================

  describe("getPendingApprovals", () => {
    it("delegates to guardrailsRegistry.getPendingApprovals", () => {
      const expected = [
        { id: "req-001", actionId: "fs.delete", status: "pending" },
      ];
      mockGetPendingApprovals.mockReturnValue(expected);

      const result = guardrailsEnforcer.getPendingApprovals();

      expect(result).toEqual(expected);
      expect(mockGetPendingApprovals).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // getUserHistory
  // =========================================================================

  describe("getUserHistory", () => {
    it("delegates to guardrailsRegistry.getUserHistory without limit", () => {
      const expected = [
        { id: "req-001", actionId: "fs.delete", userId: "user-1" },
      ];
      mockGetUserHistory.mockReturnValue(expected);

      const result = guardrailsEnforcer.getUserHistory("user-1");

      expect(result).toEqual(expected);
      expect(mockGetUserHistory).toHaveBeenCalledWith("user-1", undefined);
    });

    it("delegates to guardrailsRegistry.getUserHistory with limit", () => {
      mockGetUserHistory.mockReturnValue([]);

      guardrailsEnforcer.getUserHistory("user-1", 10);

      expect(mockGetUserHistory).toHaveBeenCalledWith("user-1", 10);
    });
  });

  // =========================================================================
  // Edge cases and integration-style paths
  // =========================================================================

  describe("edge cases", () => {
    it("returns empty estimatedImpact array when action has no impacts and is low risk", async () => {
      const action = makeAction({
        id: "jira.transition",
        category: "data_modification",
        riskLevel: "low",
        impacts: [],
      });
      mockGetAction.mockReturnValue(action);
      mockValidateActionRequest.mockReturnValue({ allowed: true });

      const result = await guardrailsEnforcer.preExecutionCheck(
        "jira.transition",
        {},
        baseContext(),
      );

      expect(result.allowed).toBe(true);
      expect(result.estimatedImpact).toEqual([]);
    });

    it("handles approval path when action requiresApproval but validation has no requirements", async () => {
      // When requiresApproval=true but validateActionRequest returns allowed=false with no requirements,
      // the code path still enters the approval block (it checks validation.requirements truthiness)
      const action = makeAction({
        id: "fs.delete",
        requiresApproval: true,
      });
      mockGetAction.mockReturnValue(action);
      mockValidateActionRequest.mockReturnValue({
        allowed: false,
        // no requirements field
      });

      const result = await guardrailsEnforcer.preExecutionCheck(
        "fs.delete",
        {},
        baseContext(),
      );

      // Since validation.requirements is undefined, the approval-required block is skipped
      expect(result.allowed).toBe(false);
      expect(result.requestId).toBeUndefined();
    });

    it("does not enter approval block when requiresApproval is false", async () => {
      const action = makeAction({
        id: "calendar.delete",
        requiresApproval: false,
      });
      mockGetAction.mockReturnValue(action);
      mockValidateActionRequest.mockReturnValue({
        allowed: true,
        requirements: ["User confirmation required"],
      });

      const result = await guardrailsEnforcer.preExecutionCheck(
        "calendar.delete",
        {},
        baseContext(),
      );

      expect(result.allowed).toBe(true);
      expect(result.requestId).toBeUndefined();
      expect(mockCreateActionRequest).not.toHaveBeenCalled();
    });

    it("passes sessionId through context without using it", async () => {
      const action = makeAction({ id: "jira.transition" });
      mockGetAction.mockReturnValue(action);
      mockValidateActionRequest.mockReturnValue({ allowed: true });

      const result = await guardrailsEnforcer.preExecutionCheck(
        "jira.transition",
        {},
        baseContext({ sessionId: "sess-123" }),
      );

      expect(result.allowed).toBe(true);
    });

    it("handles deploy with non-standard environment string", async () => {
      mockGetAction.mockReturnValue(makeAction({ id: "deploy.staging" }));
      mockValidateActionRequest.mockReturnValue({ allowed: true });

      await guardrailsEnforcer.preExecutionCheck(
        "deploy",
        { environment: "development" },
        baseContext(),
      );

      // "development" !== "production", so maps to deploy.staging
      expect(mockGetAction).toHaveBeenCalledWith("deploy.staging");
    });
  });
});
