import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("axios", () => {
  const mockInstance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    interceptors: {
      response: { use: vi.fn() },
    },
  };
  return {
    default: {
      create: vi.fn(() => mockInstance),
      isAxiosError: vi.fn(),
    },
  };
});

vi.mock("../../../src/config/env", () => ({
  env: {
    GITLAB_BASE_URL: "https://gitlab.test.local",
    GITLAB_TOKEN: "test-token",
    GITLAB_DEFAULT_PROJECT: "siem",
    GITLAB_WEBHOOK_SECRET: "",
    JIRA_BASE_URL: "https://test.atlassian.net",
    JIRA_EMAIL: "test@example.com",
    JIRA_API_TOKEN: "test-token",
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
  auditLogger: {
    log: vi.fn(async () => {}),
  },
}));

vi.mock("../../../src/integrations/jira/jira-client", () => ({
  jiraClient: {
    isConfigured: vi.fn(() => false),
    getProjects: vi.fn(),
    getProject: vi.fn(),
  },
}));

vi.mock("../../../src/integrations/jira/jira-service", () => ({
  jiraService: {
    getAssignedIssues: vi.fn(),
    getIssue: vi.fn(),
    addComment: vi.fn(),
    transitionIssue: vi.fn(),
    createProject: vi.fn(),
    getProject: vi.fn(),
  },
}));

vi.mock("../../../src/integrations/file/calendar-service", () => ({
  fileCalendarService: {
    listEvents: vi.fn(),
    createFocusBlock: vi.fn(),
    createHealthBlock: vi.fn(),
  },
}));

vi.mock("../../../src/productivity/daily-planner", () => ({
  dailyPlanner: {
    generatePlan: vi.fn(),
  },
}));

import { gitlabClient } from "../../../src/integrations/gitlab/gitlab-client";
import { dispatchToolCall } from "../../../src/agent/tool-dispatcher";

describe("Tool Dispatcher: GitLab", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("gitlab.list_projects", () => {
    it("should return formatted project list", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(gitlabClient, "getProjects").mockResolvedValue([
        {
          id: 1,
          name: "siem",
          path_with_namespace: "hawkio/siem",
          web_url: "https://gitlab.test.local/hawkio/siem",
        },
        {
          id: 2,
          name: "soc-agent",
          path_with_namespace: "hawkio/soc-agent",
          web_url: "https://gitlab.test.local/hawkio/soc-agent",
        },
      ] as any);

      const result = await dispatchToolCall("gitlab.list_projects", {});

      expect(result.success).toBe(true);
      const data = result.data as any[];
      expect(data).toHaveLength(2);
      expect(data[0].name).toBe("siem");
      expect(data[0].path).toBe("hawkio/siem");
    });

    it("should fail when not configured", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(false);

      const result = await dispatchToolCall("gitlab.list_projects", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("not configured");
    });
  });

  describe("gitlab.get_project", () => {
    it("should return project details", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(gitlabClient, "getDefaultProject").mockReturnValue("siem");
      vi.spyOn(gitlabClient, "getProject").mockResolvedValue({
        id: 1,
        name: "siem",
        path_with_namespace: "hawkio/siem",
        web_url: "https://gitlab.test.local/hawkio/siem",
        default_branch: "main",
        topics: ["security", "monitoring"],
      } as any);

      const result = await dispatchToolCall("gitlab.get_project", {});

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.name).toBe("siem");
      expect(data.defaultBranch).toBe("main");
    });

    it("should use explicit projectId over default", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(gitlabClient, "getDefaultProject").mockReturnValue("siem");
      vi.spyOn(gitlabClient, "getProject").mockResolvedValue({
        id: 2,
        name: "other",
        path_with_namespace: "hawkio/other",
        web_url: "https://gitlab.test.local/hawkio/other",
        default_branch: "develop",
        topics: [],
      } as any);

      const result = await dispatchToolCall("gitlab.get_project", {
        projectId: "hawkio/other",
      });

      expect(result.success).toBe(true);
      expect(gitlabClient.getProject).toHaveBeenCalledWith("hawkio/other");
    });

    it("should fail when no projectId and no default", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(gitlabClient, "getDefaultProject").mockReturnValue("");

      const result = await dispatchToolCall("gitlab.get_project", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("projectId is required");
    });
  });

  describe("gitlab.list_merge_requests", () => {
    it("should return formatted MR list", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(gitlabClient, "getMergeRequests").mockResolvedValue([
        {
          iid: 1,
          title: "Fix auth bug",
          state: "opened",
          author: { username: "dev", name: "Developer" },
          source_branch: "fix-auth",
          target_branch: "main",
          created_at: "2025-01-01",
          updated_at: "2025-01-02",
          web_url: "https://gitlab.test.local/mr/1",
        },
      ] as any);

      const result = await dispatchToolCall("gitlab.list_merge_requests", {
        state: "opened",
      });

      expect(result.success).toBe(true);
      const data = result.data as any[];
      expect(data).toHaveLength(1);
      expect(data[0].iid).toBe(1);
      expect(data[0].author).toBe("dev");
    });

    it("should pass projectId when provided", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(gitlabClient, "getMergeRequests").mockResolvedValue([]);

      await dispatchToolCall("gitlab.list_merge_requests", {
        projectId: "42",
        state: "merged",
      });

      expect(gitlabClient.getMergeRequests).toHaveBeenCalledWith(
        "42",
        "merged",
      );
    });
  });

  describe("gitlab.get_merge_request", () => {
    it("should return MR details", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(gitlabClient, "getMergeRequest").mockResolvedValue({
        iid: 5,
        title: "Feature X",
        description: "Implements feature X",
        state: "opened",
        author: { name: "Dev" },
        source_branch: "feat-x",
        target_branch: "main",
        created_at: "2025-01-01",
        updated_at: "2025-01-02",
        merged_at: null,
        web_url: "https://gitlab.test.local/mr/5",
      } as any);

      const result = await dispatchToolCall("gitlab.get_merge_request", {
        mrIid: 5,
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.iid).toBe(5);
      expect(data.description).toBe("Implements feature X");
    });

    it("should fail when mrIid is missing", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);

      const result = await dispatchToolCall("gitlab.get_merge_request", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("mrIid is required");
    });
  });

  describe("gitlab.create_merge_request", () => {
    it("should create an MR and return summary", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(gitlabClient, "createMergeRequest").mockResolvedValue({
        iid: 12,
        title: "New feature",
        state: "opened",
        source_branch: "feat",
        target_branch: "main",
        web_url: "https://gitlab.test.local/mr/12",
      } as any);

      const result = await dispatchToolCall("gitlab.create_merge_request", {
        sourceBranch: "feat",
        targetBranch: "main",
        title: "New feature",
        description: "Details",
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.iid).toBe(12);
      expect(data.url).toBe("https://gitlab.test.local/mr/12");
    });

    it("should fail when required fields are missing", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);

      const result = await dispatchToolCall("gitlab.create_merge_request", {
        sourceBranch: "feat",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("sourceBranch, targetBranch, and title");
    });
  });

  describe("gitlab.merge_merge_request", () => {
    it("should merge an MR and return result", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(gitlabClient, "acceptMergeRequest").mockResolvedValue({
        iid: 5,
        title: "Fix",
        state: "merged",
        merged_at: "2025-01-01",
        web_url: "https://gitlab.test.local/mr/5",
      } as any);

      const result = await dispatchToolCall("gitlab.merge_merge_request", {
        mrIid: 5,
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.state).toBe("merged");
    });

    it("should fail when mrIid is missing", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);

      const result = await dispatchToolCall("gitlab.merge_merge_request", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("mrIid is required");
    });
  });

  describe("gitlab.add_mr_comment", () => {
    it("should add a comment to an MR", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(gitlabClient, "addMergeRequestComment").mockResolvedValue({
        id: 42,
        body: "LGTM",
      });

      const result = await dispatchToolCall("gitlab.add_mr_comment", {
        mrIid: 5,
        body: "LGTM",
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.id).toBe(42);
      expect(data.body).toBe("LGTM");
    });

    it("should fail when mrIid or body is missing", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);

      const result = await dispatchToolCall("gitlab.add_mr_comment", {
        mrIid: 5,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("mrIid and body are required");
    });
  });

  describe("gitlab.list_branches", () => {
    it("should return formatted branch list", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(gitlabClient, "getBranches").mockResolvedValue([
        {
          name: "main",
          default: true,
          merged: false,
          commit: { short_id: "a1b2c3" },
        },
        {
          name: "develop",
          default: false,
          merged: true,
          commit: { short_id: "d4e5f6" },
        },
      ] as any);

      const result = await dispatchToolCall("gitlab.list_branches", {});

      expect(result.success).toBe(true);
      const data = result.data as any[];
      expect(data).toHaveLength(2);
      expect(data[0].name).toBe("main");
      expect(data[0].default).toBe(true);
      expect(data[0].lastCommit).toBe("a1b2c3");
    });
  });

  describe("gitlab.list_commits", () => {
    it("should return formatted commit list", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(gitlabClient, "getCommits").mockResolvedValue([
        {
          id: "abc1234567890",
          short_id: "abc12345",
          title: "Fix bug",
          author_name: "Dev",
          created_at: "2025-01-01",
        },
        {
          id: "def6789012345",
          short_id: "def67890",
          title: "Add feature",
          author_name: "Dev2",
          created_at: "2025-01-02",
        },
      ] as any);

      const result = await dispatchToolCall("gitlab.list_commits", {
        ref: "main",
      });

      expect(result.success).toBe(true);
      const data = result.data as any[];
      expect(data).toHaveLength(2);
      expect(data[0].id).toBe("abc12345");
      expect(data[0].author).toBe("Dev");
    });

    it("should default to 'main' ref when not specified", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(gitlabClient, "getCommits").mockResolvedValue([]);

      await dispatchToolCall("gitlab.list_commits", {});

      expect(gitlabClient.getCommits).toHaveBeenCalledWith(
        undefined,
        "main",
        undefined,
      );
    });
  });

  describe("gitlab.get_commit", () => {
    it("should return commit details", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(gitlabClient, "getCommit").mockResolvedValue({
        id: "abc123",
        short_id: "abc123",
        title: "Fix auth",
        author_name: "Dev",
      } as any);

      const result = await dispatchToolCall("gitlab.get_commit", {
        sha: "abc123",
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.title).toBe("Fix auth");
    });

    it("should fail when sha is missing", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);

      const result = await dispatchToolCall("gitlab.get_commit", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("sha is required");
    });
  });

  describe("gitlab.list_pipelines", () => {
    it("should return formatted pipeline list", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(gitlabClient, "listPipelines").mockResolvedValue([
        {
          id: 1,
          ref: "main",
          status: "success",
          source: "push",
          created_at: "2025-01-01",
          web_url: "https://gitlab.test.local/pipeline/1",
        },
        {
          id: 2,
          ref: "develop",
          status: "running",
          source: "push",
          created_at: "2025-01-02",
          web_url: "https://gitlab.test.local/pipeline/2",
        },
      ] as any);

      const result = await dispatchToolCall("gitlab.list_pipelines", {});

      expect(result.success).toBe(true);
      const data = result.data as any[];
      expect(data).toHaveLength(2);
      expect(data[0].status).toBe("success");
      expect(data[1].ref).toBe("develop");
    });
  });

  describe("gitlab.get_file", () => {
    it("should return file details", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(gitlabClient, "getFile").mockResolvedValue({
        fileName: "index.ts",
        filePath: "src/index.ts",
        content: "Y29uc29sZS5sb2coJ2hlbGxvJyk=",
        size: 20,
        encoding: "base64",
      });

      const result = await dispatchToolCall("gitlab.get_file", {
        filePath: "src/index.ts",
        ref: "main",
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.fileName).toBe("index.ts");
    });

    it("should fail when filePath is missing", async () => {
      vi.spyOn(gitlabClient, "isConfigured").mockReturnValue(true);

      const result = await dispatchToolCall("gitlab.get_file", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("filePath is required");
    });
  });

  describe("unknown gitlab tool", () => {
    it("should return error for unknown tool name", async () => {
      const result = await dispatchToolCall("gitlab.nonexistent", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown tool");
    });
  });
});
