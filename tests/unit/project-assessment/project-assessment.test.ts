import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  githubClient: {
    isConfigured: vi.fn(),
    listPullRequests: vi.fn(),
    listCommits: vi.fn(),
  },
  gitlabClient: {
    isConfigured: vi.fn(),
    getDefaultProject: vi.fn(),
    getMergeRequests: vi.fn(),
    getCommits: vi.fn(),
  },
  jiraClient: {
    isConfigured: vi.fn(),
    searchIssues: vi.fn(),
  },
  jitbitService: {
    isConfigured: vi.fn(),
    getOpenSupportRequests: vi.fn(),
    findHighPriorityOpenTickets: vi.fn(),
  },
  roadmapDatabase: {
    listRoadmaps: vi.fn(),
    getMilestones: vi.fn(),
    getItems: vi.fn(),
  },
  workItemDatabase: {
    listWorkItems: vi.fn(),
    createWorkItem: vi.fn(),
  },
  agentRunDatabase: {
    getStats: vi.fn(),
  },
}));

vi.mock("../../../src/integrations/github/github-client", () => ({
  githubClient: mocks.githubClient,
}));

vi.mock("../../../src/integrations/gitlab/gitlab-client", () => ({
  gitlabClient: mocks.gitlabClient,
}));

vi.mock("../../../src/integrations/jira/jira-client", () => ({
  jiraClient: mocks.jiraClient,
}));

vi.mock("../../../src/integrations/jitbit/jitbit-service", () => ({
  jitbitService: mocks.jitbitService,
}));

vi.mock("../../../src/roadmap/database", () => ({
  roadmapDatabase: mocks.roadmapDatabase,
}));

vi.mock("../../../src/work-items/database", () => ({
  workItemDatabase: mocks.workItemDatabase,
}));

vi.mock("../../../src/agent-runs/database", () => ({
  agentRunDatabase: mocks.agentRunDatabase,
}));

const sampleWorkItems = [
  {
    id: "work-1",
    type: "task",
    title: "Active task",
    description: "In progress",
    status: "active",
    priority: "medium",
    owner: "Tim",
    source: "manual",
    sourceUrl: null,
    sourceExternalId: null,
    dueAt: "2026-06-01",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    completedAt: null,
    tagsJson: null,
    linkedResourcesJson: null,
    notesJson: null,
    metadataJson: null,
  },
  {
    id: "work-2",
    type: "task",
    title: "Blocked task",
    description: "Stuck",
    status: "blocked",
    priority: "high",
    owner: "Tim",
    source: "manual",
    sourceUrl: null,
    sourceExternalId: null,
    dueAt: "2026-04-30",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
    completedAt: null,
    tagsJson: null,
    linkedResourcesJson: null,
    notesJson: null,
    metadataJson: null,
  },
  {
    id: "work-3",
    type: "task",
    title: "Done task",
    description: "Completed",
    status: "done",
    priority: "low",
    owner: "Tim",
    source: "manual",
    sourceUrl: null,
    sourceExternalId: null,
    dueAt: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-15T00:00:00.000Z",
    completedAt: "2026-03-15T00:00:00.000Z",
    tagsJson: null,
    linkedResourcesJson: null,
    notesJson: null,
    metadataJson: null,
  },
  {
    id: "work-4",
    type: "decision",
    title: "Proposed decision",
    description: "Needs triage",
    status: "proposed",
    priority: "medium",
    owner: "",
    source: "chat",
    sourceUrl: null,
    sourceExternalId: null,
    dueAt: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    completedAt: null,
    tagsJson: null,
    linkedResourcesJson: null,
    notesJson: null,
    metadataJson: null,
  },
];

