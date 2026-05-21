import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { repoDashboardRoutes } from "../repo-dashboard";
import { githubClient } from "../../integrations/github/github-client";
import { gitlabClient } from "../../integrations/gitlab/gitlab-client";
import { jiraClient } from "../../integrations/jira/jira-client";
import { workItemDatabase } from "../../work-items/database";

vi.mock("../../integrations/github/github-client", () => ({
  githubClient: {
    updateIssue: vi.fn(),
    listIssues: vi.fn().mockResolvedValue([]),
    listRepositories: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../integrations/gitlab/gitlab-client", () => ({
  gitlabClient: {
    editIssue: vi.fn(),
    listIssues: vi.fn().mockResolvedValue([]),
    getProjects: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../integrations/jira/jira-client", () => ({
  jiraClient: {
    getTransitions: vi.fn().mockResolvedValue([]),
    transitionIssue: vi.fn().mockResolvedValue(undefined),
    searchIssues: vi.fn().mockResolvedValue([]),
    getProjects: vi.fn().mockResolvedValue([]),
    getSprints: vi.fn().mockResolvedValue([]),
    getSprintIssues: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../work-items/database", () => ({
  workItemDatabase: {
    listWorkItems: vi.fn().mockReturnValue({ total: 0, items: [] }),
    updateWorkItem: vi.fn().mockReturnValue(true),
  },
}));

const mockGithub = vi.mocked(githubClient);
const mockGitlab = vi.mocked(gitlabClient);
const mockJira = vi.mocked(jiraClient);
const mockWorkItems = vi.mocked(workItemDatabase);

describe("repo-dashboard /transition endpoint", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(repoDashboardRoutes);
    await app.ready();
  });

  beforeEach(() => {
    vi.mocked(mockGithub.updateIssue).mockClear();
    vi.mocked(mockGitlab.editIssue).mockClear();
    vi.mocked(mockJira.getTransitions).mockClear();
    vi.mocked(mockJira.transitionIssue).mockClear();
    vi.mocked(mockWorkItems.updateWorkItem).mockClear();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("validation", () => {
    it("should return 400 when issueId is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/transition",
        payload: { platform: "github", repo: "org/repo", status: "done" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain("required");
    });

    it("should return 400 when platform is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/transition",
        payload: { issueId: "1", repo: "org/repo", status: "done" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().success).toBe(false);
    });

    it("should return 400 when repo is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/transition",
        payload: { issueId: "1", platform: "github", status: "done" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("should return 400 when status is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/transition",
        payload: { issueId: "1", platform: "github", repo: "org/repo" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("should return 400 for invalid status value", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/transition",
        payload: { issueId: "1", platform: "github", repo: "org/repo", status: "invalid_status" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("Invalid status");
    });

    it("should return 400 for empty body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/transition",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("github transitions", () => {
    it("should close a GitHub issue when status is done", async () => {
      mockGithub.updateIssue.mockResolvedValueOnce({} as any);

      const res = await app.inject({
        method: "POST",
        url: "/transition",
        payload: { issueId: "42", platform: "github", repo: "org/repo", status: "done" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(mockGithub.updateIssue).toHaveBeenCalledWith(42, { state: "closed" }, "org", "repo");
    });

    it("should reopen a GitHub issue when status is open", async () => {
      mockGithub.updateIssue.mockResolvedValueOnce({} as any);

      const res = await app.inject({
        method: "POST",
        url: "/transition",
        payload: { issueId: "42", platform: "github", repo: "org/repo", status: "open" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(mockGithub.updateIssue).toHaveBeenCalledWith(42, { state: "open" }, "org", "repo");
    });

    it("should reject GitHub transition to in_progress", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/transition",
        payload: { issueId: "42", platform: "github", repo: "org/repo", status: "in_progress" },
      });
      expect(res.json().success).toBe(false);
      expect(res.json().error).toContain("GitHub only supports open and closed");
    });
  });

  describe("gitlab transitions", () => {
    it("should close a GitLab issue when status is done", async () => {
      mockGitlab.editIssue.mockResolvedValueOnce({} as any);

      const res = await app.inject({
        method: "POST",
        url: "/transition",
        payload: { issueId: "7", platform: "gitlab", repo: "123", status: "done" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(mockGitlab.editIssue).toHaveBeenCalledWith("123", 7, { stateEvent: "close" });
    });
  });

  describe("jira transitions", () => {
    it("should transition a Jira issue when matching transition exists", async () => {
      mockJira.getTransitions.mockResolvedValueOnce([
        { id: "21", name: "Start Progress", to: { name: "In Progress" } },
      ] as any);
      mockJira.transitionIssue.mockResolvedValueOnce(undefined);

      const res = await app.inject({
        method: "POST",
        url: "/transition",
        payload: { issueId: "PROJ-1", platform: "jira", repo: "PROJ", status: "in_progress" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(mockJira.transitionIssue).toHaveBeenCalledWith("PROJ-1", "21", expect.any(String));
    });

    it("should fail when no matching Jira transition found", async () => {
      mockJira.getTransitions.mockResolvedValueOnce([]);

      const res = await app.inject({
        method: "POST",
        url: "/transition",
        payload: { issueId: "PROJ-1", platform: "jira", repo: "PROJ", status: "done" },
      });
      expect(res.json().success).toBe(false);
      expect(res.json().error).toContain("No available transition");
    });
  });

  describe("work_items transitions", () => {
    it("should update work item status", async () => {
      mockWorkItems.updateWorkItem.mockReturnValueOnce({ id: "w1", status: "active" } as any);

      const res = await app.inject({
        method: "POST",
        url: "/transition",
        payload: { issueId: "w1", platform: "work_items", repo: "internal", status: "in_progress" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(mockWorkItems.updateWorkItem).toHaveBeenCalledWith("w1", { status: "active" });
    });

    it("should return failure when work item not found", async () => {
      mockWorkItems.updateWorkItem.mockReturnValueOnce(null as any);

      const res = await app.inject({
        method: "POST",
        url: "/transition",
        payload: { issueId: "missing", platform: "work_items", repo: "internal", status: "done" },
      });
      expect(res.json().success).toBe(false);
      expect(res.json().error).toContain("not found");
    });
  });

  describe("unsupported platform", () => {
    it("should return error for unknown platform", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/transition",
        payload: { issueId: "1", platform: "trello", repo: "board", status: "done" },
      });
      expect(res.json().success).toBe(false);
      expect(res.json().error).toContain("Unsupported platform");
    });
  });

  describe("error handling", () => {
    it("should return generic error message on internal failure", async () => {
      mockGithub.updateIssue.mockRejectedValueOnce(new Error("DB connection lost: password=secret"));

      const res = await app.inject({
        method: "POST",
        url: "/transition",
        payload: { issueId: "1", platform: "github", repo: "org/repo", status: "done" },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().success).toBe(false);
      expect(res.json().error).toBe("Failed to transition issue");
      expect(res.json().error).not.toContain("password");
      expect(res.json().error).not.toContain("secret");
    });
  });

  describe("idempotency", () => {
    it("should return success when called twice with same parameters", async () => {
      mockGithub.updateIssue.mockResolvedValue({} as any);

      const payload = { issueId: "99", platform: "github", repo: "org/repo", status: "done" };

      const res1 = await app.inject({ method: "POST", url: "/transition", payload });
      const res2 = await app.inject({ method: "POST", url: "/transition", payload });

      expect(res1.statusCode).toBe(200);
      expect(res1.json().success).toBe(true);
      expect(res2.statusCode).toBe(200);
      expect(res2.json().success).toBe(true);
      expect(mockGithub.updateIssue).toHaveBeenCalledTimes(2);
    });

    it("should handle idempotent work_items transition", async () => {
      mockWorkItems.updateWorkItem.mockReturnValue({ id: "w1" } as any);

      const payload = { issueId: "w1", platform: "work_items", repo: "internal", status: "done" };

      const res1 = await app.inject({ method: "POST", url: "/transition", payload });
      const res2 = await app.inject({ method: "POST", url: "/transition", payload });

      expect(res1.json().success).toBe(true);
      expect(res2.json().success).toBe(true);
    });
  });
});
