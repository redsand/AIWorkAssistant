/**
 * Unit tests for repo-dashboard sprint & burndown endpoints.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import {
  parseDependencies,
  constructExternalUrl,
  normalizeStatus,
  normalizePriority,
  calculateBurndown,
  repoDashboardRoutes,
  invalidateIssueCache,
} from "../../../src/routes/repo-dashboard";
import type {
  DependencyRef,
  DashboardSprint,
  DashboardIssue,
} from "../../../src/routes/repo-dashboard";

vi.mock("../../../src/integrations/github/github-client", () => ({
  githubClient: { listRepositories: vi.fn(), listIssues: vi.fn(), listMilestones: vi.fn(), updateIssue: vi.fn() },
}));
vi.mock("../../../src/integrations/gitlab/gitlab-client", () => ({
  gitlabClient: { getProjects: vi.fn(), listIssues: vi.fn(), editIssue: vi.fn() },
}));
vi.mock("../../../src/integrations/jira/jira-client", () => ({
  jiraClient: { getProjects: vi.fn(), searchIssues: vi.fn(), getSprints: vi.fn(), getSprintIssues: vi.fn(), transitionIssue: vi.fn(), getTransitions: vi.fn() },
}));
vi.mock("../../../src/work-items/database", () => ({
  workItemDatabase: { listWorkItems: vi.fn(), updateWorkItem: vi.fn() },
}));
vi.mock("../../../src/config/env", () => ({
  env: { GITHUB_TOKEN: "gh-test-token", GITHUB_DEFAULT_OWNER: "test-org", GITHUB_DEFAULT_REPO: "test-repo", GITLAB_TOKEN: "gl-test-token", GITLAB_BASE_URL: "https://gitlab.com", GITLAB_DEFAULT_PROJECT: "", JIRA_BASE_URL: "https://test.atlassian.net", JIRA_API_TOKEN: "jira-test-token" },
}));

import { githubClient } from "../../../src/integrations/github/github-client";
import { gitlabClient } from "../../../src/integrations/gitlab/gitlab-client";
import { jiraClient } from "../../../src/integrations/jira/jira-client";
import { workItemDatabase } from "../../../src/work-items/database";

describe("parseDependencies", () => {
  it("should return empty array for empty body", () => { expect(parseDependencies("")).toEqual([]); });
  it("should return empty array for null", () => { expect(parseDependencies(null as any)).toEqual([]); });
  it("should parse depends on", () => { expect(parseDependencies("depends on #123")).toEqual([{ id: "123", label: "depends on #123", external: false }]); });
  it("should parse blocked by", () => { expect(parseDependencies("blocked by #456")).toEqual([{ id: "456", label: "blocked by #456", external: false }]); });
  it("should parse requires", () => { expect(parseDependencies("Requires #789")).toEqual([{ id: "789", label: "Requires #789", external: false }]); });
  it("should parse prerequisite", () => { expect(parseDependencies("prerequisite: #321")).toEqual([{ id: "321", label: "prerequisite: #321", external: false }]); });
  it("should deduplicate same id", () => { expect(parseDependencies("depends on #100 and depends on #100")).toEqual([{ id: "100", label: "depends on #100", external: false }]); });
  it("should parse multiple deps", () => { const r = parseDependencies("depends on #1 and blocked by #2"); expect(r).toHaveLength(2); });
  it("should be case insensitive", () => { expect(parseDependencies("DEPENDS ON #5")).toEqual([{ id: "5", label: "DEPENDS ON #5", external: false }]); });
  it("should return empty for no match", () => { expect(parseDependencies("Just a task")).toEqual([]); });

  // Cross-platform Jira references
  it("should parse JIRA: prefix", () => {
    const r = parseDependencies("depends on JIRA:PROJ-42");
    expect(r).toEqual([{ id: "PROJ-42", label: "depends on JIRA:PROJ-42", platform: "jira", external: true }]);
  });
  it("should parse Jira: prefix (lowercase)", () => {
    const r = parseDependencies("blocked by Jira:DEV-7");
    expect(r).toEqual([{ id: "DEV-7", label: "blocked by Jira:DEV-7", platform: "jira", external: true }]);
  });
  it("should parse JIRA: without keyword prefix", () => {
    const r = parseDependencies("requires JIRA:ABC-123");
    expect(r).toEqual([{ id: "ABC-123", label: "requires JIRA:ABC-123", platform: "jira", external: true }]);
  });

  it("should parse bare Jira keys as internal deps in Jira context", () => {
    const r = parseDependencies("Depends on: SIEM-15, SIEM-16, SIEM-17", { platform: "jira", repo: "SIEM" });
    expect(r).toEqual([
      { id: "SIEM-15", label: "Depends on: SIEM-15, SIEM-16, SIEM-17", platform: undefined, external: false },
      { id: "SIEM-16", label: "Depends on: SIEM-15, SIEM-16, SIEM-17", platform: undefined, external: false },
      { id: "SIEM-17", label: "Depends on: SIEM-15, SIEM-16, SIEM-17", platform: undefined, external: false },
    ]);
  });

  it("should parse do-not-start Jira dependency comments", () => {
    const r = parseDependencies("Do not start this ticket until SIEM-46 is merged.", { platform: "jira", repo: "SIEM" });
    expect(r).toEqual([{ id: "SIEM-46", label: "Do not start this ticket until SIEM-46", platform: undefined, external: false }]);
  });

  it("should keep bare Jira keys from other projects external in Jira context", () => {
    const r = parseDependencies("Depends on: OTHER-1", { platform: "jira", repo: "SIEM" });
    expect(r).toEqual([{ id: "OTHER-1", label: "Depends on: OTHER-1", platform: "jira", external: true }]);
  });

  // Cross-platform GitHub references
  it("should parse GH: with owner/repo", () => {
    const r = parseDependencies("depends on GH:redsand/OtherRepo#5");
    expect(r).toEqual([{ id: "5", label: "depends on GH:redsand/OtherRepo#5", platform: "github", repo: "redsand/OtherRepo", external: true }]);
  });
  it("should parse GitHub: with owner/repo", () => {
    const r = parseDependencies("blocked by GitHub:org/foo#42");
    expect(r).toEqual([{ id: "42", label: "blocked by GitHub:org/foo#42", platform: "github", repo: "org/foo", external: true }]);
  });

  // Cross-platform GitLab references
  it("should parse GL: with project", () => {
    const r = parseDependencies("depends on GL:mygroup/myproject#15");
    expect(r).toEqual([{ id: "15", label: "depends on GL:mygroup/myproject#15", platform: "gitlab", repo: "mygroup/myproject", external: true }]);
  });
  it("should parse GitLab: with project", () => {
    const r = parseDependencies("blocked by GitLab:anotherproject#99");
    expect(r).toEqual([{ id: "99", label: "blocked by GitLab:anotherproject#99", platform: "gitlab", repo: "anotherproject", external: true }]);
  });

  // Mixed same-repo and cross-platform
  it("should parse mixed same-repo and cross-platform deps", () => {
    const r = parseDependencies("depends on #1 and requires JIRA:PROJ-5 and blocked by GH:org/r#10");
    expect(r).toHaveLength(3);
    const internal = r.find(d => !d.external);
    const jira = r.find(d => d.platform === "jira");
    const github = r.find(d => d.platform === "github");
    expect(internal?.id).toBe("1");
    expect(internal?.external).toBe(false);
    expect(jira?.id).toBe("PROJ-5");
    expect(jira?.external).toBe(true);
    expect(github?.id).toBe("10");
    expect(github?.repo).toBe("org/r");
    expect(github?.external).toBe(true);
  });

  // Deduplication across cross-platform refs
  it("should deduplicate cross-platform references with same id", () => {
    const r = parseDependencies("depends on JIRA:PROJ-1 and blocked by JIRA:PROJ-1");
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("PROJ-1");
    expect(r[0].external).toBe(true);
  });
});

describe("normalizeStatus", () => {
  it("null -> unknown", () => { expect(normalizeStatus(null, "github")).toBe("unknown"); });
  it("undefined -> unknown", () => { expect(normalizeStatus(undefined, "github")).toBe("unknown"); });
  it("empty -> unknown", () => { expect(normalizeStatus("", "github")).toBe("unknown"); });
  it("github open", () => { expect(normalizeStatus("open", "github")).toBe("open"); });
  it("github open + In Progress label -> in_progress", () => { expect(normalizeStatus("open", "github", ["In Progress"])).toBe("in_progress"); });
  it("github open + in progress label (case insensitive)", () => { expect(normalizeStatus("open", "github", ["bug", "in progress"])).toBe("in_progress"); });
  it("github closed + In Progress label -> done", () => { expect(normalizeStatus("closed", "github", ["In Progress"])).toBe("done"); });
  it("github closed -> done", () => { expect(normalizeStatus("closed", "github")).toBe("done"); });
  it("github unknown", () => { expect(normalizeStatus("pending", "github")).toBe("unknown"); });
  it("gitlab opened -> open", () => { expect(normalizeStatus("opened", "gitlab")).toBe("open"); });
  it("gitlab opened + In Progress label -> in_progress", () => { expect(normalizeStatus("opened", "gitlab", ["In Progress"])).toBe("in_progress"); });
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

    // Cross-platform dependency tests with includeExternal
    it("should include ghost nodes for cross-platform Jira deps when includeExternal=true", async () => {
      vi.mocked(githubClient.listIssues).mockResolvedValue([
        { number: 1, state: "open", title: "I1", pull_request: null, labels: [], assignee: null, html_url: "https://github.com/org/repo/issues/1", created_at: "", updated_at: "", body: "depends on JIRA:PROJ-42", milestone: null },
      ]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/dependencies?platform=github&repo=org/repo&includeExternal=true" });
      const json = res.json();
      expect(json.nodes).toHaveLength(2);
      const ghostNode = json.nodes.find((n: any) => n.id === "PROJ-42");
      expect(ghostNode).toBeDefined();
      expect(ghostNode.status).toBe("unknown");
      expect(ghostNode.priority).toBe("unknown");
      expect(ghostNode.url).toBe("https://test.atlassian.net/browse/PROJ-42");
      expect(json.edges).toHaveLength(1);
      const extEdge = json.edges[0];
      expect(extEdge.from).toBe("1");
      expect(extEdge.to).toBe("PROJ-42");
      expect(extEdge.dashes).toBe(true);
      expect(extEdge.color.color).toBe("#f59e0b");
    });

    it("should include ghost nodes for cross-platform GH deps when includeExternal=true", async () => {
      vi.mocked(jiraClient.searchIssues).mockResolvedValue([
        { key: "PROJ-1", fields: { summary: "J1", status: { name: "To Do" }, priority: { name: "High" }, assignee: null, labels: [], created: "", updated: "", description: "blocked by GH:other/repo#5" } },
      ]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/dependencies?platform=jira&repo=PROJ&includeExternal=true" });
      const json = res.json();
      expect(json.nodes).toHaveLength(2);
      const ghostNode = json.nodes.find((n: any) => n.id === "5");
      expect(ghostNode).toBeDefined();
      expect(ghostNode.status).toBe("unknown");
      expect(ghostNode.priority).toBe("unknown");
      expect(ghostNode.url).toBe("https://github.com/other/repo/issues/5");
      const extEdge = json.edges[0];
      expect(extEdge.dashes).toBe(true);
    });

    it("should include ghost nodes for cross-platform GL deps when includeExternal=true", async () => {
      vi.mocked(githubClient.listIssues).mockResolvedValue([
        { number: 1, state: "open", title: "I1", pull_request: null, labels: [], assignee: null, html_url: "https://github.com/org/repo/issues/1", created_at: "", updated_at: "", body: "requires GitLab:myproj#99", milestone: null },
      ]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/dependencies?platform=github&repo=org/repo&includeExternal=true" });
      const json = res.json();
      const ghostNode = json.nodes.find((n: any) => n.id === "99");
      expect(ghostNode).toBeDefined();
      expect(ghostNode.url).toBe("https://gitlab.com/myproj/-/issues/99");
    });

    it("should deduplicate ghost nodes for same external id", async () => {
      vi.mocked(githubClient.listIssues).mockResolvedValue([
        { number: 1, state: "open", title: "I1", pull_request: null, labels: [], assignee: null, html_url: "https://github.com/org/repo/issues/1", created_at: "", updated_at: "", body: "depends on JIRA:PROJ-42", milestone: null },
        { number: 2, state: "open", title: "I2", pull_request: null, labels: [], assignee: null, html_url: "https://github.com/org/repo/issues/2", created_at: "", updated_at: "", body: "blocked by JIRA:PROJ-42", milestone: null },
      ]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/dependencies?platform=github&repo=org/repo&includeExternal=true" });
      const json = res.json();
      const ghostNodes = json.nodes.filter((n: any) => n.id === "PROJ-42");
      expect(ghostNodes).toHaveLength(1);
      // Both issues should have edges to the same ghost node
      const extEdges = json.edges.filter((e: any) => e.to === "PROJ-42");
      expect(extEdges).toHaveLength(2);
    });

    it("should NOT include external nodes when includeExternal is false (default)", async () => {
      vi.mocked(githubClient.listIssues).mockResolvedValue([
        { number: 1, state: "open", title: "I1", pull_request: null, labels: [], assignee: null, html_url: "https://github.com/org/repo/issues/1", created_at: "", updated_at: "", body: "depends on JIRA:PROJ-42", milestone: null },
      ]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/dependencies?platform=github&repo=org/repo" });
      const json = res.json();
      // Should still have the source node but no ghost node and no edges
      expect(json.nodes).toHaveLength(1);
      expect(json.edges).toHaveLength(0);
    });

    it("should handle GH: with owner/repo in GitLab issue context with includeExternal", async () => {
      vi.mocked(gitlabClient.listIssues).mockResolvedValue([
        { iid: 1, id: 101, state: "opened", title: "GL1", labels: [], assignee: null, web_url: "https://gitlab.com/org/repo/-/issues/1", created_at: "", updated_at: "", description: "depends on GitHub:cross/other#7" },
      ]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/dependencies?platform=gitlab&repo=org/repo&includeExternal=true" });
      const json = res.json();
      const ghost = json.nodes.find((n: any) => n.id === "7");
      expect(ghost).toBeDefined();
      expect(ghost.url).toBe("https://github.com/cross/other/issues/7");
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

    it("should evict LRU entry when MAX_CACHE_SIZE is reached", async () => {
      // Fill the cache to MAX_CACHE_SIZE (100) using work_items repos
      vi.mocked(workItemDatabase.listWorkItems).mockReturnValue({ total: 1, items: [{ id: "wi-1", title: "T", status: "active", priority: "high", owner: null, sourceUrl: "", sourceExternalId: "e1", source: "chat", createdAt: "", updatedAt: "", description: "" }] });

      // Access "chat" first so it becomes the oldest with lowest lastAccessed
      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=work_items&repo=chat" });
      expect(workItemDatabase.listWorkItems).toHaveBeenCalledTimes(1);

      // Fill remaining 99 slots with distinct repos by force-refreshing (using github) after first cache hit
      vi.mocked(githubClient.listIssues).mockResolvedValue([mockIssue]);
      for (let i = 1; i <= 99; i++) {
        await server.inject({ method: "GET", url: `/api/repo-dashboard/issues?platform=github&repo=org/repo${i}` });
      }
      // Cache is now full (100 entries). Re-access "chat" to update its lastAccessed
      // so it is NOT the LRU target any more. Instead repo1 (org/repo1) becomes LRU.
      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=work_items&repo=chat" });
      expect(workItemDatabase.listWorkItems).toHaveBeenCalledTimes(1); // still cached

      // Add one more entry — should evict org/repo1 (the least recently accessed github repo)
      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo101" });

      // org/repo1 was evicted; fetching it again should call the API
      vi.clearAllMocks();
      vi.mocked(githubClient.listIssues).mockResolvedValue([mockIssue]);
      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo1" });
      expect(githubClient.listIssues).toHaveBeenCalledTimes(1);
    });

    it("should reject malformed since parameter", async () => {
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo&since=not-a-date" });
      expect(res.statusCode).toBe(200);
      expect(res.json().error).toMatch(/Invalid since parameter/);
    });

    it("should reject SQL-injection-style since parameter", async () => {
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo&since=" + encodeURIComponent("'; DROP TABLE issues; --") });
      expect(res.statusCode).toBe(200);
      expect(res.json().error).toMatch(/Invalid since parameter/);
    });

    it("should treat empty since as no filter", async () => {
      vi.mocked(githubClient.listIssues).mockResolvedValue([mockIssue]);
      const res = await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo&since=" });
      expect(res.statusCode).toBe(200);
      expect(res.json().issues).toHaveLength(1);
      expect(res.json().error).toBeUndefined();
    });

    it("should bypass cache on force-refresh (_t param)", async () => {
      vi.mocked(githubClient.listIssues).mockResolvedValue([mockIssue]);

      // First fetch populates cache
      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo" });
      expect(githubClient.listIssues).toHaveBeenCalledTimes(1);

      // Force-refresh within TTL window should bypass cache
      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo&_t=1234567890" });
      expect(githubClient.listIssues).toHaveBeenCalledTimes(2);
    });
  });

  describe("POST /transition", () => {
    it("should reject missing fields", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/api/repo-dashboard/transition",
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(false);
      expect(res.json().error).toBeDefined();
    });

    it("should reject invalid status", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/api/repo-dashboard/transition",
        payload: { issueId: "1", platform: "github", repo: "org/repo", status: "invalid_status" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(false);
      expect(res.json().error).toMatch(/invalid.*status/i);
    });

    it("should reject unsupported platform", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/api/repo-dashboard/transition",
        payload: { issueId: "1", platform: "slack", repo: "org/repo", status: "done" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(false);
      expect(res.json().error).toMatch(/unsupported.*platform/i);
    });

    it("should transition GitHub issue to done (closed)", async () => {
      vi.mocked(githubClient.updateIssue).mockResolvedValue({});
      const res = await server.inject({
        method: "POST",
        url: "/api/repo-dashboard/transition",
        payload: { issueId: "42", platform: "github", repo: "org/repo", status: "done" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(githubClient.updateIssue).toHaveBeenCalledWith(42, { state: "closed" }, "org", "repo");
    });

    it("should transition GitHub issue to open", async () => {
      vi.mocked(githubClient.updateIssue).mockResolvedValue({});
      const res = await server.inject({
        method: "POST",
        url: "/api/repo-dashboard/transition",
        payload: { issueId: "42", platform: "github", repo: "org/repo", status: "open" },
      });
      expect(res.json().success).toBe(true);
      expect(githubClient.updateIssue).toHaveBeenCalledWith(42, { state: "open" }, "org", "repo");
    });

    it("should reject GitHub in_progress/blocked as unsupported", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/api/repo-dashboard/transition",
        payload: { issueId: "42", platform: "github", repo: "org/repo", status: "in_progress" },
      });
      expect(res.json().success).toBe(false);
      expect(res.json().error).toMatch(/cannot.*transition/i);
    });

    it("should transition GitLab issue to done (close)", async () => {
      vi.mocked(gitlabClient.editIssue).mockResolvedValue({});
      const res = await server.inject({
        method: "POST",
        url: "/api/repo-dashboard/transition",
        payload: { issueId: "15", platform: "gitlab", repo: "myproject", status: "done" },
      });
      expect(res.json().success).toBe(true);
      expect(gitlabClient.editIssue).toHaveBeenCalledWith("myproject", 15, { stateEvent: "close" });
    });

    it("should transition GitLab issue to open (reopen)", async () => {
      vi.mocked(gitlabClient.editIssue).mockResolvedValue({});
      const res = await server.inject({
        method: "POST",
        url: "/api/repo-dashboard/transition",
        payload: { issueId: "15", platform: "gitlab", repo: "myproject", status: "open" },
      });
      expect(res.json().success).toBe(true);
      expect(gitlabClient.editIssue).toHaveBeenCalledWith("myproject", 15, { stateEvent: "reopen" });
    });

    it("should transition Jira issue via getTransitions + transitionIssue", async () => {
      vi.mocked(jiraClient.getTransitions).mockResolvedValue([
        { id: "31", name: "Start Progress", to: { name: "In Progress", id: "3" } },
      ]);
      vi.mocked(jiraClient.transitionIssue).mockResolvedValue(undefined);
      const res = await server.inject({
        method: "POST",
        url: "/api/repo-dashboard/transition",
        payload: { issueId: "PROJ-42", platform: "jira", repo: "PROJ", status: "in_progress" },
      });
      expect(res.json().success).toBe(true);
      expect(jiraClient.getTransitions).toHaveBeenCalledWith("PROJ-42");
      expect(jiraClient.transitionIssue).toHaveBeenCalledWith("PROJ-42", "31", expect.any(String));
    });

    it("should reject Jira transition when no matching transition found", async () => {
      vi.mocked(jiraClient.getTransitions).mockResolvedValue([
        { id: "31", name: "Start Progress", to: { name: "In Progress", id: "3" } },
      ]);
      const res = await server.inject({
        method: "POST",
        url: "/api/repo-dashboard/transition",
        payload: { issueId: "PROJ-42", platform: "jira", repo: "PROJ", status: "done" },
      });
      expect(res.json().success).toBe(false);
      expect(res.json().error).toMatch(/no.*transition/i);
    });

    it("should transition work_items", async () => {
      vi.mocked(workItemDatabase.updateWorkItem).mockReturnValue({
        id: "wi-1", title: "T", status: "active", priority: "high", owner: null,
        sourceUrl: "", sourceExternalId: "e1", source: "chat",
        createdAt: "", updatedAt: "", description: "",
      });
      const res = await server.inject({
        method: "POST",
        url: "/api/repo-dashboard/transition",
        payload: { issueId: "wi-1", platform: "work_items", repo: "chat", status: "in_progress" },
      });
      expect(res.json().success).toBe(true);
      expect(workItemDatabase.updateWorkItem).toHaveBeenCalledWith("wi-1", { status: "active" });
    });

    it("should invalidate cache after successful transition", async () => {
      const transitionMockIssue = { number: 1, state: "open", title: "Cached Issue", pull_request: null, labels: [], assignee: null, html_url: "https://github.com/org/repo/issues/1", created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-02T00:00:00Z", body: "" };
      vi.mocked(githubClient.listIssues).mockResolvedValue([transitionMockIssue]);
      vi.mocked(githubClient.updateIssue).mockResolvedValue({});

      // Populate cache
      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo" });
      expect(githubClient.listIssues).toHaveBeenCalledTimes(1);

      // Transition should invalidate cache
      await server.inject({
        method: "POST",
        url: "/api/repo-dashboard/transition",
        payload: { issueId: "1", platform: "github", repo: "org/repo", status: "done" },
      });

      // Next fetch should be a cache miss (listIssues called again)
      await server.inject({ method: "GET", url: "/api/repo-dashboard/issues?platform=github&repo=org/repo" });
      expect(githubClient.listIssues).toHaveBeenCalledTimes(2);
    });

    it("should handle GitHub transition errors", async () => {
      vi.mocked(githubClient.updateIssue).mockRejectedValue(new Error("API error"));
      const res = await server.inject({
        method: "POST",
        url: "/api/repo-dashboard/transition",
        payload: { issueId: "1", platform: "github", repo: "org/repo", status: "done" },
      });
      expect(res.json().success).toBe(false);
      expect(res.json().error).toBe("API error");
    });

    it("should handle Jira getTransitions errors", async () => {
      vi.mocked(jiraClient.getTransitions).mockRejectedValue(new Error("Jira down"));
      const res = await server.inject({
        method: "POST",
        url: "/api/repo-dashboard/transition",
        payload: { issueId: "PROJ-1", platform: "jira", repo: "PROJ", status: "in_progress" },
      });
      expect(res.json().success).toBe(false);
      expect(res.json().error).toBe("Jira down");
    });

    it("should handle work_items not found", async () => {
      vi.mocked(workItemDatabase.updateWorkItem).mockReturnValue(null);
      const res = await server.inject({
        method: "POST",
        url: "/api/repo-dashboard/transition",
        payload: { issueId: "nonexistent", platform: "work_items", repo: "chat", status: "in_progress" },
      });
      expect(res.json().success).toBe(false);
      expect(res.json().error).toMatch(/not found/i);
    });
  });
});
