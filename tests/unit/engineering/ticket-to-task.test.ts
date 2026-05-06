import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGithubClient = {
  resolveRepo: vi.fn(),
  getIssue: vi.fn(),
  listIssueComments: vi.fn(),
  searchCode: vi.fn(),
};

const mockRoadmapDatabase = {
  listRoadmaps: vi.fn(),
  getMilestones: vi.fn(),
  getItems: vi.fn(),
};

const mockCodebaseIndexer = {
  getStats: vi.fn(),
  indexCodebase: vi.fn(),
  search: vi.fn(),
};

vi.mock("../../../src/integrations/github/github-client", () => ({
  githubClient: mockGithubClient,
}));

vi.mock("../../../src/roadmap/database", () => ({
  roadmapDatabase: mockRoadmapDatabase,
}));

vi.mock("../../../src/agent/codebase-indexer", () => ({
  codebaseIndexer: mockCodebaseIndexer,
}));

describe("ticketToTaskGenerator", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGithubClient.resolveRepo.mockReturnValue({
      owner: "redsand",
      repo: "AIWorkAssistant",
    });
    mockGithubClient.getIssue.mockResolvedValue({
      number: 25,
      title: "[P1] Flexible Priority Stack",
      body: [
        "Build user-defined sourcing tiers.",
        "",
        "- [ ] `SchedulingPriorityProfile` type defined",
        "- [x] Default profile can be loaded",
        "",
        "Depends on #4 and relates to #6.",
        "",
        "Touch `src/agent/prompts.ts` and SchedulingPriorityProfile.",
      ].join("\n"),
      html_url: "https://github.com/redsand/AIWorkAssistant/issues/25",
      labels: [{ name: "feature" }, { name: "priority:high" }],
      milestone: { title: "Phase 1", due_on: "2025-06-30" },
      assignee: { login: "tim" },
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-02T00:00:00Z",
    });
    mockGithubClient.listIssueComments.mockResolvedValue([
      {
        user: { login: "reviewer" },
        created_at: "2026-05-02T01:00:00Z",
        body: "Also blocks #10.",
      },
    ]);
    mockGithubClient.searchCode.mockResolvedValue([
      { path: "src/productivity/daily-planner.ts" },
    ]);

    mockRoadmapDatabase.listRoadmaps.mockReturnValue([
      {
        id: "roadmap-1",
        name: "Phase 1 Roadmap",
        status: "active",
        description: "Priority stack work",
      },
    ]);
    mockRoadmapDatabase.getMilestones.mockReturnValue([
      {
        id: "milestone-1",
        roadmapId: "roadmap-1",
        name: "Phase 1",
        targetDate: "2025-06-30",
        status: "in_progress",
        description: "Observability and work items",
      },
    ]);
    mockRoadmapDatabase.getItems.mockReturnValue([
      {
        id: "item-1",
        milestoneId: "milestone-1",
        title: "Flexible Priority Stack",
        description: "User-defined sourcing tiers",
        priority: "high",
        status: "todo",
      },
    ]);

    mockCodebaseIndexer.getStats.mockReturnValue({ totalChunks: 12 });
    mockCodebaseIndexer.search.mockReturnValue([
      {
        filePath: "src/agent/knowledge-store.ts",
        startLine: 1,
        endLine: 10,
        content: "priority profile",
        language: "typescript",
        score: 8,
        matchType: "keyword",
      },
    ]);
  });

  it("builds an implementation prompt from an enriched GitHub issue", async () => {
    const { ticketToTaskGenerator } = await import(
      "../../../src/engineering/ticket-to-task"
    );

    const result = await ticketToTaskGenerator.generate({
      owner: "redsand",
      repo: "AIWorkAssistant",
      issueNumber: 25,
      agent: "generic",
      includeComments: true,
      includeRoadmap: true,
      includeCodebase: true,
    });

    expect(result.title).toBe("Implementation Task: [P1] Flexible Priority Stack");
    expect(result.body).toContain("# Implementation Task: [P1] Flexible Priority Stack");
    expect(result.body).toContain("redsand/AIWorkAssistant#25");
    expect(result.body).toContain("- [ ] `SchedulingPriorityProfile` type defined");
    expect(result.body).toContain("- [ ] Default profile can be loaded");
    expect(result.body).toContain("- #4");
    expect(result.body).toContain("- #6");
    expect(result.body).toContain("- #10");
    expect(result.body).toContain("Flexible Priority Stack (priority: high, status: todo)");
    expect(result.body).toContain("`src/agent/prompts.ts`");
    expect(result.body).toContain("`src/agent/knowledge-store.ts`");
    expect(result.metadata).toMatchObject({
      issueNumber: 25,
      issueUrl: "https://github.com/redsand/AIWorkAssistant/issues/25",
      labels: ["feature", "priority:high"],
      milestone: "Phase 1",
      assignee: "tim",
      relatedIssues: [4, 6, 10],
      roadmapItemId: "item-1",
    });
  });

  it("handles missing acceptance criteria and roadmap matches gracefully", async () => {
    mockGithubClient.getIssue.mockResolvedValueOnce({
      number: 26,
      title: "Small cleanup",
      body: "No checkbox list here.",
      html_url: "https://github.com/redsand/AIWorkAssistant/issues/26",
      labels: [],
      milestone: null,
      assignee: null,
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-02T00:00:00Z",
    });
    mockGithubClient.listIssueComments.mockResolvedValueOnce([]);
    mockRoadmapDatabase.getItems.mockReturnValueOnce([]);
    mockCodebaseIndexer.search.mockReturnValue([]);
    mockGithubClient.searchCode.mockResolvedValue([]);

    const { ticketToTaskGenerator } = await import(
      "../../../src/engineering/ticket-to-task"
    );

    const result = await ticketToTaskGenerator.generate({
      owner: "redsand",
      repo: "AIWorkAssistant",
      issueNumber: 26,
      includeComments: true,
      includeRoadmap: true,
      includeCodebase: true,
    });

    expect(result.body).toContain("No checkbox acceptance criteria were found");
    expect(result.body).toContain("No matching roadmap item was found");
    expect(result.metadata.roadmapItemId).toBeNull();
    expect(result.metadata.relevantFiles).toEqual([]);
  });
});
