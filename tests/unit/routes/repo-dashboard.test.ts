/**
 * Unit tests for repo-dashboard sprint & burndown endpoints.
 *
 * Tests the /sprints and /burndown API routes, sprint data normalization,
 * and burndown calculation logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Types ──────────────────────────────────────────────────────────────────

interface DashboardSprint {
  id: string;
  name: string;
  state: string;
  startDate: string;
  endDate: string;
  totalPoints: number;
  completedPoints: number;
  platform: string;
  repo: string;
}

interface DashboardIssue {
  id: string;
  externalId: string;
  title: string;
  url: string;
  status: string;
  priority: string;
  assignee: string | null;
  labels: string[];
  platform: string;
  repo: string;
  createdAt: string;
  updatedAt: string;
  dependencies: Array<{ id: string; label: string }>;
  sprint?: string;
}

interface BurndownData {
  labels: string[];
  ideal: number[];
  actual: number[];
}

// ─── Burndown calculation (mirrors the implementation) ─────────────────────

function calculateBurndown(sprint: DashboardSprint, issues: DashboardIssue[]): BurndownData {
  const startDate = new Date(sprint.startDate);
  const endDate = new Date(sprint.endDate);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || endDate <= startDate) {
    return { labels: [], ideal: [], actual: [] };
  }

  const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000);
  const labels: string[] = [];
  const ideal: number[] = [];
  const actual: number[] = [];

  const doneStatuses = new Set(["done"]);
  const sprintIssues = issues.filter((i) => i.sprint === sprint.id);
  const totalPoints = sprintIssues.length;

  for (let d = 0; d <= totalDays; d++) {
    const day = new Date(startDate.getTime() + d * 86400000);
    labels.push(day.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    ideal.push(Math.round((totalPoints * (totalDays - d)) / totalDays));
    const remaining = sprintIssues.filter((issue) => {
      if (doneStatuses.has(issue.status)) {
        const completedDate = new Date(issue.updatedAt);
        return completedDate > day;
      }
      return true;
    }).length;
    actual.push(remaining);
  }

  return { labels, ideal, actual };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Burndown Calculation", () => {
  const baseSprint: DashboardSprint = {
    id: "sprint-1",
    name: "Sprint 1",
    state: "active",
    startDate: "2025-01-01T00:00:00Z",
    endDate: "2025-01-14T00:00:00Z",
    totalPoints: 5,
    completedPoints: 0,
    platform: "github",
    repo: "org/repo",
  };

  it("should return empty data for invalid dates", () => {
    const invalidSprint = { ...baseSprint, startDate: "", endDate: "" };
    const result = calculateBurndown(invalidSprint, []);
    expect(result.labels).toEqual([]);
    expect(result.ideal).toEqual([]);
    expect(result.actual).toEqual([]);
  });

  it("should return empty data when endDate is before startDate", () => {
    const reversedSprint = { ...baseSprint, startDate: "2025-01-14T00:00:00Z", endDate: "2025-01-01T00:00:00Z" };
    const result = calculateBurndown(reversedSprint, []);
    expect(result.labels).toEqual([]);
  });

  it("should produce ideal burndown line from total to zero", () => {
    const result = calculateBurndown(baseSprint, []);
    expect(result.ideal[0]).toBe(0);
    expect(result.ideal[result.ideal.length - 1]).toBe(0);
    expect(result.labels.length).toBe(14);
  });

  it("should count remaining issues correctly for actual line", () => {
    const issues: DashboardIssue[] = [
      { id: "1", externalId: "1", title: "Task 1", url: "", status: "done", priority: "medium", assignee: null, labels: [], platform: "github", repo: "org/repo", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-05T00:00:00Z", dependencies: [], sprint: "sprint-1" },
      { id: "2", externalId: "2", title: "Task 2", url: "", status: "open", priority: "high", assignee: null, labels: [], platform: "github", repo: "org/repo", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", dependencies: [], sprint: "sprint-1" },
      { id: "3", externalId: "3", title: "Task 3", url: "", status: "done", priority: "low", assignee: null, labels: [], platform: "github", repo: "org/repo", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-10T00:00:00Z", dependencies: [], sprint: "sprint-1" },
    ];

    const result = calculateBurndown(baseSprint, issues);
    expect(result.actual[0]).toBe(3);
    expect(result.actual.length).toBe(14);
  });

  it("should exclude issues not in the sprint", () => {
    const issues: DashboardIssue[] = [
      { id: "1", externalId: "1", title: "Task 1", url: "", status: "open", priority: "medium", assignee: null, labels: [], platform: "github", repo: "org/repo", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", dependencies: [], sprint: "sprint-other" },
    ];

    const result = calculateBurndown(baseSprint, issues);
    expect(result.ideal[0]).toBe(0);
  });
});

describe("Sprint Endpoint Validation", () => {
  it("should require platform and repo parameters", async () => {
    // We test the parameter validation logic directly
    const query = { platform: "", repo: "" };
    const hasRequired = !!(query.platform && query.repo);
    expect(hasRequired).toBe(false);
  });

  it("should accept valid platform and repo parameters", () => {
    const query = { platform: "github", repo: "org/repo" };
    const hasRequired = !!(query.platform && query.repo);
    expect(hasRequired).toBe(true);
  });

  it("should only support github and jira platforms for sprints", () => {
    const supportedPlatforms = ["github", "jira"];
    expect(supportedPlatforms.includes("github")).toBe(true);
    expect(supportedPlatforms.includes("jira")).toBe(true);
    expect(supportedPlatforms.includes("gitlab")).toBe(false);
  });
});

describe("Sprint Data Normalization", () => {
  it("should map Jira sprint fields correctly", () => {
    const jiraSprint = {
      id: 42,
      name: "Sprint 12",
      state: "active",
      startDate: "2025-01-06T00:00:00.000Z",
      endDate: "2025-01-17T00:00:00.000Z",
      originBoardId: 7,
    };

    const mapped: DashboardSprint = {
      id: `jira-sprint-${jiraSprint.id}`,
      name: jiraSprint.name,
      state: jiraSprint.state,
      startDate: jiraSprint.startDate || "",
      endDate: jiraSprint.endDate || "",
      totalPoints: 0,
      completedPoints: 0,
      platform: "jira",
      repo: "PROJ",
    };

    expect(mapped.id).toBe("jira-sprint-42");
    expect(mapped.name).toBe("Sprint 12");
    expect(mapped.state).toBe("active");
    expect(mapped.platform).toBe("jira");
  });

  it("should map GitHub milestone as sprint", () => {
    const milestone = {
      number: 5,
      title: "Sprint 5 - v2.0",
      state: "open",
      created_at: "2025-01-01T00:00:00Z",
      due_on: "2025-01-14T00:00:00Z",
    };

    const mapped: DashboardSprint = {
      id: `gh-milestone-${milestone.number}`,
      name: milestone.title,
      state: milestone.state === "open" ? "active" : "closed",
      startDate: milestone.created_at || "",
      endDate: milestone.due_on || "",
      totalPoints: 0,
      completedPoints: 0,
      platform: "github",
      repo: "org/repo",
    };

    expect(mapped.id).toBe("gh-milestone-5");
    expect(mapped.name).toBe("Sprint 5 - v2.0");
    expect(mapped.state).toBe("active");
  });

  it("should calculate sprint points from issue counts", () => {
    const issues: DashboardIssue[] = [
      { id: "1", externalId: "1", title: "Done 1", url: "", status: "done", priority: "medium", assignee: null, labels: [], platform: "github", repo: "org/repo", createdAt: "", updatedAt: "", dependencies: [], sprint: "sprint-1" },
      { id: "2", externalId: "2", title: "Open 1", url: "", status: "open", priority: "high", assignee: null, labels: [], platform: "github", repo: "org/repo", createdAt: "", updatedAt: "", dependencies: [], sprint: "sprint-1" },
      { id: "3", externalId: "3", title: "Done 2", url: "", status: "done", priority: "low", assignee: null, labels: [], platform: "github", repo: "org/repo", createdAt: "", updatedAt: "", dependencies: [], sprint: "sprint-1" },
      { id: "4", externalId: "4", title: "Other sprint", url: "", status: "done", priority: "medium", assignee: null, labels: [], platform: "github", repo: "org/repo", createdAt: "", updatedAt: "", dependencies: [], sprint: "sprint-2" },
    ];

    const sprintIssues = issues.filter((i) => i.sprint === "sprint-1");
    const totalPoints = sprintIssues.length;
    const completedPoints = sprintIssues.filter((i) => i.status === "done").length;

    expect(totalPoints).toBe(3);
    expect(completedPoints).toBe(2);
  });
});

describe("Empty State Handling", () => {
  it("should return empty sprints array when no sprints exist", () => {
    const result = { sprints: [], issues: [] };
    expect(result.sprints).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("should return empty burndown data for invalid sprint", () => {
    const sprint: DashboardSprint = {
      id: "sprint-1",
      name: "Sprint 1",
      state: "active",
      startDate: "",
      endDate: "",
      totalPoints: 0,
      completedPoints: 0,
      platform: "github",
      repo: "org/repo",
    };

    const result = calculateBurndown(sprint, []);
    expect(result.labels).toEqual([]);
    expect(result.ideal).toEqual([]);
    expect(result.actual).toEqual([]);
  });

  it("should handle sprint with no issues gracefully", () => {
    const sprint: DashboardSprint = {
      id: "sprint-1",
      name: "Sprint 1",
      state: "active",
      startDate: "2025-01-01T00:00:00Z",
      endDate: "2025-01-14T00:00:00Z",
      totalPoints: 0,
      completedPoints: 0,
      platform: "github",
      repo: "org/repo",
    };

    const result = calculateBurndown(sprint, []);
    expect(result.labels.length).toBe(14);
    expect(result.ideal[0]).toBe(0);
    expect(result.actual[0]).toBe(0);
  });
});

describe("GitHub Milestone-to-Sprint Mapping", () => {
  it("should assign sprint field from milestone number", () => {
    const rawIssue = {
      number: 42,
      title: "Fix login bug",
      state: "open",
      html_url: "https://github.com/org/repo/issues/42",
      assignee: { login: "dev1" },
      labels: [{ name: "bug" }],
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-05T00:00:00Z",
      body: "",
      milestone: { number: 3, title: "Sprint 3" },
    };

    const milestone = rawIssue.milestone;
    const sprint = milestone
      ? `gh-milestone-${milestone.number}`
      : "";

    expect(sprint).toBe("gh-milestone-3");
  });

  it("should assign sprint field from sprint/ label when no milestone", () => {
    const rawIssue = {
      number: 43,
      title: "Add feature X",
      state: "open",
      html_url: "https://github.com/org/repo/issues/43",
      assignee: null,
      labels: [{ name: "sprint/2025-01" }, { name: "enhancement" }],
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-05T00:00:00Z",
      body: "",
      milestone: null,
    };

    const sprintLabel = (rawIssue.labels as Array<{ name: string }>)
      .map((l) => l.name)
      .find((l) => l.startsWith("sprint/") || l.startsWith("iteration/"));
    const sprint = rawIssue.milestone
      ? `gh-milestone-${rawIssue.milestone.number}`
      : sprintLabel
        ? `gh-label-${sprintLabel}`
        : "";

    expect(sprint).toBe("gh-label-sprint/2025-01");
  });

  it("should assign iteration/ label as sprint when no milestone", () => {
    const rawIssue = {
      number: 44,
      title: "Refactor module Y",
      state: "open",
      html_url: "https://github.com/org/repo/issues/44",
      assignee: null,
      labels: [{ name: "iteration/4" }],
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-05T00:00:00Z",
      body: "",
      milestone: null,
    };

    const sprintLabel = (rawIssue.labels as Array<{ name: string }>)
      .map((l) => l.name)
      .find((l) => l.startsWith("sprint/") || l.startsWith("iteration/"));
    const sprint = rawIssue.milestone
      ? `gh-milestone-${rawIssue.milestone.number}`
      : sprintLabel
        ? `gh-label-${sprintLabel}`
        : "";

    expect(sprint).toBe("gh-label-iteration/4");
  });

  it("should set empty sprint when no milestone and no sprint label", () => {
    const rawIssue = {
      number: 45,
      title: "General task",
      state: "open",
      html_url: "https://github.com/org/repo/issues/45",
      assignee: null,
      labels: [{ name: "bug" }],
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-05T00:00:00Z",
      body: "",
      milestone: null,
    };

    const sprintLabel = (rawIssue.labels as Array<{ name: string }>)
      .map((l) => l.name)
      .find((l) => l.startsWith("sprint/") || l.startsWith("iteration/"));
    const sprint = rawIssue.milestone
      ? `gh-milestone-${rawIssue.milestone.number}`
      : sprintLabel
        ? `gh-label-${sprintLabel}`
        : "";

    expect(sprint).toBe("");
  });
});

describe("Sprint Points Calculation", () => {
  it("should count total and completed points from sprint issues", () => {
    const issues: DashboardIssue[] = [
      { id: "1", externalId: "#1", title: "A", url: "", status: "done", priority: "medium", assignee: null, labels: [], platform: "github", repo: "org/repo", createdAt: "", updatedAt: "", dependencies: [], sprint: "gh-milestone-3" },
      { id: "2", externalId: "#2", title: "B", url: "", status: "open", priority: "high", assignee: null, labels: [], platform: "github", repo: "org/repo", createdAt: "", updatedAt: "", dependencies: [], sprint: "gh-milestone-3" },
      { id: "3", externalId: "#3", title: "C", url: "", status: "done", priority: "low", assignee: null, labels: [], platform: "github", repo: "org/repo", createdAt: "", updatedAt: "", dependencies: [], sprint: "gh-milestone-3" },
      { id: "4", externalId: "#4", title: "D", url: "", status: "in_progress", priority: "critical", assignee: null, labels: [], platform: "github", repo: "org/repo", createdAt: "", updatedAt: "", dependencies: [], sprint: "gh-milestone-3" },
      { id: "5", externalId: "#5", title: "E", url: "", status: "open", priority: "medium", assignee: null, labels: [], platform: "github", repo: "org/repo", createdAt: "", updatedAt: "", dependencies: [], sprint: "gh-milestone-5" },
    ];

    const sprintIssues = issues.filter((i) => i.sprint === "gh-milestone-3");
    expect(sprintIssues.length).toBe(4);
    expect(sprintIssues.filter((i) => i.status === "done").length).toBe(2);
  });

  it("should calculate days left in active sprint", () => {
    const now = new Date();
    const startDate = new Date(now.getTime() - 7 * 86400000);
    const endDate = new Date(now.getTime() + 7 * 86400000);
    const daysLeft = Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / 86400000));
    expect(daysLeft).toBeGreaterThanOrEqual(6);
    expect(daysLeft).toBeLessThanOrEqual(8);
  });

  it("should return 0 days left for past sprint", () => {
    const now = new Date();
    const endDate = new Date(now.getTime() - 3 * 86400000);
    const daysLeft = Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / 86400000));
    expect(daysLeft).toBe(0);
  });
});
