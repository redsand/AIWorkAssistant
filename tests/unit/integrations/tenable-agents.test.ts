import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/env", () => ({
  resolvePath: (rel: string) => rel,
  env: {
    TENABLE_CLOUD_ACCESS_KEY: "test-access-key",
    TENABLE_CLOUD_SECRET_KEY: "test-secret-key",
    PORT: 3050,
    NODE_ENV: "test",
    AUTH_USERNAME: "admin",
    AUTH_PASSWORD: "test",
    AUTH_SESSION_SECRET: "test-secret",
    OPENCODE_API_URL: "https://api.opencode.com/v1",
    OPENCODE_API_KEY: "",
    JIRA_BASE_URL: "",
    JIRA_EMAIL: "",
    JIRA_API_TOKEN: "",
    GITLAB_BASE_URL: "",
    GITLAB_TOKEN: "",
    GITHUB_TOKEN: "",
    ENABLE_CALENDAR_WRITE: false,
    ENABLE_JIRA_TRANSITIONS: false,
    ENABLE_GITLAB_WEBHOOKS: false,
    JIRA_PROJECT_KEYS: [],
  },
}));

vi.mock("../../../src/audit/logger", () => ({
  auditLogger: {
    log: vi.fn(async () => {}),
  },
}));

vi.mock("../../../src/policy/engine", () => ({
  policyEngine: {
    evaluate: vi.fn(async () => ({ result: "allow", riskLevel: "low", reason: "test" })),
    canProceed: vi.fn(() => true),
    requiresApproval: vi.fn(() => false),
    isBlocked: vi.fn(() => false),
    createApprovalRequest: vi.fn(),
  },
}));

vi.mock("../../../src/approvals/queue", () => ({
  approvalQueue: {
    enqueue: vi.fn(async (r) => r),
    approve: vi.fn(),
    reject: vi.fn(),
    list: vi.fn(async () => ({ approvals: [], total: 0, filtered: 0 })),
  },
}));

import { tenableCloudService } from "../../../src/integrations/tenable-cloud/tenable-cloud-service";
import { dispatchToolCall } from "../../../src/agent/tool-dispatcher";

describe("Tool Dispatcher: Tenable Agents", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("tenable.list_agents", () => {
    it("should return agent list from Tenable", async () => {
      vi.spyOn(tenableCloudService, "isConfigured").mockReturnValue(true);
      vi.spyOn(tenableCloudService, "listAgents").mockResolvedValue({
        agents: [
          { id: 1, name: "web-server-01", ip: "10.0.1.5", status: "on", platform: "Linux" },
          { id: 2, name: "db-server-01", ip: "10.0.1.6", status: "off", platform: "Windows" },
        ],
        pagination: { total: 2 },
      } as any);

      const result = await dispatchToolCall("tenable.list_agents", {});

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(tenableCloudService.listAgents).toHaveBeenCalled();
    });

    it("should pass offset and limit params", async () => {
      vi.spyOn(tenableCloudService, "isConfigured").mockReturnValue(true);
      vi.spyOn(tenableCloudService, "listAgents").mockResolvedValue({
        agents: [],
        pagination: { total: 0 },
      } as any);

      const result = await dispatchToolCall("tenable.list_agents", { offset: 10, limit: 50 });

      expect(result.success).toBe(true);
      expect(tenableCloudService.listAgents).toHaveBeenCalledWith(
        { offset: 10, limit: 50 },
        undefined,
      );
    });

    it("should fail when Tenable is not configured", async () => {
      vi.spyOn(tenableCloudService, "isConfigured").mockReturnValue(false);

      const result = await dispatchToolCall("tenable.list_agents", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("not configured");
    });
  });
});
