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

describe("extractDependencyRefs", () => {
  let generator: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../../../src/engineering/ticket-to-task");
    generator = mod.ticketToTaskGenerator;
  });

  it("parses same-repo GitHub #NNN references", () => {
    const refs = generator.extractDependencyRefs("Depends on #4 and #6.", []);
    const githubRefs = refs.filter((r: any) => r.platform === "github" && r.raw.startsWith("#"));
    expect(githubRefs).toHaveLength(2);
    expect(githubRefs.map((r: any) => r.issueNumber).sort()).toEqual([4, 6]);
  });

  it("parses JIRA:KEY-123 references", () => {
    const refs = generator.extractDependencyRefs("Related to JIRA:IR-41 and Jira:PROJ-99.", []);
    const jiraRefs = refs.filter((r: any) => r.platform === "jira");
    expect(jiraRefs).toHaveLength(2);
    expect(jiraRefs[0].issueKey).toBe("IR-41");
    expect(jiraRefs[1].issueKey).toBe("PROJ-99");
    expect(jiraRefs[0].raw).toBe("JIRA:IR-41");
    expect(jiraRefs[1].raw).toBe("Jira:PROJ-99");
  });

  it("parses GH:owner/repo#N cross-repo GitHub references", () => {
    const refs = generator.extractDependencyRefs("See GH:redsand/OtherRepo#5 for context.", []);
    const crossRepo = refs.find((r: any) => r.platform === "github" && r.owner);
    expect(crossRepo).toBeDefined();
    expect(crossRepo.owner).toBe("redsand");
    expect(crossRepo.repo).toBe("OtherRepo");
    expect(crossRepo.issueNumber).toBe(5);
    expect(crossRepo.raw).toBe("GH:redsand/OtherRepo#5");
  });

  it("parses GitHub:owner/repo#N references", () => {
    const refs = generator.extractDependencyRefs("Blocked by GitHub: owner/repo#42.", []);
    const crossRepo = refs.find((r: any) => r.platform === "github" && r.owner);
    expect(crossRepo).toBeDefined();
    expect(crossRepo.owner).toBe("owner");
    expect(crossRepo.repo).toBe("repo");
    expect(crossRepo.issueNumber).toBe(42);
  });

  it("parses GL:project#N GitLab references", () => {
    const refs = generator.extractDependencyRefs("Mirrored in GL:hawkio/soc-agent#142.", []);
    const glRef = refs.find((r: any) => r.platform === "gitlab");
    expect(glRef).toBeDefined();
    expect(glRef.projectKey).toBe("hawkio/soc-agent");
    expect(glRef.issueNumber).toBe(142);
    expect(glRef.raw).toBe("GL:hawkio/soc-agent#142");
  });

  it("parses GitLab:project#N references", () => {
    const refs = generator.extractDependencyRefs("Also tracked as GitLab:infra/terraform#7.", []);
    const glRef = refs.find((r: any) => r.platform === "gitlab");
    expect(glRef).toBeDefined();
    expect(glRef.projectKey).toBe("infra/terraform");
    expect(glRef.issueNumber).toBe(7);
  });

  it("parses mixed platform references in one text", () => {
    const body = "Depends on JIRA:IR-41, GH:redsand/OtherRepo#5, and GL:hawkio/soc-agent#142. Also #10.";
    const refs = generator.extractDependencyRefs(body, []);
    expect(refs.length).toBeGreaterThanOrEqual(4);
    const platforms = refs.map((r: any) => r.platform);
    expect(platforms).toContain("jira");
    expect(platforms).toContain("gitlab");
  });

  it("deduplicates by raw match string", () => {
    const body = "See JIRA:IR-41. Also JIRA:IR-41 again.";
    const refs = generator.extractDependencyRefs(body, []);
    const jiraRefs = refs.filter((r: any) => r.platform === "jira");
    expect(jiraRefs).toHaveLength(1);
  });

  it("includes references from comments", () => {
    const refs = generator.extractDependencyRefs("Body text.", [
      { body: "Also relates to JIRA:SEC-10." },
    ]);
    const jiraRefs = refs.filter((r: any) => r.platform === "jira");
    expect(jiraRefs).toHaveLength(1);
    expect(jiraRefs[0].issueKey).toBe("SEC-10");
  });
});

