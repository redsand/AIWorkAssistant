/**
 * Unit tests for repo-dashboard sprint & burndown endpoints.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import {
  parseDependencies,
  normalizeStatus,
  normalizePriority,
  calculateBurndown,
  repoDashboardRoutes,
  invalidateIssueCache,
} from "../../../src/routes/repo-dashboard";
import type {
  DashboardSprint,
  DashboardIssue,
} from "../../../src/routes/repo-dashboard";

vi.mock("../../../src/integrations/github/github-client", () => ({
  githubClient: { listRepositories: vi.fn(), listIssues: vi.fn(), listMilestones: vi.fn() },
}));
vi.mock("../../../src/integrations/gitlab/gitlab-client", () => ({
  gitlabClient: { getProjects: vi.fn(), listIssues: vi.fn() },
}));
vi.mock("../../../src/integrations/jira/jira-client", () => ({
  jiraClient: { getProjects: vi.fn(), searchIssues: vi.fn(), getSprints: vi.fn(), getSprintIssues: vi.fn() },
}));
vi.mock("../../../src/work-items/database", () => ({
  workItemDatabase: { listWorkItems: vi.fn() },
}));
vi.mock("../../../src/config/env", () => ({
  env: { GITHUB_TOKEN: "gh-test-token", GITHUB_DEFAULT_OWNER: "test-org", GITHUB_DEFAULT_REPO: "test-repo", GITLAB_TOKEN: "gl-test-token", JIRA_BASE_URL: "https://test.atlassian.net", JIRA_API_TOKEN: "jira-test-token" },
}));

import { githubClient } from "../../../src/integrations/github/github-client";
import { gitlabClient } from "../../../src/integrations/gitlab/gitlab-client";
import { jiraClient } from "../../../src/integrations/jira/jira-client";
import { workItemDatabase } from "../../../src/work-items/database";

describe("parseDependencies", () => {
  it("should return empty array for empty body", () => { expect(parseDependencies("")).toEqual([]); });
  it("should return empty array for null", () => { expect(parseDependencies(null as any)).toEqual([]); });
  it("should parse depends on", () => { expect(parseDependencies("depends on #123")).toEqual([{ id: "123", label: "depends on #123" }]); });
  it("should parse blocked by", () => { expect(parseDependencies("blocked by #456")).toEqual([{ id: "456", label: "blocked by #456" }]); });
  it("should parse requires", () => { expect(parseDependencies("Requires #789")).toEqual([{ id: "789", label: "Requires #789" }]); });
  it("should parse prerequisite", () => { expect(parseDependencies("prerequisite: #321")).toEqual([{ id: "321", label: "prerequisite: #321" }]); });
  it("should deduplicate same id", () => { expect(parseDependencies("depends on #100 and depends on #100")).toEqual([{ id: "100", label: "depends on #100" }]); });
  it("should parse multiple deps", () => { const r = parseDependencies("depends on #1 and blocked by #2"); expect(r).toHaveLength(2); });
  it("should be case insensitive", () => { expect(parseDependencies("DEPENDS ON #5")).toEqual([{ id: "5", label: "DEPENDS ON #5" }]); });
  it("should return empty for no match", () => { expect(parseDependencies("Just a task")).toEqual([]); });
});

describe("normalizeStatus", () => {
  it("null -> unknown", () => { expect(normalizeStatus(null, "github")).toBe("unknown"); });
  it("undefined -> unknown", () => { expect(normalizeStatus(undefined, "github")).toBe("unknown"); });
  it("empty -> unknown", () => { expect(normalizeStatus("", "github")).toBe("unknown"); });
  it("github open", () => { expect(normalizeStatus("open", "github")).toBe("open"); });
  it("github closed -> done", () => { expect(normalizeStatus("closed", "github")).toBe("done"); });
  it("github unknown", () => { expect(normalizeStatus("pending", "github")).toBe("unknown"); });
  it("gitlab opened -> open", () => { expect(normalizeStatus("opened", "gitlab")).toBe("open"); });
  it("gitlab closed -> done", () => { expect(normalizeStatus("closed", "gitlab")).toBe("done"); });
  it("gitlab unknown", () => { expect(normalizeStatus("pending", "gitlab")).toBe("unknown"); });
  it("jira to do -> open", () => { expect(normalizeStatus("to do", "jira")).toBe("open"); });
  it("jira backlog -> open", () => { expect(normalizeStatus("backlog", "jira")).toBe("open"); });
  it("jira in progress", () => { expect(normalizeStatus("in progress", "jira")).toBe("in_progress"); });
  it("jira in review", () => { expect(normalizeStatus("in review", "jira")).toBe("in_progress"); });
  it("jira done", () => { expect(normalizeStatus("done", "jira")).toBe("done"); });
  it("jira resolved -> done", () => { expect(normalizeStatus("resolved", "jira")).toBe("done"); });
  it("jira blocked", () => { expect(normalizeStatus("blocked", "jira")).toBe("blocked"); });
  it("jira on hold -> blocked", () => { expect(normalizeStatus("on hold", "jira")).toBe("blocked"); });
  it("jira unknown -> open", () => { expect(normalizeStatus("something-else", "jira")).toBe("open"); });
  it("work_items proposed -> open", () => { expect(normalizeStatus("proposed", "work_items")).toBe("open"); });
  it("work_items active -> in_progress", () => { expect(normalizeStatus("active", "work_items")).toBe("in_progress"); });
  it("work_items done", () => { expect(normalizeStatus("done", "work_items")).toBe("done"); });
  it("work_items archived -> done", () => { expect(normalizeStatus("archived", "work_items")).toBe("done"); });
  it("work_items blocked", () => { expect(normalizeStatus("blocked", "work_items")).toBe("blocked"); });
  it("work_items unknown -> open", () => { expect(normalizeStatus("unknown", "work_items")).toBe("open"); });
  it("unknown platform -> unknown", () => { expect(normalizeStatus("open", "slack")).toBe("unknown"); });
  it("case insensitive", () => { expect(normalizeStatus("Open", "github")).toBe("open"); expect(normalizeStatus("CLOSED", "github")).toBe("done"); });
});

describe("normalizePriority", () => {
  it("null+empty -> unknown", () => { expect(normalizePriority(null, [])).toBe("unknown"); });
  it("critical", () => { expect(normalizePriority("critical", [])).toBe("critical"); });
  it("blocker -> critical", () => { expect(normalizePriority(null, ["blocker"])).toBe("critical"); });
  it("highest -> critical", () => { expect(normalizePriority("highest", [])).toBe("critical"); });
  it("crit -> critical", () => { expect(normalizePriority(null, ["crit"])).toBe("critical"); });
  it("high", () => { expect(normalizePriority("high", [])).toBe("high"); });
  it("priority: high", () => { expect(normalizePriority(null, ["priority: high"])).toBe("high"); });
  it("p1 -> high", () => { expect(normalizePriority(null, ["p1"])).toBe("high"); });
  it("medium", () => { expect(normalizePriority("medium", [])).toBe("medium"); });
  it("priority: medium", () => { expect(normalizePriority(null, ["priority: medium"])).toBe("medium"); });
  it("p2 -> medium", () => { expect(normalizePriority(null, ["p2"])).toBe("medium"); });
  it("normal -> medium", () => { expect(normalizePriority("normal", [])).toBe("medium"); });
  it("low", () => { expect(normalizePriority("low", [])).toBe("low"); });
  it("priority: low", () => { expect(normalizePriority(null, ["priority: low"])).toBe("low"); });
  it("p3 -> low", () => { expect(normalizePriority(null, ["p3"])).toBe("low"); });
  it("minor -> low", () => { expect(normalizePriority(null, ["minor"])).toBe("low"); });
  it("trivial -> low", () => { expect(normalizePriority(null, ["trivial"])).toBe("low"); });
  it("higher wins", () => { expect(normalizePriority("low", ["critical"])).toBe("critical"); });
  it("unknown", () => { expect(normalizePriority("unknown", [])).toBe("unknown"); });
});

describe("calculateBurndown", () => {
  const baseSprint: DashboardSprint = { id: "s1", name: "S1", state: "active", startDate: "2025-01-01T00:00:00Z", endDate: "2025-01-14T00:00:00Z", totalPoints: 5, completedPoints: 0, platform: "github", repo: "org/repo" };
  it("invalid dates -> empty", () => { const r = calculateBurndown({ ...baseSprint, startDate: "", endDate: "" }, []); expect(r.labels).toEqual([]); });
  it("reversed dates -> empty", () => { expect(calculateBurndown({ ...baseSprint, startDate: "2025-01-14T00:00:00Z", endDate: "2025-01-01T00:00:00Z" }, []).labels).toEqual([]); });
  it("14 days = 14 labels", () => { expect(calculateBurndown(baseSprint, []).labels.length).toBe(14); });
  it("remaining issues", () => {
    const issues: DashboardIssue[] = [
      { id: "1", externalId: "1", title: "T1", url: "", status: "done", priority: "medium", assignee: null, labels: [], platform: "github", repo: "org/repo", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-05T00:00:00Z", dependencies: [], sprint: "s1" },
      { id: "2", externalId: "2", title: "T2", url: "", status: "open", priority: "high", assignee: null, labels: [], platform: "github", repo: "org/repo", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", dependencies: [], sprint: "s1" },
      { id: "3", externalId: "3", title: "T3", url: "", status: "done", priority: "low", assignee: null, labels: [], platform: "github", repo: "org/repo", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-10T00:00:00Z", dependencies: [], sprint: "s1" },
    ];
    expect(calculateBurndown(baseSprint, issues).actual[0]).toBe(3);
  });
  it("only matching sprint", () => {
    const issues: DashboardIssue[] = [
      { id: "1", externalId: "1", title: "T1", url: "", status: "done", priority: "m", assignee: null, labels: [], platform: "github", repo: "", createdAt: "2025-01-01", updatedAt: "2025-01-05", dependencies: [], sprint: "s1" },
      { id: "2", externalId: "2", title: "T2", url: "", status: "open", priority: "m", assignee: null, labels: [], platform: "github", repo: "", createdAt: "2025-01-01", updatedAt: "2025-01-01", dependencies: [], sprint: "other" },
    ];
    expect(calculateBurndown(baseSprint, issues).actual[0]).toBe(1);
  });
  it("done before sprint = 0 remaining", () => {
    const issues: DashboardIssue[] = [
      { id: "1", externalId: "1", title: "T1", url: "", status: "done", priority: "m", assignee: null, labels: [], platform: "github", repo: "", createdAt: "2024-12-25", updatedAt: "2024-12-30", dependencies: [], sprint: "s1" },
    ];
    expect(calculateBurndown(baseSprint, issues).actual[0]).toBe(0);
  });
});

describe("repoDashboardRoutes", () => {
  let server: FastifyInstance;
  beforeEach(async () => {
    server = Fastify();
    await server.register(repoDashboardRoutes, { prefix: "/api/repo-dashboard" });
    await server.ready();
    vi.clearAllMocks();
    // Clear cache for all repos used in tests to prevent cross-test contamination
    invalidateIssueCache("github", "org/repo");
    invalidateIssueCache("gitlab", "org/repo");
    invalidateIssueCache("jira", "PROJ");
    invalidateIssueCache("work_items", "chat");
  });
  afterEach(async () => {
    await server.close();
    vi.restoreAllMocks();
  });

  describe("GET /repos (work items)", () => {
    it("should return work item repos grouped by source with open counts", async () => {
      vi.mocked(githubClient.listRepositories).mockRejectedValue(new Error("down"));
      vi.mocked(gitlabClient.getProjects).mockRejectedValue(new Error("down"));
      vi.mocked(jiraClient.getProjects).mockRejectedValue(new Error("down"));
      vi.mocked(workItemDatabase.listWorkItems)
        .mockReturnValueOnce({ total: 5, items: [] })
        .mockReturnValueOnce({
          total: 5,
          items: [
            { id: "1", title: "T1", status: "active", priority: "high", owner: "dev", sourceUrl: "", sourceExternalId: "e1", source: "chat", createdAt: "", updatedAt: "", description: "" },
            { id: "2", title: "T2", status: "done", priority: "medium", owner: "dev", sourceUrl: "", sourceExternalId: "e2", source: "chat", createdAt: "", updatedAt: "", description: "" },
            { id: "3", title: "T3", status: "proposed", priority: "low", owner: null, sourceUrl: "", sourceExternalId: "e3", source: "jira", createdAt: "", updatedAt: "", description: "" },
            { id: "4", title: "T4", status: "archived", priority: "medium", owner: null, sourceUrl: "", sourceExternalId: "e4", source: "jira", createdAt: "", updatedAt: "", description: "" },
            { id: "5", title: "T5", status: "blocked", priority: "critical", owner: null, sourceUrl: "", sourceExternalId: "e5", source: "github", createdAt: "", updatedAt: "", description: "" },
          ],
        });
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/repos" });
      expect(res.statusCode).toBe(200);
      const repos = res.json().repos;
      const chatRepo = repos.find((r: any) => r.repoKey === "chat");
      const jiraRepo = repos.find((r: any) => r.repoKey === "jira");
      const ghRepo = repos.find((r: any) => r.repoKey === "github");
      expect(chatRepo.issueCount).toBe(2);
      expect(chatRepo.openCount).toBe(1);
      expect(jiraRepo.issueCount).toBe(2);
      expect(jiraRepo.openCount).toBe(1);
      expect(ghRepo.issueCount).toBe(1);
      expect(ghRepo.openCount).toBe(1);
    });

    it("should handle work item DB error gracefully", async () => {
      vi.mocked(githubClient.listRepositories).mockRejectedValue(new Error("down"));
      vi.mocked(gitlabClient.getProjects).mockRejectedValue(new Error("down"));
      vi.mocked(jiraClient.getProjects).mockRejectedValue(new Error("down"));
      vi.mocked(workItemDatabase.listWorkItems).mockImplementation(() => { throw new Error("DB down"); });
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/repos" });
      expect(res.statusCode).toBe(200);
      expect(res.json().repos).toEqual([]);
    });

    it("should return empty repos when work items total is zero", async () => {
      vi.mocked(githubClient.listRepositories).mockRejectedValue(new Error("down"));
      vi.mocked(gitlabClient.getProjects).mockRejectedValue(new Error("down"));
      vi.mocked(jiraClient.getProjects).mockRejectedValue(new Error("down"));
      vi.mocked(workItemDatabase.listWorkItems).mockReturnValue({ total: 0, items: [] });
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/repos" });
      expect(res.statusCode).toBe(200);
      expect(res.json().repos).toEqual([]);
    });
  });

  describe("GET /repos", () => {
    it("should return empty when all providers fail", async () => {
      vi.mocked(githubClient.listRepositories).mockRejectedValue(new Error("down"));
      vi.mocked(gitlabClient.getProjects).mockRejectedValue(new Error("down"));
      vi.mocked(jiraClient.getProjects).mockRejectedValue(new Error("down"));
      vi.mocked(workItemDatabase.listWorkItems).mockReturnValue({ total: 0, items: [] });
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/repos" });
      expect(res.statusCode).toBe(200);
      expect(res.json().repos).toEqual([]);
    });
    it("should return GitHub repos", async () => {
      vi.mocked(githubClient.listRepositories).mockResolvedValue([{ owner: { login: "org" }, name: "r1", full_name: "org/r1" }]);
      vi.mocked(githubClient.listIssues).mockResolvedValue([{ number: 1, state: "open", title: "I1", pull_request: null, labels: [], assignee: null, html_url: "", created_at: "", updated_at: "", body: "" }]);
      vi.mocked(gitlabClient.getProjects).mockRejectedValue(new Error("no"));
      vi.mocked(jiraClient.getProjects).mockRejectedValue(new Error("no"));
      vi.mocked(workItemDatabase.listWorkItems).mockReturnValue({ total: 0, items: [] });
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/repos" });
      expect(res.statusCode).toBe(200);
      expect(res.json().repos.some((r: any) => r.platform === "github")).toBe(true);
    });
    it("should return GitLab repos", async () => {
      vi.mocked(githubClient.listRepositories).mockRejectedValue(new Error("no"));
      vi.mocked(gitlabClient.getProjects).mockResolvedValue([{ id: 1, path_with_namespace: "org/gl", name_with_namespace: "org/gl", name: "gl" }]);
      vi.mocked(gitlabClient.listIssues).mockResolvedValue([{ iid: 1, id: 101, state: "opened", title: "GL", labels: [], assignee: null, web_url: "", created_at: "", updated_at: "", description: "" }]);
      vi.mocked(jiraClient.getProjects).mockRejectedValue(new Error("no"));
      vi.mocked(workItemDatabase.listWorkItems).mockReturnValue({ total: 0, items: [] });
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/repos" });
      expect(res.statusCode).toBe(200);
      expect(res.json().repos.some((r: any) => r.platform === "gitlab")).toBe(true);
    });
    it("should return Jira repos", async () => {
      vi.mocked(githubClient.listRepositories).mockRejectedValue(new Error("no"));
      vi.mocked(gitlabClient.getProjects).mockRejectedValue(new Error("no"));
      vi.mocked(jiraClient.getProjects).mockResolvedValue([{ key: "PROJ", name: "My Project" }]);
      vi.mocked(jiraClient.searchIssues).mockResolvedValue([{ key: "PROJ-1", fields: { summary: "J", status: { name: "To Do" }, priority: { name: "Medium" }, assignee: null, labels: [], created: "", updated: "", description: "" } }]);
      vi.mocked(workItemDatabase.listWorkItems).mockReturnValue({ total: 0, items: [] });
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/repos" });
      expect(res.statusCode).toBe(200);
      expect(res.json().repos.some((r: any) => r.platform === "jira")).toBe(true);
    });
  });

  describe("GET /issues", () => {
    it("should return GitHub issues", async () => {
      vi.mocked(githubClient.listIssues).mockResolvedValue([{ number: 1, state: "open", title: "Bug fix", pull_request: null, labels: [{ name: "bug" }], assignee: { login: "dev" }, html_url: "https://github.com/org/repo/issues/1", created_at: "2025-01-01", updated_at: "2025-01-02", body: "", milestone: null }]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo" });
      expect(res.statusCode).toBe(200);
      expect(res.json().issues).toHaveLength(1);
      expect(res.json().issues[0].platform).toBe("github");
    });
    it("should return GitLab issues", async () => {
      vi.mocked(gitlabClient.listIssues).mockResolvedValue([{ iid: 42, id: 142, state: "opened", title: "GL issue", labels: [], assignee: { username: "dev" }, web_url: "", created_at: "", updated_at: "", description: "" }]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=gitlab&repo=org/repo" });
      expect(res.statusCode).toBe(200);
      expect(res.json().issues).toHaveLength(1);
    });
    it("should return Jira issues", async () => {
      vi.mocked(jiraClient.searchIssues).mockResolvedValue([{ key: "PROJ-1", fields: { summary: "Jira task", status: { name: "In Progress" }, priority: { name: "High" }, assignee: { displayName: "Dev" }, labels: [], created: "", updated: "", description: "" } }]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=jira&repo=PROJ" });
      expect(res.statusCode).toBe(200);
      expect(res.json().issues).toHaveLength(1);
    });
    it("should handle Jira content description", async () => {
      vi.mocked(jiraClient.searchIssues).mockResolvedValue([{ key: "PROJ-1", fields: { summary: "Task", status: { name: "Done" }, priority: { name: "M" }, assignee: null, labels: [], created: "", updated: "", description: { content: [{ content: [{ text: "blocked by #5" }] }] } } }]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=jira&repo=PROJ" });
      expect(res.json().issues[0].dependencies).toHaveLength(1);
    });
    it("should handle Jira null description", async () => {
      vi.mocked(jiraClient.searchIssues).mockResolvedValue([{ key: "PROJ-1", fields: { summary: "Task", status: { name: "Done" }, priority: { name: "M" }, assignee: null, labels: [], created: "", updated: "", description: null } }]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=jira&repo=PROJ" });
      expect(res.json().issues[0].dependencies).toHaveLength(0);
    });
    it("should return work items", async () => {
      vi.mocked(workItemDatabase.listWorkItems).mockReturnValue({ total: 1, items: [{ id: "wi-1", title: "W1", status: "active", priority: "high", owner: "dev", sourceUrl: "", sourceExternalId: "e1", source: "chat", createdAt: "", updatedAt: "", description: "" }] });
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=work_items&repo=chat" });
      expect(res.json().issues).toHaveLength(1);
    });
    it("should respect limit", async () => {
      const issues = Array.from({ length: 5 }, (_, i) => ({ number: i + 1, state: "open", title: "I" + i, pull_request: null, labels: [], assignee: null, html_url: "", created_at: "", updated_at: "", body: "", milestone: null }));
      vi.mocked(githubClient.listIssues).mockResolvedValue(issues);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo&limit=3" });
      expect(res.json().issues).toHaveLength(3);
      expect(res.json().total).toBe(5);
    });
    it("should handle errors", async () => {
      vi.mocked(githubClient.listIssues).mockRejectedValue(new Error("API error"));
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo" });
      expect(res.json().error).toBe("API error");
    });
  });

  describe("GET /dependencies", () => {
    it("should return dependency graph", async () => {
      vi.mocked(githubClient.listIssues).mockResolvedValue([
        { number: 1, state: "open", title: "I1", pull_request: null, labels: [{ name: "bug" }], assignee: null, html_url: "https://github.com/org/repo/issues/1", created_at: "", updated_at: "", body: "depends on #2", milestone: null },
        { number: 2, state: "closed", title: "I2", pull_request: null, labels: [], assignee: null, html_url: "https://github.com/org/repo/issues/2", created_at: "", updated_at: "", body: "", milestone: null },
      ]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/dependencies?platform=github&repo=org/repo" });
      expect(res.json().nodes).toHaveLength(2);
      expect(res.json().edges).toHaveLength(1);
    });
    it("should return empty for unknown platform", async () => {
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/dependencies?platform=unknown&repo=org/repo" });
      expect(res.json().nodes).toEqual([]);
    });
    it("should handle errors", async () => {
      vi.mocked(githubClient.listIssues).mockRejectedValue(new Error("err"));
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/dependencies?platform=github&repo=org/repo" });
      expect(res.json().nodes).toEqual([]);
    });
    it("should return GitLab dependency graph", async () => {
      vi.mocked(gitlabClient.listIssues).mockResolvedValue([
        { iid: 1, id: 101, state: "opened", title: "GL1", labels: [], assignee: null, web_url: "https://gitlab.com/org/repo/issues/1", created_at: "", updated_at: "", description: "requires #2" },
        { iid: 2, id: 102, state: "closed", title: "GL2", labels: [], assignee: null, web_url: "https://gitlab.com/org/repo/issues/2", created_at: "", updated_at: "", description: "" },
      ]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/dependencies?platform=gitlab&repo=org/repo" });
      expect(res.json().nodes).toHaveLength(2);
      expect(res.json().edges).toHaveLength(1);
    });
    it("should handle GitLab dependency errors", async () => {
      vi.mocked(gitlabClient.listIssues).mockRejectedValue(new Error("err"));
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/dependencies?platform=gitlab&repo=org/repo" });
      expect(res.json().nodes).toEqual([]);
      expect(res.json().edges).toEqual([]);
    });
    it("should return work_items dependency graph", async () => {
      vi.mocked(workItemDatabase.listWorkItems).mockReturnValue({
        total: 2,
        items: [
          { id: "wi-1", title: "Task 1", status: "active", priority: "high", owner: "dev", sourceUrl: "http://example.com/1", sourceExternalId: "e1", source: "chat", createdAt: "", updatedAt: "", description: "depends on #2" },
          { id: "wi-2", title: "Task 2", status: "done", priority: "medium", owner: null, sourceUrl: "http://example.com/2", sourceExternalId: "e2", source: "chat", createdAt: "", updatedAt: "", description: "" },
        ],
      });
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/dependencies?platform=work_items&repo=chat" });
      expect(res.json().nodes).toHaveLength(2);
    });
    it("should handle work_items dependency errors", async () => {
      vi.mocked(workItemDatabase.listWorkItems).mockImplementation(() => { throw new Error("DB error"); });
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/dependencies?platform=work_items&repo=chat" });
      expect(res.json().nodes).toEqual([]);
      expect(res.json().edges).toEqual([]);
    });
    it("should return Jira dependency graph", async () => {
      vi.mocked(jiraClient.searchIssues).mockResolvedValue([{ key: "PROJ-1", fields: { summary: "J1", status: { name: "In Progress" }, priority: { name: "High" }, assignee: null, labels: [], created: "", updated: "", description: "blocked by #2" } }]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/dependencies?platform=jira&repo=PROJ" });
      expect(res.json().nodes).toHaveLength(1);
    });
    it("should handle Jira dependency errors", async () => {
      vi.mocked(jiraClient.searchIssues).mockRejectedValue(new Error("err"));
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/dependencies?platform=jira&repo=PROJ" });
      expect(res.json().nodes).toEqual([]);
      expect(res.json().edges).toEqual([]);
    });
  });

  describe("GET /sprints", () => {
    it("should return error when params missing", async () => {
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/sprints" });
      expect(res.json().error).toBe("platform and repo are required");
    });
    it("should return empty for unsupported platform", async () => {
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/sprints?platform=gitlab&repo=org/repo" });
      expect(res.json().sprints).toEqual([]);
    });
    it("should return GitHub sprints", async () => {
      vi.mocked(githubClient.listMilestones).mockResolvedValue([{ number: 1, title: "Sprint 1", state: "open", created_at: "2025-01-01T00:00:00Z", due_on: "2025-01-14T00:00:00Z" }]);
      vi.mocked(githubClient.listIssues).mockResolvedValue([
        { number: 10, state: "open", title: "I10", pull_request: null, labels: [], assignee: null, html_url: "", created_at: "", updated_at: "", body: "", milestone: { number: 1 } },
        { number: 11, state: "closed", title: "I11", pull_request: null, labels: [], assignee: null, html_url: "", created_at: "", updated_at: "", body: "", milestone: { number: 1 } },
      ]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/sprints?platform=github&repo=org/repo" });
      expect(res.json().sprints).toHaveLength(1);
      expect(res.json().sprints[0].id).toBe("gh-milestone-1");
      expect(res.json().sprints[0].totalPoints).toBe(2);
      expect(res.json().sprints[0].completedPoints).toBe(1);
    });
    it("should assign sprint from sprint/ label", async () => {
      vi.mocked(githubClient.listMilestones).mockResolvedValue([{ number: 1, title: "S1", state: "open", created_at: "2025-01-01", due_on: "2025-01-14" }]);
      vi.mocked(githubClient.listIssues).mockResolvedValue([{ number: 10, state: "open", title: "I", pull_request: null, labels: [{ name: "sprint/2025-01" }], assignee: null, html_url: "", created_at: "", updated_at: "", body: "", milestone: null }]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/sprints?platform=github&repo=org/repo" });
      expect(res.json().issues[0].sprint).toBe("gh-label-sprint/2025-01");
    });
    it("should assign sprint from iteration/ label", async () => {
      vi.mocked(githubClient.listMilestones).mockResolvedValue([{ number: 1, title: "S1", state: "open", created_at: "2025-01-01", due_on: "2025-01-14" }]);
      vi.mocked(githubClient.listIssues).mockResolvedValue([{ number: 11, state: "open", title: "I", pull_request: null, labels: [{ name: "iteration/4" }], assignee: null, html_url: "", created_at: "", updated_at: "", body: "", milestone: null }]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/sprints?platform=github&repo=org/repo" });
      expect(res.json().issues[0].sprint).toBe("gh-label-iteration/4");
    });
    it("should set empty sprint with no milestone or label", async () => {
      vi.mocked(githubClient.listMilestones).mockResolvedValue([{ number: 1, title: "S1", state: "open", created_at: "2025-01-01", due_on: "2025-01-14" }]);
      vi.mocked(githubClient.listIssues).mockResolvedValue([{ number: 12, state: "open", title: "I", pull_request: null, labels: [{ name: "bug" }], assignee: null, html_url: "", created_at: "", updated_at: "", body: "", milestone: null }]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/sprints?platform=github&repo=org/repo" });
      expect(res.json().issues[0].sprint).toBe("");
    });
    it("should return Jira sprints", async () => {
      vi.mocked(jiraClient.getSprints).mockResolvedValue([{ id: 5, name: "JS1", state: "active", startDate: "2025-01-01", endDate: "2025-01-14" }]);
      vi.mocked(jiraClient.getSprintIssues).mockResolvedValue([{ key: "PROJ-1", fields: { summary: "T1", status: { name: "Done" }, priority: { name: "M" }, assignee: null, labels: [], created: "", updated: "", description: "" } }]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/sprints?platform=jira&repo=PROJ" });
      expect(res.json().sprints[0].id).toBe("jira-sprint-5");
    });
    it("should handle Jira sprint content description", async () => {
      vi.mocked(jiraClient.getSprints).mockResolvedValue([{ id: 5, name: "S5", state: "active", startDate: "2025-01-01", endDate: "2025-01-14" }]);
      vi.mocked(jiraClient.getSprintIssues).mockResolvedValue([{ key: "P-1", fields: { summary: "T", status: { name: "Done" }, priority: { name: "M" }, assignee: null, labels: [], created: "", updated: "", description: { content: [{ content: [{ text: "requires #10" }] }] } } }]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/sprints?platform=jira&repo=PROJ" });
      expect(res.json().issues[0].dependencies).toHaveLength(1);
    });
    it("should handle GitHub sprint errors", async () => {
      vi.mocked(githubClient.listMilestones).mockRejectedValue(new Error("err"));
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/sprints?platform=github&repo=org/repo" });
      expect(res.json().sprints).toEqual([]);
    });
    it("should handle Jira sprint errors", async () => {
      vi.mocked(jiraClient.getSprints).mockRejectedValue(new Error("err"));
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/sprints?platform=jira&repo=PROJ" });
      expect(res.json().sprints).toEqual([]);
    });
  });

  describe("GET /burndown", () => {
    it("should return error when params missing", async () => {
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/burndown?platform=github&repo=org/repo" });
      expect(res.json().error).toBe("platform, repo, and sprintId are required");
    });
    it("should return empty for unsupported platform", async () => {
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/burndown?platform=gitlab&repo=org/repo&sprintId=1" });
      expect(res.json().labels).toEqual([]);
    });
    it("should return burndown data", async () => {
      vi.mocked(githubClient.listMilestones).mockResolvedValue([{ number: 1, title: "S1", state: "open", created_at: "2025-01-01T00:00:00Z", due_on: "2025-01-14T00:00:00Z" }]);
      vi.mocked(githubClient.listIssues).mockResolvedValue([
        { number: 10, state: "open", title: "I10", pull_request: null, labels: [], assignee: null, html_url: "", created_at: "2025-01-01", updated_at: "2025-01-05", body: "", milestone: { number: 1 } },
        { number: 11, state: "closed", title: "I11", pull_request: null, labels: [], assignee: null, html_url: "", created_at: "2025-01-01", updated_at: "2025-01-10", body: "", milestone: { number: 1 } },
      ]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/burndown?platform=github&repo=org/repo&sprintId=gh-milestone-1" });
      expect(res.json().labels).toHaveLength(14);
      expect(res.json().sprint).toBeDefined();
    });
    it("should return error for missing sprint", async () => {
      vi.mocked(githubClient.listMilestones).mockResolvedValue([{ number: 1, title: "S1", state: "open", created_at: "2025-01-01", due_on: "2025-01-14" }]);
      vi.mocked(githubClient.listIssues).mockResolvedValue([]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/burndown?platform=github&repo=org/repo&sprintId=gh-milestone-99" });
      expect(res.json().error).toBe("Sprint not found");
    });
    it("should return Jira burndown", async () => {
      vi.mocked(jiraClient.getSprints).mockResolvedValue([{ id: 5, name: "S5", state: "active", startDate: "2025-01-01", endDate: "2025-01-14" }]);
      vi.mocked(jiraClient.getSprintIssues).mockResolvedValue([{ key: "P-1", fields: { summary: "T", status: { name: "Done" }, priority: { name: "M" }, assignee: null, labels: [], created: "", updated: "", description: "" } }]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/burndown?platform=jira&repo=PROJ&sprintId=jira-sprint-5" });
      expect(res.json().labels.length).toBeGreaterThan(0);
    });
    it("should handle sprint fetch failure", async () => {
      vi.mocked(githubClient.listMilestones).mockRejectedValue(new Error("err"));
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/burndown?platform=github&repo=org/repo&sprintId=gh-milestone-1" });
      expect(res.json().error).toBe("Sprint not found");
    });
    it("should handle Jira burndown sprint fetch failure", async () => {
      vi.mocked(jiraClient.getSprints).mockRejectedValue(new Error("jira down"));
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/burndown?platform=jira&repo=PROJ&sprintId=jira-sprint-5" });
      expect(res.json().error).toBe("Sprint not found");
    });
  });

  describe("issue cache", () => {
    const mockIssue = { number: 1, state: "open", title: "Cached Issue", pull_request: null, labels: [], assignee: null, html_url: "https://github.com/org/repo/issues/1", created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-02T00:00:00Z", body: "" };

    it("should use cached data on second request without refetching", async () => {
      vi.mocked(githubClient.listIssues).mockResolvedValue([mockIssue]);

      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo" });
      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo" });

      expect(githubClient.listIssues).toHaveBeenCalledTimes(1);
    });

    it("should refetch after cache TTL expires", async () => {
      vi.mocked(githubClient.listIssues).mockResolvedValue([mockIssue]);

      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo" });
      expect(githubClient.listIssues).toHaveBeenCalledTimes(1);

      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60 * 1000 + 1);

      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo" });
      expect(githubClient.listIssues).toHaveBeenCalledTimes(2);

      dateSpy.mockRestore();
    });

    it("should filter issues by since parameter on fresh fetch", async () => {
      vi.mocked(githubClient.listIssues).mockResolvedValue([
        { ...mockIssue, number: 1, title: "Old Issue", updated_at: "2025-01-01T00:00:00Z" },
        { ...mockIssue, number: 2, title: "New Issue", updated_at: "2025-02-01T00:00:00Z" },
      ]);

      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo&since=2025-01-15T00:00:00Z" });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.issues).toHaveLength(1);
      expect(data.issues[0].title).toBe("New Issue");
    });

    it("should filter cached issues by since without refetching", async () => {
      vi.mocked(githubClient.listIssues).mockResolvedValue([
        { ...mockIssue, number: 1, title: "Old Issue", updated_at: "2025-01-01T00:00:00Z" },
        { ...mockIssue, number: 2, title: "New Issue", updated_at: "2025-02-01T00:00:00Z" },
      ]);

      // Populate cache
      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo" });
      // Filter cached data with since
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo&since=2025-01-15T00:00:00Z" });

      expect(githubClient.listIssues).toHaveBeenCalledTimes(1);
      expect(res.json().issues).toHaveLength(1);
      expect(res.json().issues[0].title).toBe("New Issue");
    });

    it("should refetch after invalidateIssueCache is called", async () => {
      vi.mocked(githubClient.listIssues).mockResolvedValue([mockIssue]);

      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo" });
      expect(githubClient.listIssues).toHaveBeenCalledTimes(1);

      invalidateIssueCache("github", "org/repo");

      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo" });
      expect(githubClient.listIssues).toHaveBeenCalledTimes(2);
    });

    it("should cache independently per platform and repo", async () => {
      vi.mocked(githubClient.listIssues).mockResolvedValue([mockIssue]);
      vi.mocked(gitlabClient.listIssues).mockResolvedValue([{ iid: 1, id: 101, state: "opened", title: "GL", labels: [], assignee: null, web_url: "", created_at: "", updated_at: "", description: "" }]);

      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo" });
      invalidateIssueCache("gitlab", "org/repo");
      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=gitlab&repo=org/repo" });

      expect(githubClient.listIssues).toHaveBeenCalledTimes(1);
      expect(gitlabClient.listIssues).toHaveBeenCalledTimes(1);

      // GitHub cache still valid
      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo" });
      expect(githubClient.listIssues).toHaveBeenCalledTimes(1);
    });
  });
});