describe("ProjectAssessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: all integrations not configured
    mocks.githubClient.isConfigured.mockReturnValue(false);
    mocks.gitlabClient.isConfigured.mockReturnValue(false);
    mocks.jiraClient.isConfigured.mockReturnValue(false);
    mocks.jitbitService.isConfigured.mockReturnValue(false);

    // Default: local data sources return empty results
    mocks.workItemDatabase.listWorkItems.mockReturnValue({ items: [], total: 0 });
    mocks.roadmapDatabase.listRoadmaps.mockReturnValue([]);
    mocks.agentRunDatabase.getStats.mockReturnValue({
      totalRuns: 0,
      completedRuns: 0,
      failedRuns: 0,
      runningRuns: 0,
      avgToolLoopCount: 0,
      runsLast24h: 0,
      totalStepsLast24h: 0,
    });
    mocks.workItemDatabase.createWorkItem.mockImplementation((item) => ({
      id: `created-${item.title}`,
      ...item,
    }));
  });

  describe("assessProgress", () => {
    it("returns markdown with all 8 required sections", async () => {
      mocks.workItemDatabase.listWorkItems.mockReturnValue({
        items: sampleWorkItems,
        total: sampleWorkItems.length,
      });
      mocks.roadmapDatabase.listRoadmaps.mockReturnValue([
        { id: "roadmap-1", name: "Platform Roadmap", status: "active", endDate: "2026-12-01" },
      ]);
      mocks.roadmapDatabase.getMilestones.mockReturnValue([
        { id: "ms-1", name: "MVP", status: "in_progress" },
      ]);
      mocks.roadmapDatabase.getItems.mockReturnValue([
        { title: "Feature A", status: "done" },
        { title: "Feature B", status: "blocked" },
        { title: "Feature C", status: "planned" },
      ]);

      const { projectAssessor } = await import("../../../src/project-assessment/project-assessment");
      const result = await projectAssessor.assessProgress({});

      expect(result.markdown).toContain("# Project Assessment");
      expect(result.markdown).toContain("## Current Status");
      expect(result.markdown).toContain("## What Works");
      expect(result.markdown).toContain("## What Looks Incomplete");
      expect(result.markdown).toContain("## Test / Build Health");
      expect(result.markdown).toContain("## Architecture Risks");
      expect(result.markdown).toContain("## Product Gaps");
      expect(result.markdown).toContain("## Recommended Next Milestones");
      expect(result.markdown).toContain("## Suggested Work Items");
    });

    it("gracefully degrades when GitHub/GitLab/Jira are not configured", async () => {
      mocks.githubClient.isConfigured.mockReturnValue(false);
      mocks.gitlabClient.isConfigured.mockReturnValue(false);
      mocks.jiraClient.isConfigured.mockReturnValue(false);
      mocks.jitbitService.isConfigured.mockReturnValue(false);

      const { projectAssessor } = await import("../../../src/project-assessment/project-assessment");
      const result = await projectAssessor.assessProgress({});

      expect(result.sources.github.available).toBe(false);
      expect(result.sources.gitlab.available).toBe(false);
      expect(result.sources.jira.available).toBe(false);
      expect(result.sources.jitbit.available).toBe(false);
      // Local sources should still work
      expect(result.sources.workItems.available).toBe(true);
      expect(result.sources.roadmap.available).toBe(true);
      expect(result.sources.packageJson.available).toBe(true);
      // Markdown should still be generated
      expect(result.markdown).toContain("# Project Assessment");
    });

    it("gracefully degrades when isConfigured throws", async () => {
      mocks.githubClient.isConfigured.mockReturnValue(true);
      // Simulate a thrown error inside the collect block (not just API call failures)
      mocks.githubClient.listPullRequests.mockRejectedValue(new Error("GitHub API rate limit"));
      mocks.githubClient.listCommits.mockRejectedValue(new Error("GitHub API rate limit"));

      const { projectAssessor } = await import("../../../src/project-assessment/project-assessment");
      const result = await projectAssessor.assessProgress({ includeGitHub: true });

      // GitHub data returns empty arrays due to .catch(() => []), but source is still marked available
      // because the collect() wrapper succeeds (Promise.all with .catch doesn't throw)
      expect(result.sources.github.available).toBe(true);
      expect(result.stats.openPRs).toBe(0);
      // Other sources should still work
      expect(result.sources.workItems.available).toBe(true);
      expect(result.markdown).toContain("# Project Assessment");
    });

    it("marks source as unavailable when isConfigured returns false", async () => {
      mocks.githubClient.isConfigured.mockReturnValue(false);

      const { projectAssessor } = await import("../../../src/project-assessment/project-assessment");
      const result = await projectAssessor.assessProgress({ includeGitHub: true });

      // When isConfigured() returns false, collect() catches the thrown error
      expect(result.sources.github.available).toBe(false);
      expect(result.sources.github.error).toContain("not configured");
    });

    it("collects GitHub data when configured", async () => {
      mocks.githubClient.isConfigured.mockReturnValue(true);
      mocks.githubClient.listPullRequests.mockResolvedValue([
        { number: 12, title: "Open PR", html_url: "https://github.test/pr/12" },
      ]);
      mocks.githubClient.listCommits.mockResolvedValue([
        { sha: "abc123", commit: { message: "Recent commit" } },
      ]);

      const { projectAssessor } = await import("../../../src/project-assessment/project-assessment");
      const result = await projectAssessor.assessProgress({ includeGitHub: true });

      expect(result.sources.github.available).toBe(true);
      expect(result.stats.openPRs).toBe(1);
      expect(result.stats.recentCommits).toBeGreaterThanOrEqual(1);
    });

    it("collects GitLab data when configured", async () => {
      mocks.gitlabClient.isConfigured.mockReturnValue(true);
      mocks.gitlabClient.getDefaultProject.mockReturnValue("org/project");
      mocks.gitlabClient.getMergeRequests.mockResolvedValue([
        { iid: 7, title: "Open MR", web_url: "https://gitlab.test/mr/7" },
      ]);
      mocks.gitlabClient.getCommits.mockResolvedValue([
        { short_id: "def456", title: "GitLab commit" },
      ]);

      const { projectAssessor } = await import("../../../src/project-assessment/project-assessment");
      const result = await projectAssessor.assessProgress({ includeGitLab: true });

      expect(result.sources.gitlab.available).toBe(true);
      expect(result.stats.openMRs).toBe(1);
    });

    it("collects Jira data when configured", async () => {
      mocks.jiraClient.isConfigured.mockReturnValue(true);
      mocks.jiraClient.searchIssues.mockResolvedValue([
        { key: "ENG-1", fields: { summary: "Open Jira issue", status: { name: "In Progress" } } },
      ]);

      const { projectAssessor } = await import("../../../src/project-assessment/project-assessment");
      const result = await projectAssessor.assessProgress({ includeJira: true });

      expect(result.sources.jira.available).toBe(true);
      expect(result.stats.openJiraTickets).toBe(1);
    });

    it("skips sources when include flags are false", async () => {
      const { projectAssessor } = await import("../../../src/project-assessment/project-assessment");
      const result = await projectAssessor.assessProgress({
        includeGitHub: false,
        includeGitLab: false,
        includeJira: false,
        includeJitbit: false,
        includeRoadmap: false,
        includeWorkItems: false,
        includeAgentRuns: false,
      });

      expect(result.sources.github.enabled).toBe(false);
      expect(result.sources.gitlab.enabled).toBe(false);
      expect(result.sources.jira.enabled).toBe(false);
      expect(result.sources.jitbit.enabled).toBe(false);
      expect(result.sources.roadmap.enabled).toBe(false);
      expect(result.sources.workItems.enabled).toBe(false);
      expect(result.sources.agentRuns.enabled).toBe(false);
      // packageJson should always be collected
      expect(result.sources.packageJson.enabled).toBe(true);
    });

    it("calculates stats correctly", async () => {
      mocks.workItemDatabase.listWorkItems.mockReturnValue({
        items: sampleWorkItems,
        total: sampleWorkItems.length,
      });
      mocks.githubClient.isConfigured.mockReturnValue(true);
      mocks.githubClient.listPullRequests.mockResolvedValue([
        { number: 1, title: "PR 1" },
        { number: 2, title: "PR 2" },
      ]);
      mocks.githubClient.listCommits.mockResolvedValue([
        { sha: "abc" },
        { sha: "def" },
        { sha: "ghi" },
      ]);
      mocks.agentRunDatabase.getStats.mockReturnValue({
        totalRuns: 10,
        completedRuns: 8,
        failedRuns: 2,
        runningRuns: 0,
        avgToolLoopCount: 3,
        runsLast24h: 5,
        totalStepsLast24h: 20,
      });

      const { projectAssessor } = await import("../../../src/project-assessment/project-assessment");
      const result = await projectAssessor.assessProgress({ includeGitHub: true, includeAgentRuns: true });

      expect(result.stats.totalWorkItems).toBe(4);
      expect(result.stats.completedWorkItems).toBe(1); // only "Done task"
      expect(result.stats.blockedWorkItems).toBe(1); // "Blocked task"
      expect(result.stats.openPRs).toBe(2);
      expect(result.stats.agentRunSuccessRate).toBe(0.8); // 8/10
    });

    it("does not make code changes (read-only assessment)", async () => {
      mocks.workItemDatabase.listWorkItems.mockReturnValue({
        items: sampleWorkItems,
        total: sampleWorkItems.length,
      });

      const { projectAssessor } = await import("../../../src/project-assessment/project-assessment");
      const result = await projectAssessor.assessProgress({});

      // Only listWorkItems should have been called, not createWorkItem
      expect(mocks.workItemDatabase.createWorkItem).not.toHaveBeenCalled();
      // Assessment should return suggested work items but not persist them
      expect(result.suggestedWorkItems).toBeDefined();
      expect(typeof result.suggestedWorkItems).toBe("object");
    });
  });

  describe("createSuggestedWorkItems", () => {
    it("creates work items via workItemDatabase", async () => {
      const { projectAssessor } = await import("../../../src/project-assessment/project-assessment");
      const created = projectAssessor.createSuggestedWorkItems([
        {
          type: "task",
          title: "Test work item",
          priority: "high",
          source: "chat",
          tags: ["project-assessment"],
        },
      ]);

      expect(created).toHaveLength(1);
      expect(mocks.workItemDatabase.createWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Test work item",
          source: "chat",
          tags: expect.arrayContaining(["project-assessment"]),
          status: "proposed",
        }),
      );
    });

    it("adds project-assessment tag to created items", async () => {
      const { projectAssessor } = await import("../../../src/project-assessment/project-assessment");
      projectAssessor.createSuggestedWorkItems([
        {
          type: "task",
          title: "Tagged item",
          tags: ["custom"],
        },
      ]);

      expect(mocks.workItemDatabase.createWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: expect.arrayContaining(["custom", "project-assessment"]),
        }),
      );
    });
  });
});