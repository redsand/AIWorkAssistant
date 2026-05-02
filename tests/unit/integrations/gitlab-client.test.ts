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
    JIRA_BASE_URL: "",
    JIRA_EMAIL: "",
    JIRA_API_TOKEN: "",
    PORT: 3050,
    NODE_ENV: "test",
    AUTH_USERNAME: "admin",
    AUTH_PASSWORD: "test",
    AUTH_SESSION_SECRET: "test-secret",
    OPENCODE_API_URL: "",
    OPENCODE_API_KEY: "",
    JIRA_PROJECT_KEYS: [],
    ENABLE_CALENDAR_WRITE: false,
    ENABLE_JIRA_TRANSITIONS: true,
    ENABLE_GITLAB_WEBHOOKS: true,
  },
}));

import axios from "axios";
import { GitlabClient } from "../../../src/integrations/gitlab/gitlab-client";

function createMockedClient(): {
  client: InstanceType<typeof GitlabClient>;
  mockGet: ReturnType<typeof vi.fn>;
  mockPost: ReturnType<typeof vi.fn>;
  mockPut: ReturnType<typeof vi.fn>;
} {
  const mockGet = vi.fn();
  const mockPost = vi.fn();
  const mockPut = vi.fn();
  vi.mocked(axios.create).mockReturnValue({
    get: mockGet,
    post: mockPost,
    put: mockPut,
    interceptors: {
      response: { use: vi.fn() },
    },
  } as any);

  const client = new GitlabClient();
  return { client, mockGet, mockPost, mockPut };
}

