import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/env", () => ({
  env: {
    JIRA_BASE_URL: "https://test.atlassian.net",
    JIRA_EMAIL: "test@example.com",
    JIRA_API_TOKEN: "test-token",
    GITLAB_BASE_URL: "https://gitlab.com",
    GITLAB_TOKEN: "",
    GITLAB_WEBHOOK_SECRET: "",
    PORT: 3050,
    NODE_ENV: "test",
    AUTH_USERNAME: "admin",
    AUTH_PASSWORD: "test",
    AUTH_SESSION_SECRET: "test-secret",
    OPENCODE_API_URL: "https://api.opencode.com/v1",
    OPENCODE_API_KEY: "",
    JIRA_PROJECT_KEYS: [],
    ENABLE_CALENDAR_WRITE: false,
    ENABLE_JIRA_TRANSITIONS: true,
    ENABLE_GITLAB_WEBHOOKS: true,
  },
}));

vi.mock("../../../src/audit/logger", () => ({
  auditLogger: { log: vi.fn(async () => {}) },
}));

vi.mock("../../../src/work-items/database", () => ({
  workItemDatabase: {
    createWorkItem: vi.fn(),
    updateWorkItem: vi.fn(),
  },
}));

import { dispatchToolCall } from "../../../src/agent/tool-dispatcher";
import { workItemDatabase } from "../../../src/work-items/database";

describe("Tool Dispatcher: work item dry-run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("work_items.create", () => {
    it("returns a preview without writing to the database", async () => {
      const result = await dispatchToolCall("work_items.create", {
        type: "task",
        title: "Preview item",
        priority: "high",
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect((result.data as any).wouldExecute).toBe(true);
      expect((result.data as any).toolName).toBe("work_items.create");
      expect((result.data as any).riskLevel).toBe("low");
      expect(vi.mocked(workItemDatabase.createWorkItem)).not.toHaveBeenCalled();
    });
  });

  describe("work_items.update", () => {
    it("returns a preview listing only changed fields without writing", async () => {
      const result = await dispatchToolCall("work_items.update", {
        id: "wi-1",
        status: "in_progress",
        priority: "high",
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect((result.data as any).wouldExecute).toBe(true);
      expect((result.data as any).toolName).toBe("work_items.update");
      expect((result.data as any).riskLevel).toBe("medium");

      const changes = (result.data as any).changes as Array<{ field: string }>;
      expect(changes.map((c) => c.field).sort()).toEqual([
        "priority",
        "status",
      ]);
      expect(vi.mocked(workItemDatabase.updateWorkItem)).not.toHaveBeenCalled();
    });

    it("still updates the work item when dryRun is not set", async () => {
      vi.mocked(workItemDatabase.updateWorkItem).mockReturnValue({
        id: "wi-1",
        title: "Updated",
      } as any);

      const result = await dispatchToolCall("work_items.update", {
        id: "wi-1",
        title: "Updated",
      });

      expect(result.success).toBe(true);
      expect((result.data as any).wouldExecute).toBeUndefined();
      expect(vi.mocked(workItemDatabase.updateWorkItem)).toHaveBeenCalledTimes(1);
    });
  });
});