describe("extractDependencyMetadata", () => {
  let generator: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../../../src/engineering/ticket-to-task");
    generator = mod.ticketToTaskGenerator;
  });

  it("parses Depends on section with #NNN items", () => {
    const body = "## Depends on:\n- #110\n- #111\n\n## Other section";
    const result = generator.extractDependencyMetadata(body);
    expect(result.dependsOn).toContain("110");
    expect(result.dependsOn).toContain("111");
  });

  it("parses Blocks section with JIRA keys", () => {
    const body = "## Blocks:\n- IR-42\n- PROJ-10\n\n## Other";
    const result = generator.extractDependencyMetadata(body);
    expect(result.blocks).toContain("IR-42");
    expect(result.blocks).toContain("PROJ-10");
  });

  it("parses Depends on section with GH cross-repo refs", () => {
    const body = "## Depends on:\n- GH:redsand/OtherRepo#5\n\n## Next";
    const result = generator.extractDependencyMetadata(body);
    expect(result.dependsOn).toContain("GH:redsand/OtherRepo#5");
  });

  it("returns empty arrays when no sections found", () => {
    const body = "No dependency sections here.\nJust body text.";
    const result = generator.extractDependencyMetadata(body);
    expect(result.dependsOn).toEqual([]);
    expect(result.blocks).toEqual([]);
  });

  it("handles None value in sections", () => {
    const body = "## Depends on: #110\n## Blocks: None\n";
    const result = generator.extractDependencyMetadata(body);
    expect(result.dependsOn.length).toBeGreaterThanOrEqual(0);
  });

  it("parses GL: prefixed items in Depends on section", () => {
    const body = "## Depends on:\n- GL:hawkio/soc-agent#142\n\n## Next";
    const result = generator.extractDependencyMetadata(body);
    expect(result.dependsOn).toContain("GL:hawkio/soc-agent#142");
  });

  it("parses GitLab: prefixed items in Blocks section", () => {
    const body = "## Blocks:\n- GitLab:infra/terraform#7\n\n## Next";
    const result = generator.extractDependencyMetadata(body);
    expect(result.blocks).toContain("GitLab:infra/terraform#7");
  });

  it("parses mixed format items in Depends on", () => {
    const body = [
      "## Depends on:",
      "- #110",
      "- IR-41",
      "- GH:redsand/lib#3",
      "- GL:hawkio/soc-agent#142",
      "",
      "## Blocks:",
      "- #115",
    ].join("\n");
    const result = generator.extractDependencyMetadata(body);
    expect(result.dependsOn).toEqual(["110", "IR-41", "GH:redsand/lib#3", "GL:hawkio/soc-agent#142"]);
    expect(result.blocks).toEqual(["115"]);
  });
});

