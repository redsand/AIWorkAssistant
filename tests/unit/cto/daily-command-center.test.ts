import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fileCalendarService: {
    listEvents: vi.fn(),
  },
  jiraClient: {
    isConfigured: vi.fn(),
    searchIssues: vi.fn(),
  },
  gitlabClient: {
    isConfigured: vi.fn(),
    getDefaultProject: vi.fn(),
    getMergeRequests: vi.fn(),
    listPipelines: vi.fn(),
    getCommits: vi.fn(),
  },
  githubClient: {
    isConfigured: vi.fn(),
    listPullRequests: vi.fn(),
    listWorkflowRuns: vi.fn(),
    listCommits: vi.fn(),
    listReleases: vi.fn(),
  },
  jitbitService: {
    isConfigured: vi.fn(),
    getRecentCustomerActivity: vi.fn(),
    findTicketsNeedingFollowup: vi.fn(),
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
  conversationManager: {
    getRelevantMemories: vi.fn(),
  },
}));

vi.mock("../../../src/integrations/file/calendar-service", () => ({
  fileCalendarService: mocks.fileCalendarService,
}));

vi.mock("../../../src/integrations/jira/jira-client", () => ({
  jiraClient: mocks.jiraClient,
}));

vi.mock("../../../src/integrations/gitlab/gitlab-client", () => ({
  gitlabClient: mocks.gitlabClient,
}));

vi.mock("../../../src/integrations/github/github-client", () => ({
  githubClient: mocks.githubClient,
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

vi.mock("../../../src/memory/conversation-manager", () => ({
  conversationManager: mocks.conversationManager,
}));

describe("CTO Daily Command Center", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fileCalendarService.listEvents.mockReturnValue([
      {
        summary: "Leadership sync",
        startTime: new Date("2026-05-05T09:00:00"),
        endTime: new Date("2026-05-05T09:30:00"),
      },
    ]);
    mocks.jiraClient.isConfigured.mockReturnValue(true);
    mocks.jiraClient.searchIssues.mockResolvedValue([
      { key: "ENG-1", fields: { summary: "Jira blocker" } },
    ]);
    mocks.gitlabClient.isConfigured.mockReturnValue(true);
    mocks.gitlabClient.getDefaultProject.mockReturnValue("org/project");
    mocks.gitlabClient.getMergeRequests.mockResolvedValue([
      { iid: 7, title: "MR waiting", web_url: "https://gitlab.test/mr/7" },
    ]);
    mocks.gitlabClient.listPipelines.mockResolvedValue([
      { id: 33, status: "failed", web_url: "https://gitlab.test/pipelines/33" },
    ]);
    mocks.gitlabClient.getCommits.mockResolvedValue([
      { short_id: "abc123", title: "Recent commit" },
    ]);
    mocks.githubClient.isConfigured.mockReturnValue(true);
    mocks.githubClient.listPullRequests.mockResolvedValue([
      { number: 12, title: "Open PR", html_url: "https://github.test/pr/12" },
    ]);
    mocks.githubClient.listWorkflowRuns.mockResolvedValue([
      { id: 44, name: "CI", conclusion: "success" },
    ]);
    mocks.githubClient.listCommits.mockResolvedValue([
      { sha: "def456", commit: { message: "GitHub commit" } },
    ]);
    mocks.githubClient.listReleases.mockResolvedValue([
      { name: "v1.2.3", tag_name: "v1.2.3" },
    ]);
    mocks.jitbitService.isConfigured.mockReturnValue(true);
    mocks.jitbitService.getRecentCustomerActivity.mockResolvedValue([
      { TicketID: 101, Subject: "Recent customer issue", Status: "Open", CompanyName: "Acme" },
    ]);
    mocks.jitbitService.findTicketsNeedingFollowup.mockResolvedValue([
      { TicketID: 102, Subject: "Needs follow-up", Status: "Open", CompanyName: "Beta" },
    ]);
    mocks.jitbitService.findHighPriorityOpenTickets.mockResolvedValue([
      { TicketID: 103, Subject: "Critical support issue", Status: "Open", CompanyName: "Acme", PriorityName: "High" },
    ]);
    mocks.roadmapDatabase.listRoadmaps.mockReturnValue([
      { id: "roadmap-1", name: "Platform Roadmap", status: "active", endDate: "2026-06-01" },
    ]);
    mocks.roadmapDatabase.getMilestones.mockReturnValue([
      { id: "milestone-1", name: "Launch", status: "in_progress" },
    ]);
    mocks.roadmapDatabase.getItems.mockReturnValue([
      { title: "Blocked roadmap item", status: "blocked" },
    ]);
    mocks.workItemDatabase.listWorkItems.mockReturnValue({
      items: [
        {
          id: "work-1",
          type: "task",
          title: "Overdue item",
          description: "Needs attention",
          status: "active",
          priority: "medium",
          owner: "Tim",
          source: "manual",
          sourceUrl: null,
          sourceExternalId: null,
          dueAt: "2026-05-04",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-04T00:00:00.000Z",
          completedAt: null,
          tagsJson: null,
          linkedResourcesJson: null,
          notesJson: null,
          metadataJson: null,
        },
      ],
      total: 1,
    });
    mocks.workItemDatabase.createWorkItem.mockImplementation((item) => ({
      id: `created-${item.title}`,
      ...item,
    }));
    mocks.conversationManager.getRelevantMemories.mockReturnValue([
      "- Prior decision: protect customer follow-up time",
    ]);
  });

  it("generates the brief with all mocked sources", async () => {
    const { ctoDailyCommandCenter } = await import("../../../src/cto/daily-command-center");
    const result = await ctoDailyCommandCenter.generateDailyCommandCenter({
      userId: "tim",
      date: "2026-05-05",
    });

    expect(result.markdown).toContain("# CTO Daily Command Center — 2026-05-05");
    expect(result.markdown).toContain("Customer / Support Signals");
    expect(result.markdown).toContain("Critical support issue");
    expect(result.markdown).toContain("Open PR");
    expect(result.markdown).toContain("Platform Roadmap");
    expect(result.suggestedWorkItems.length).toBeGreaterThan(0);
    expect(result.sources.jitbit.available).toBe(true);
  });

  it("degrades gracefully when integrations are unconfigured", async () => {
    mocks.jiraClient.isConfigured.mockReturnValue(false);
    mocks.gitlabClient.isConfigured.mockReturnValue(false);
    mocks.githubClient.isConfigured.mockReturnValue(false);
    mocks.jitbitService.isConfigured.mockReturnValue(false);

    const { ctoDailyCommandCenter } = await import("../../../src/cto/daily-command-center");
    const result = await ctoDailyCommandCenter.generateDailyCommandCenter({
      userId: "tim",
      date: "2026-05-05",
    });

    expect(result.markdown).toContain("Some integrations were unavailable");
    expect(result.markdown).toContain("Jitbit client not configured");
    expect(result.sources.jira.available).toBe(false);
    expect(result.sources.workItems.available).toBe(true);
  });

  it("creates suggested work items without sending customer-facing updates", async () => {
    const { ctoDailyCommandCenter } = await import("../../../src/cto/daily-command-center");
    const created = ctoDailyCommandCenter.createSuggestedWorkItems([
      {
        type: "customer_followup",
        title: "Follow up with Acme",
        priority: "high",
        source: "jitbit",
        tags: ["customer"],
      },
    ]);

    expect(created).toHaveLength(1);
    expect(mocks.workItemDatabase.createWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Follow up with Acme",
        source: "jitbit",
        tags: ["customer", "cto-daily"],
      }),
    );
  });
});