describe("GitlabClient", () => {
  describe("resolveProjectId()", () => {
    it("should return provided projectId when given", () => {
      const { client } = createMockedClient();
      expect(client.resolveProjectId(42)).toBe(42);
      expect(client.resolveProjectId("my/project")).toBe("my%2Fproject");
    });

    it("should fall back to GITLAB_DEFAULT_PROJECT when no projectId", () => {
      const { client } = createMockedClient();
      expect(client.resolveProjectId()).toBe("siem");
    });

    it("should throw when no projectId and no default configured", () => {
      const { client } = createMockedClient();
      vi.spyOn(client, "getDefaultProject").mockReturnValue("");
      expect(() => client.resolveProjectId()).toThrow(
        "No project specified and GITLAB_DEFAULT_PROJECT is not configured",
      );
    });
  });

  describe("getDefaultProject()", () => {
    it("should return configured default project", () => {
      const { client } = createMockedClient();
      expect(client.getDefaultProject()).toBe("siem");
    });
  });

  describe("isConfigured()", () => {
    it("should return true when token is set", () => {
      const { client } = createMockedClient();
      expect(client.isConfigured()).toBe(true);
    });

    it("should return false when token is empty", () => {
      const { client } = createMockedClient();
      (client as any).token = "";
      expect(client.isConfigured()).toBe(false);
    });
  });

  describe("getCurrentUser()", () => {
    it("should fetch current user", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({ data: { username: "admin", id: 1 } });

      const user = await client.getCurrentUser();
      expect(user.username).toBe("admin");
      expect(mockGet).toHaveBeenCalledWith("/api/v4/user");
    });

    it("should throw when not configured", async () => {
      const { client } = createMockedClient();
      (client as any).token = "";
      await expect(client.getCurrentUser()).rejects.toThrow(
        "GitLab client not configured",
      );
    });
  });

  describe("getProject()", () => {
    it("should fetch project by numeric id", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({
        data: { id: 1, name: "siem", path_with_namespace: "hawkio/siem" },
      });

      const project = await client.getProject(1);
      expect(project.name).toBe("siem");
      expect(mockGet).toHaveBeenCalledWith("/api/v4/projects/1");
    });

    it("should encode string project ids", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({
        data: { id: 2, name: "siem", path_with_namespace: "hawkio/siem" },
      });

      await client.getProject("hawkio/siem");
      expect(mockGet).toHaveBeenCalledWith("/api/v4/projects/hawkio%2Fsiem");
    });

    it("should throw on 404", async () => {
      const { client, mockGet } = createMockedClient();
      const error: any = new Error("Not Found");
      error.response = { status: 404 };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockGet.mockRejectedValue(error);

      await expect(client.getProject(999)).rejects.toThrow("not found");
    });
  });

  describe("getProjects()", () => {
    it("should list accessible projects", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({
        data: [
          { id: 1, name: "siem" },
          { id: 2, name: "soc-agent" },
        ],
      });

      const projects = await client.getProjects();
      expect(projects).toHaveLength(2);
      expect(mockGet).toHaveBeenCalledWith("/api/v4/projects", {
        params: expect.objectContaining({ membership: true }),
      });
    });

    it("should throw on 401", async () => {
      const { client, mockGet } = createMockedClient();
      const error: any = new Error("Unauthorized");
      error.response = { status: 401 };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockGet.mockRejectedValue(error);

      await expect(client.getProjects()).rejects.toThrow(
        "authentication failed",
      );
    });
  });

  describe("getMergeRequests()", () => {
    it("should list MRs for default project", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({
        data: [
          { iid: 1, title: "MR 1", state: "opened" },
          { iid: 2, title: "MR 2", state: "opened" },
        ],
      });

      const mrs = await client.getMergeRequests();
      expect(mrs).toHaveLength(2);
      expect(mockGet).toHaveBeenCalledWith(
        "/api/v4/projects/siem/merge_requests",
        expect.objectContaining({
          params: expect.objectContaining({ state: "opened" }),
        }),
      );
    });

    it("should list MRs for specific project with state filter", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({ data: [] });

      await client.getMergeRequests(42, "merged");
      expect(mockGet).toHaveBeenCalledWith(
        "/api/v4/projects/42/merge_requests",
        expect.objectContaining({
          params: expect.objectContaining({ state: "merged" }),
        }),
      );
    });

    it("should throw on 404", async () => {
      const { client, mockGet } = createMockedClient();
      const error: any = new Error("Not Found");
      error.response = { status: 404 };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockGet.mockRejectedValue(error);

      await expect(client.getMergeRequests(999)).rejects.toThrow("not found");
    });
  });

  describe("getMergeRequest()", () => {
    it("should fetch a specific MR by iid", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({
        data: { iid: 5, title: "Fix bug", state: "opened" },
      });

      const mr = await client.getMergeRequest(undefined, 5);
      expect(mr.iid).toBe(5);
      expect(mockGet).toHaveBeenCalledWith(
        "/api/v4/projects/siem/merge_requests/5",
      );
    });

    it("should throw on 404", async () => {
      const { client, mockGet } = createMockedClient();
      const error: any = new Error("Not Found");
      error.response = { status: 404 };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockGet.mockRejectedValue(error);

      await expect(client.getMergeRequest(undefined, 999)).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("createMergeRequest()", () => {
    it("should create an MR with required fields", async () => {
      const { client, mockPost } = createMockedClient();
      mockPost.mockResolvedValue({
        data: {
          iid: 10,
          title: "Feature",
          web_url: "https://gitlab.test.local/mr/10",
        },
      });

      const mr = await client.createMergeRequest(undefined, {
        sourceBranch: "feature-x",
        targetBranch: "main",
        title: "Feature",
      });

      expect(mr.iid).toBe(10);
      expect(mockPost).toHaveBeenCalledWith(
        "/api/v4/projects/siem/merge_requests",
        expect.objectContaining({
          source_branch: "feature-x",
          target_branch: "main",
          title: "Feature",
        }),
      );
    });

    it("should include optional fields", async () => {
      const { client, mockPost } = createMockedClient();
      mockPost.mockResolvedValue({
        data: { iid: 11, title: "With opts" },
      });

      await client.createMergeRequest(undefined, {
        sourceBranch: "feat",
        targetBranch: "main",
        title: "With opts",
        description: "Description",
        labels: "bug,urgent",
        removeSourceBranch: true,
        squash: true,
      });

      expect(mockPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          description: "Description",
          labels: "bug,urgent",
          remove_source_branch: true,
          squash: true,
        }),
      );
    });

    it("should throw on 409 conflict", async () => {
      const { client, mockPost } = createMockedClient();
      const error: any = new Error("Conflict");
      error.response = {
        status: 409,
        data: { message: "already exists" },
      };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockPost.mockRejectedValue(error);

      await expect(
        client.createMergeRequest(undefined, {
          sourceBranch: "feat",
          targetBranch: "main",
          title: "Dup",
        }),
      ).rejects.toThrow("already exists");
    });

    it("should throw on 400 bad request", async () => {
      const { client, mockPost } = createMockedClient();
      const error: any = new Error("Bad Request");
      error.response = {
        status: 400,
        data: { message: ["invalid branch"] },
      };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockPost.mockRejectedValue(error);

      await expect(
        client.createMergeRequest(undefined, {
          sourceBranch: "",
          targetBranch: "main",
          title: "Bad",
        }),
      ).rejects.toThrow("Invalid MR data");
    });
  });

  describe("acceptMergeRequest()", () => {
    it("should merge an MR", async () => {
      const { client, mockPut } = createMockedClient();
      mockPut.mockResolvedValue({
        data: { iid: 5, state: "merged", merged_at: "2025-01-01" },
      });

      const mr = await client.acceptMergeRequest(undefined, 5);
      expect(mr.state).toBe("merged");
      expect(mockPut).toHaveBeenCalledWith(
        "/api/v4/projects/siem/merge_requests/5/merge",
        {},
      );
    });

    it("should pass merge options", async () => {
      const { client, mockPut } = createMockedClient();
      mockPut.mockResolvedValue({
        data: { iid: 5, state: "merged" },
      });

      await client.acceptMergeRequest(undefined, 5, {
        squashCommitMessage: "squashed",
        shouldRemoveSourceBranch: true,
        mergeWhenPipelineSucceeds: true,
      });

      expect(mockPut).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          squash_commit_message: "squashed",
          should_remove_source_branch: true,
          merge_when_pipeline_succeeds: true,
        }),
      );
    });

    it("should throw on 405 merge not allowed", async () => {
      const { client, mockPut } = createMockedClient();
      const error: any = new Error("Method Not Allowed");
      error.response = {
        status: 405,
        data: { message: "Cannot merge" },
      };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockPut.mockRejectedValue(error);

      await expect(client.acceptMergeRequest(undefined, 5)).rejects.toThrow(
        "Cannot merge",
      );
    });

    it("should throw on 406 merge conflict", async () => {
      const { client, mockPut } = createMockedClient();
      const error: any = new Error("Not Acceptable");
      error.response = {
        status: 406,
        data: { message: "merge conflict" },
      };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockPut.mockRejectedValue(error);

      await expect(client.acceptMergeRequest(undefined, 5)).rejects.toThrow(
        "merge conflict",
      );
    });
  });

  describe("getCommit()", () => {
    it("should fetch a commit by sha", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({
        data: { id: "abc123", title: "Fix stuff", short_id: "abc123" },
      });

      const commit = await client.getCommit(undefined, "abc123");
      expect(commit.title).toBe("Fix stuff");
      expect(mockGet).toHaveBeenCalledWith(
        "/api/v4/projects/siem/repository/commits/abc123",
      );
    });

    it("should throw on 404", async () => {
      const { client, mockGet } = createMockedClient();
      const error: any = new Error("Not Found");
      error.response = { status: 404 };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockGet.mockRejectedValue(error);

      await expect(client.getCommit(undefined, "missing")).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("getCommits()", () => {
    it("should list commits for a ref", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({
        data: [
          { id: "a1", title: "Commit 1" },
          { id: "b2", title: "Commit 2" },
        ],
      });

      const commits = await client.getCommits(undefined, "main");
      expect(commits).toHaveLength(2);
      expect(mockGet).toHaveBeenCalledWith(
        "/api/v4/projects/siem/repository/commits",
        expect.objectContaining({
          params: expect.objectContaining({ ref_name: "main" }),
        }),
      );
    });

    it("should pass optional since parameter", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({ data: [] });

      await client.getCommits(undefined, "main", "2025-01-01");
      expect(mockGet).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          params: expect.objectContaining({ since: "2025-01-01" }),
        }),
      );
    });
  });

  describe("addMergeRequestComment()", () => {
    it("should add a comment to an MR", async () => {
      const { client, mockPost } = createMockedClient();
      mockPost.mockResolvedValue({
        data: { id: 1, body: "Looks good" },
      });

      const result = await client.addMergeRequestComment(
        undefined,
        5,
        "Looks good",
      );
      expect(result.body).toBe("Looks good");
      expect(mockPost).toHaveBeenCalledWith(
        "/api/v4/projects/siem/merge_requests/5/notes",
        { body: "Looks good" },
      );
    });

    it("should throw on 404", async () => {
      const { client, mockPost } = createMockedClient();
      const error: any = new Error("Not Found");
      error.response = { status: 404 };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockPost.mockRejectedValue(error);

      await expect(
        client.addMergeRequestComment(undefined, 999, "test"),
      ).rejects.toThrow("not found");
    });
  });

  describe("getBranches()", () => {
    it("should list branches for default project", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({
        data: [
          { name: "main", default: true },
          { name: "develop", default: false },
        ],
      });

      const branches = await client.getBranches();
      expect(branches).toHaveLength(2);
      expect(mockGet).toHaveBeenCalledWith(
        "/api/v4/projects/siem/repository/branches",
        expect.objectContaining({
          params: expect.objectContaining({ per_page: 100 }),
        }),
      );
    });
  });

  describe("listPipelines()", () => {
    it("should list pipelines for default project", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({
        data: [
          { id: 1, status: "success", ref: "main" },
          { id: 2, status: "running", ref: "develop" },
        ],
      });

      const pipelines = await client.listPipelines();
      expect(pipelines).toHaveLength(2);
      expect(mockGet).toHaveBeenCalledWith(
        "/api/v4/projects/siem/pipelines",
        expect.objectContaining({
          params: expect.objectContaining({ per_page: 20 }),
        }),
      );
    });

    it("should filter by ref when provided", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({ data: [] });

      await client.listPipelines(undefined, "develop");
      expect(mockGet).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          params: expect.objectContaining({ ref: "develop" }),
        }),
      );
    });
  });

  describe("getFile()", () => {
    it("should fetch a file from the repository", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({
        data: {
          file_name: "index.ts",
          file_path: "src/index.ts",
          content: "Y29uc29sZS5sb2coJ2hlbGxvJyk=",
          size: 20,
          encoding: "base64",
        },
      });

      const file = await client.getFile(undefined, "src/index.ts");
      expect(file.fileName).toBe("index.ts");
      expect(file.size).toBe(20);
      expect(mockGet).toHaveBeenCalledWith(
        "/api/v4/projects/siem/repository/files/src%2Findex.ts",
        expect.objectContaining({ params: {} }),
      );
    });

    it("should pass ref parameter", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({
        data: {
          file_name: "readme.md",
          file_path: "README.md",
          content: "",
          size: 0,
          encoding: "base64",
        },
      });

      await client.getFile(undefined, "README.md", "develop");
      expect(mockGet).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          params: { ref: "develop" },
        }),
      );
    });

    it("should throw on 404", async () => {
      const { client, mockGet } = createMockedClient();
      const error: any = new Error("Not Found");
      error.response = { status: 404 };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockGet.mockRejectedValue(error);

      await expect(client.getFile(undefined, "missing.txt")).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("validateConfig()", () => {
    it("should return true when config is valid", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({ data: { id: 1 } });

      const valid = await client.validateConfig();
      expect(valid).toBe(true);
    });

    it("should return false when not configured", async () => {
      const { client } = createMockedClient();
      (client as any).token = "";

      const valid = await client.validateConfig();
      expect(valid).toBe(false);
    });

    it("should return false on API error", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockRejectedValue(new Error("Connection refused"));

      const valid = await client.validateConfig();
      expect(valid).toBe(false);
    });
  });
});