describe("dependency metadata in generated prompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGithubClient.resolveRepo.mockReturnValue({
      owner: "redsand",
      repo: "AIWorkAssistant",
    });
    mockGithubClient.getIssue.mockResolvedValue({
      number: 112,
      title: "Fix cross-platform dependency detection",
      body: [
        "## Depends on:",
        "- #110",
        "- GH:redsand/OtherRepo#5",
        "",
        "## Blocks:",
        "- #115",
        "- JIRA:SEC-10",
        "",
        "- [ ] Cross-platform refs parsed",
        "",
        "Related to JIRA:IR-41 and GL:hawkio/soc-agent#142.",
      ].join("\n"),
      html_url: "https://github.com/redsand/AIWorkAssistant/issues/112",
      labels: [{ name: "engineering" }, { name: "dependency-chain:safe-eval" }],
      milestone: null,
      assignee: null,
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-02T00:00:00Z",
    });
    mockGithubClient.listIssueComments.mockResolvedValue([]);
    mockGithubClient.searchCode.mockResolvedValue([]);
    mockRoadmapDatabase.listRoadmaps.mockReturnValue([]);
    mockRoadmapDatabase.getMilestones.mockReturnValue([]);
    mockRoadmapDatabase.getItems.mockReturnValue([]);
    mockCodebaseIndexer.getStats.mockReturnValue({ totalChunks: 0 });
    mockCodebaseIndexer.indexCodebase.mockResolvedValue(undefined);
    mockCodebaseIndexer.search.mockReturnValue([]);
  });

  it("populates dependsOn and blocks in metadata", async () => {
    const { ticketToTaskGenerator } = await import(
      "../../../src/engineering/ticket-to-task"
    );

    const result = await ticketToTaskGenerator.generate({
      owner: "redsand",
      repo: "AIWorkAssistant",
      issueNumber: 112,
      agent: "generic",
    });

    expect(result.metadata.dependsOn).toBeDefined();
    expect(result.metadata.blocks).toBeDefined();
    expect(result.metadata.dependsOn).toContain("110");
    expect(result.metadata.dependsOn).toContain("GH:redsand/OtherRepo#5");
    expect(result.metadata.blocks).toContain("115");
    expect(result.metadata.blocks).toContain("JIRA:SEC-10");
  });

  it("extracts dependencyChainLabel from labels", async () => {
    const { ticketToTaskGenerator } = await import(
      "../../../src/engineering/ticket-to-task"
    );

    const result = await ticketToTaskGenerator.generate({
      owner: "redsand",
      repo: "AIWorkAssistant",
      issueNumber: 112,
      agent: "generic",
    });

    expect(result.metadata.dependencyChainLabel).toBe("safe-eval");
  });

  it("sets dependencyChainLabel to null when no matching label", async () => {
    mockGithubClient.getIssue.mockResolvedValue({
      number: 113,
      title: "No chain label",
      body: "Simple issue body.",
      html_url: "https://github.com/redsand/AIWorkAssistant/issues/113",
      labels: [{ name: "bug" }],
      milestone: null,
      assignee: null,
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-02T00:00:00Z",
    });

    const { ticketToTaskGenerator } = await import(
      "../../../src/engineering/ticket-to-task"
    );

    const result = await ticketToTaskGenerator.generate({
      owner: "redsand",
      repo: "AIWorkAssistant",
      issueNumber: 113,
      agent: "generic",
    });

    expect(result.metadata.dependencyChainLabel).toBeNull();
  });

  it("includes dependency ordering section in prompt body", async () => {
    const { ticketToTaskGenerator } = await import(
      "../../../src/engineering/ticket-to-task"
    );

    const result = await ticketToTaskGenerator.generate({
      owner: "redsand",
      repo: "AIWorkAssistant",
      issueNumber: 112,
      agent: "generic",
    });

    expect(result.body).toContain("Dependency Order");
    expect(result.body).toContain("**Depends on:**");
    expect(result.body).toContain("**Blocks:**");
  });

  it("shows 'started immediately' message when no dependencies", async () => {
    mockGithubClient.getIssue.mockResolvedValue({
      number: 114,
      title: "Standalone task",
      body: "No dependencies at all.",
      html_url: "https://github.com/redsand/AIWorkAssistant/issues/114",
      labels: [],
      milestone: null,
      assignee: null,
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-02T00:00:00Z",
    });

    const { ticketToTaskGenerator } = await import(
      "../../../src/engineering/ticket-to-task"
    );

    const result = await ticketToTaskGenerator.generate({
      owner: "redsand",
      repo: "AIWorkAssistant",
      issueNumber: 114,
      agent: "generic",
    });

    expect(result.body).toContain("started immediately");
    expect(result.body).toContain("Nothing");
  });

  it("shows 'DO NOT start' message when dependencies exist", async () => {
    const { ticketToTaskGenerator } = await import(
      "../../../src/engineering/ticket-to-task"
    );

    const result = await ticketToTaskGenerator.generate({
      owner: "redsand",
      repo: "AIWorkAssistant",
      issueNumber: 112,
      agent: "generic",
    });

    expect(result.body).toContain("DO NOT start");
  });

  it("formats numeric dependencies with # prefix and cross-platform refs without #", async () => {
    const { ticketToTaskGenerator } = await import(
      "../../../src/engineering/ticket-to-task"
    );

    const result = await ticketToTaskGenerator.generate({
      owner: "redsand",
      repo: "AIWorkAssistant",
      issueNumber: 112,
      agent: "generic",
    });

    // Numeric deps should have # prefix
    expect(result.body).toContain("  - #110");
    expect(result.body).toContain("  - #115");

    // Cross-platform refs should NOT get an extra # prefix
    expect(result.body).not.toContain("#GH:");
    expect(result.body).not.toContain("#JIRA:");
    expect(result.body).not.toContain("#IR-");
    expect(result.body).not.toContain("#GL:");

    // They should appear as-is
    expect(result.body).toContain("  - GH:redsand/OtherRepo#5");
    expect(result.body).toContain("  - JIRA:SEC-10");
  });

  it("renders each dependency as a separate indented list item", async () => {
    const { ticketToTaskGenerator } = await import(
      "../../../src/engineering/ticket-to-task"
    );

    const result = await ticketToTaskGenerator.generate({
      owner: "redsand",
      repo: "AIWorkAssistant",
      issueNumber: 112,
      agent: "generic",
    });

    // Each item should be on its own line with "  - " indentation
    const depSection = result.body.substring(
      result.body.indexOf("## Dependency Order"),
      result.body.indexOf("## Roadmap Context"),
    );
    expect(depSection).toContain("  - #110");
    expect(depSection).toContain("  - GH:redsand/OtherRepo#5");
    expect(depSection).toContain("  - #115");
    expect(depSection).toContain("  - JIRA:SEC-10");

    // Should NOT have double-bullet like "- **Depends on:** -"
    expect(result.body).not.toContain("**Depends on:** -");
    expect(result.body).not.toContain("**Blocks:** -");
  });

  it("formats GL: dependencies in prompt without # prefix", async () => {
    mockGithubClient.getIssue.mockResolvedValue({
      number: 120,
      title: "GitLab dependency test",
      body: [
        "## Depends on:",
        "- GL:hawkio/soc-agent#142",
        "- GitLab:infra/terraform#7",
        "",
        "## Blocks:",
        "- #200",
      ].join("\n"),
      html_url: "https://github.com/redsand/AIWorkAssistant/issues/120",
      labels: [],
      milestone: null,
      assignee: null,
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-02T00:00:00Z",
    });

    const { ticketToTaskGenerator } = await import(
      "../../../src/engineering/ticket-to-task"
    );

    const result = await ticketToTaskGenerator.generate({
      owner: "redsand",
      repo: "AIWorkAssistant",
      issueNumber: 120,
      agent: "generic",
    });

    // GL refs should appear without extra # prefix
    expect(result.body).toContain("  - GL:hawkio/soc-agent#142");
    expect(result.body).toContain("  - GitLab:infra/terraform#7");
    expect(result.body).not.toContain("#GL:");
    expect(result.body).not.toContain("#GitLab:");

    // Numeric dep should have # prefix
    expect(result.body).toContain("  - #200");
  });
});
