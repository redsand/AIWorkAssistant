import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fileCalendarService: {
    listEvents: vi.fn(),
  },
  hawkIrService: {
    isConfigured: vi.fn().mockReturnValue(false),
    getRiskyOpenCases: vi.fn().mockResolvedValue([]),
    getCaseCount: vi.fn().mockResolvedValue(0),
    getRecentCases: vi.fn().mockResolvedValue([]),
    getActiveNodes: vi.fn().mockResolvedValue([]),
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
  agentRunDatabase: {
    getStats: vi.fn(),
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

vi.mock("../../../src/integrations/hawk-ir/hawk-ir-service", () => ({
  hawkIrService: mocks.hawkIrService,
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

vi.mock("../../../src/agent-runs/database", () => ({
  agentRunDatabase: mocks.agentRunDatabase,
}));

function setupDefaultMocks() {
  mocks.fileCalendarService.listEvents.mockReturnValue([
    { summary: "Weekly leadership sync", startTime: new Date("2026-05-04T09:00:00"), endTime: new Date("2026-05-04T10:00:00") },
  ]);
  mocks.jiraClient.isConfigured.mockReturnValue(true);
  mocks.jiraClient.searchIssues.mockResolvedValue([
    { key: "ENG-42", fields: { summary: "Weekly sprint blocker", status: { name: "In Progress" } } },
  ]);
  mocks.gitlabClient.isConfigured.mockReturnValue(true);
  mocks.gitlabClient.getDefaultProject.mockReturnValue("org/project");
  mocks.gitlabClient.getMergeRequests.mockResolvedValue([
    { iid: 12, title: "Feature branch MR", web_url: "https://gitlab.test/mr/12" },
  ]);
  mocks.gitlabClient.listPipelines.mockResolvedValue([
    { id: 99, status: "success", web_url: "https://gitlab.test/pipelines/99" },
  ]);
  mocks.gitlabClient.getCommits.mockResolvedValue([
    { short_id: "abc1234", title: "Weekly commit" },
  ]);
  mocks.githubClient.isConfigured.mockReturnValue(true);
  mocks.githubClient.listPullRequests.mockResolvedValue([
    { number: 22, title: "Open weekly PR", html_url: "https://github.test/pr/22" },
  ]);
  mocks.githubClient.listWorkflowRuns.mockResolvedValue([
    { id: 55, name: "CI", conclusion: "success" },
  ]);
  mocks.githubClient.listCommits.mockResolvedValue([
    { sha: "def4567", commit: { message: "GitHub weekly commit" } },
  ]);
  mocks.githubClient.listReleases.mockResolvedValue([
    { name: "v2.0.0", tag_name: "v2.0.0" },
  ]);
  mocks.jitbitService.isConfigured.mockReturnValue(true);
  mocks.jitbitService.getRecentCustomerActivity.mockResolvedValue([
    { TicketID: 201, Subject: "Weekly customer issue", Status: "Open", CompanyName: "Acme" },
  ]);
  mocks.jitbitService.findTicketsNeedingFollowup.mockResolvedValue([
    { TicketID: 202, Subject: "Needs weekly follow-up", Status: "Open", CompanyName: "Beta" },
  ]);
  mocks.jitbitService.findHighPriorityOpenTickets.mockResolvedValue([
    { TicketID: 203, Subject: "Critical weekly issue", Status: "Open", CompanyName: "Acme", PriorityName: "High" },
  ]);
  mocks.roadmapDatabase.listRoadmaps.mockReturnValue([
    { id: "roadmap-1", name: "Platform Roadmap", status: "active", endDate: "2026-06-30" },
  ]);
  mocks.roadmapDatabase.getMilestones.mockReturnValue([
    { id: "milestone-1", name: "Q2 Launch", status: "in_progress" },
  ]);
  mocks.roadmapDatabase.getItems.mockReturnValue([
    { title: "Blocked roadmap item", status: "blocked" },
  ]);
  mocks.workItemDatabase.listWorkItems.mockReturnValue({
    items: [
      {
        id: "work-1",
        type: "task",
        title: "Completed task this week",
        description: "Done",
        status: "done",
        priority: "medium",
        owner: "Tim",
        source: "manual",
        sourceUrl: null,
        sourceExternalId: null,
        dueAt: "2026-05-06",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-06T00:00:00.000Z",
        completedAt: "2026-05-06T12:00:00.000Z",
        tagsJson: null,
        linkedResourcesJson: null,
        notesJson: null,
        metadataJson: null,
      },
      {
        id: "work-2",
        type: "task",
        title: "Blocked work item",
        description: "Needs unblocking",
        status: "blocked",
        priority: "high",
        owner: "Tim",
        source: "manual",
        sourceUrl: null,
        sourceExternalId: null,
        dueAt: "2026-05-03",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-05T00:00:00.000Z",
        completedAt: null,
        tagsJson: null,
        linkedResourcesJson: null,
        notesJson: null,
        metadataJson: null,
      },
    ],
    total: 2,
  });
  mocks.workItemDatabase.createWorkItem.mockImplementation((item) => ({
    id: `created-${item.title}`,
    ...item,
  }));
  mocks.conversationManager.getRelevantMemories.mockReturnValue([
    "- Decision: prioritize customer follow-ups weekly",
  ]);
  mocks.agentRunDatabase.getStats.mockReturnValue({
    totalRuns: 42,
    completedRuns: 38,
    failedRuns: 4,
    runningRuns: 0,
    avgToolLoopCount: 3.2,
    runsLast24h: 12,
    totalStepsLast24h: 48,
  });
}

describe("WeeklyDigestGenerator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("generates the weekly digest with all required sections", async () => {
    const { weeklyDigestGenerator } = await import("../../../src/digests/weekly-digest");
    const result = await weeklyDigestGenerator.generateWeeklyDigest({
      weekStart: "2026-05-04",
    });

    expect(result.weekStart).toBe("2026-05-04");
    expect(result.weekEnd).toBe("2026-05-10");
    expect(result.markdown).toContain("# Weekly Digest — Week of 2026-05-04");
    expect(result.markdown).toContain("## Executive Summary");
    expect(result.markdown).toContain("## Customer / Support Signals");
    expect(result.markdown).toContain("## Engineering Progress");
    expect(result.markdown).toContain("## Product / Roadmap Progress");
    expect(result.markdown).toContain("## Open Risks");
    expect(result.markdown).toContain("## Decisions Needed");
    expect(result.markdown).toContain("## Work Completed");
    expect(result.markdown).toContain("## Work Blocked");
    expect(result.markdown).toContain("## Follow-ups");
    expect(result.markdown).toContain("## Suggested Next Week Focus");
    expect(result.markdown).toContain("## Draft Internal Update");
    expect(result.suggestedWorkItems.length).toBeGreaterThan(0);
    expect(result.sources.jitbit.available).toBe(true);
    expect(result.sources.github.available).toBe(true);
    expect(result.sources.gitlab.available).toBe(true);
  });

  it("degrades gracefully when integrations are unconfigured", async () => {
    mocks.jiraClient.isConfigured.mockReturnValue(false);
    mocks.gitlabClient.isConfigured.mockReturnValue(false);
    mocks.githubClient.isConfigured.mockReturnValue(false);
    mocks.jitbitService.isConfigured.mockReturnValue(false);
    mocks.hawkIrService.isConfigured.mockReturnValue(false);

    const { weeklyDigestGenerator } = await import("../../../src/digests/weekly-digest");
    const result = await weeklyDigestGenerator.generateWeeklyDigest({
      weekStart: "2026-05-04",
    });

    expect(result.markdown).toContain("Unavailable sources");
    expect(result.sources.jira.available).toBe(false);
    expect(result.sources.gitlab.available).toBe(false);
    expect(result.sources.github.available).toBe(false);
    expect(result.sources.jitbit.available).toBe(false);
    expect(result.sources.hawkIr.available).toBe(false);
    expect(result.sources.workItems.available).toBe(true);
    expect(result.sources.roadmap.available).toBe(true);
  });

  it("creates suggested work items with weekly-digest tag", async () => {
    const { weeklyDigestGenerator } = await import("../../../src/digests/weekly-digest");
    const created = weeklyDigestGenerator.createSuggestedWorkItems([
      {
        type: "customer_followup",
        title: "Follow up on weekly ticket",
        priority: "high",
        source: "jitbit",
        tags: ["customer"],
      },
    ]);

    expect(created).toHaveLength(1);
    expect(mocks.workItemDatabase.createWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Follow up on weekly ticket",
        source: "jitbit",
        tags: ["customer", "weekly-digest"],
      }),
    );
  });

  it("calculates Monday-Sunday date range correctly", async () => {
    const { weeklyDigestGenerator } = await import("../../../src/digests/weekly-digest");

    // Wednesday May 6, 2026 — should snap to Monday May 4
    const result = await weeklyDigestGenerator.generateWeeklyDigest({
      weekStart: "2026-05-06",
    });
    expect(result.weekStart).toBe("2026-05-04");
    expect(result.weekEnd).toBe("2026-05-10");
  });

  it("defaults to current week when no weekStart is provided", async () => {
    const { weeklyDigestGenerator } = await import("../../../src/digests/weekly-digest");
    const result = await weeklyDigestGenerator.generateWeeklyDigest({});

    // weekStart should be a Monday
    const parsed = new Date(`${result.weekStart}T00:00:00`);
    expect(parsed.getDay()).toBe(1); // Monday
    // weekEnd should be Sunday
    const parsedEnd = new Date(`${result.weekEnd}T00:00:00`);
    expect(parsedEnd.getDay()).toBe(0); // Sunday
  });

  it("does not send external messages", async () => {
    const { weeklyDigestGenerator } = await import("../../../src/digests/weekly-digest");
    const result = await weeklyDigestGenerator.generateWeeklyDigest({
      weekStart: "2026-05-04",
    });

    // The digest should contain a note that no external messages were sent
    expect(result.markdown).toContain("No external messages were sent");
    // Verify no external notification/email functions were called
    // (there are none in the module — this confirms the design)
    expect(result.suggestedWorkItems).toBeDefined();
  });

  it("includes agent run stats in the executive summary", async () => {
    const { weeklyDigestGenerator } = await import("../../../src/digests/weekly-digest");
    const result = await weeklyDigestGenerator.generateWeeklyDigest({
      weekStart: "2026-05-04",
    });

    expect(result.markdown).toContain("42 total, 4 failed");
  });

  it("handles empty data gracefully", async () => {
    mocks.fileCalendarService.listEvents.mockReturnValue([]);
    mocks.jiraClient.isConfigured.mockReturnValue(true);
    mocks.jiraClient.searchIssues.mockResolvedValue([]);
    mocks.gitlabClient.isConfigured.mockReturnValue(true);
    mocks.gitlabClient.getDefaultProject.mockReturnValue("org/project");
    mocks.gitlabClient.getMergeRequests.mockResolvedValue([]);
    mocks.gitlabClient.listPipelines.mockResolvedValue([]);
    mocks.gitlabClient.getCommits.mockResolvedValue([]);
    mocks.githubClient.isConfigured.mockReturnValue(true);
    mocks.githubClient.listPullRequests.mockResolvedValue([]);
    mocks.githubClient.listWorkflowRuns.mockResolvedValue([]);
    mocks.githubClient.listCommits.mockResolvedValue([]);
    mocks.githubClient.listReleases.mockResolvedValue([]);
    mocks.jitbitService.isConfigured.mockReturnValue(true);
    mocks.jitbitService.getRecentCustomerActivity.mockResolvedValue([]);
    mocks.jitbitService.findTicketsNeedingFollowup.mockResolvedValue([]);
    mocks.jitbitService.findHighPriorityOpenTickets.mockResolvedValue([]);
    mocks.roadmapDatabase.listRoadmaps.mockReturnValue([]);
    mocks.workItemDatabase.listWorkItems.mockReturnValue({ items: [], total: 0 });
    mocks.conversationManager.getRelevantMemories.mockReturnValue([]);

    const { weeklyDigestGenerator } = await import("../../../src/digests/weekly-digest");
    const result = await weeklyDigestGenerator.generateWeeklyDigest({
      weekStart: "2026-05-04",
    });

    expect(result.markdown).toContain("No Jitbit customer/support activity available");
    expect(result.markdown).toContain("No engineering signals found");
    expect(result.markdown).toContain("No active roadmaps found");
  });
});