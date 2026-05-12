import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockListRuns, mockGetRunWithSteps, mockGetStats } = vi.hoisted(() => ({
  mockListRuns: vi.fn(),
  mockGetRunWithSteps: vi.fn(),
  mockGetStats: vi.fn(), // kept for backward compat; handler no longer uses getStats
}));

// Mock all external dependencies before importing dispatcher
vi.mock("../../../src/config/env", () => ({
  env: {
    JIRA_BASE_URL: "",
    JIRA_EMAIL: "",
    JIRA_API_TOKEN: "",
    GITLAB_BASE_URL: "",
    GITLAB_TOKEN: "",
    GITLAB_WEBHOOK_SECRET: "",
    PORT: 3050,
    NODE_ENV: "test",
    AUTH_USERNAME: "admin",
    AUTH_PASSWORD: "test",
    AUTH_SESSION_SECRET: "test-secret",
    OPENCODE_API_URL: "https://api.opencode.com/v1",
    OPENCODE_API_KEY: "",
    JIRA_PROJECT_KEYS: [],
    ENABLE_CALENDAR_WRITE: false,
    ENABLE_JIRA_TRANSITIONS: true,
    ENABLE_GITLAB_WEBHOOKS: true,
  },
}));

vi.mock("../../../src/audit/logger", () => ({
  auditLogger: {
    log: vi.fn(async () => {}),
  },
}));

vi.mock("../../../src/integrations/codex/codex-client", () => ({
  codexClient: { isConfigured: vi.fn(() => false) },
}));

vi.mock("../../../src/integrations/web/search-client", () => ({
  webSearchClient: { isConfigured: vi.fn(() => false) },
}));

vi.mock("../../../src/integrations/file/calendar-service", () => ({
  fileCalendarService: {
    listEvents: vi.fn(),
    createFocusBlock: vi.fn(),
    createHealthBlock: vi.fn(),
  },
}));

vi.mock("../../../src/integrations/jira/jira-client", () => ({
  jiraClient: {
    isConfigured: vi.fn(() => false),
    getProjects: vi.fn(),
    getProject: vi.fn(),
  },
}));

vi.mock("../../../src/integrations/jira/jira-service", () => ({
  jiraService: {
    getAssignedIssues: vi.fn(),
    getIssue: vi.fn(),
    addComment: vi.fn(),
    transitionIssue: vi.fn(),
    createProject: vi.fn(),
    getProject: vi.fn(),
  },
}));

vi.mock("../../../src/integrations/gitlab/gitlab-client", () => ({
  gitlabClient: {
    isConfigured: vi.fn(() => false),
    getProjects: vi.fn(),
  },
}));

vi.mock("../../../src/integrations/github/github-client", () => ({
  githubClient: { isConfigured: vi.fn(() => false) },
}));

vi.mock("../../../src/integrations/jitbit/jitbit-service", () => ({
  jitbitService: { isConfigured: vi.fn(() => false) },
}));

vi.mock("../../../src/integrations/hawk-ir/hawk-ir-service", () => ({
  hawkIrService: { isConfigured: vi.fn(() => false) },
}));

vi.mock("../../../src/policy/engine", () => ({
  policyEngine: {
    evaluate: vi.fn(async () => ({
      result: "allowed",
      riskLevel: "low",
      reason: "",
      applicablePolicy: "",
    })),
    canProceed: vi.fn(() => true),
    requiresApproval: vi.fn(() => false),
    isBlocked: vi.fn(() => false),
    createApprovalRequest: vi.fn(),
  },
}));

vi.mock("../../../src/approvals/queue", () => ({
  approvalQueue: {
    enqueue: vi.fn(async (r: unknown) => r),
    approve: vi.fn(),
    reject: vi.fn(),
    list: vi.fn(async () => ({ approvals: [], total: 0, filtered: 0 })),
  },
}));

vi.mock("../../../src/productivity/daily-planner", () => ({
  dailyPlanner: { generatePlan: vi.fn() },
}));

vi.mock("../../../src/productivity/weekly-planner", () => ({
  weeklyPlanner: { generatePlan: vi.fn() },
}));

vi.mock("../../../src/cto/daily-command-center", () => ({
  ctoDailyCommandCenter: { generate: vi.fn() },
}));

vi.mock("../../../src/personal-os/brief-generator", () => ({
  personalOsBriefGenerator: { generate: vi.fn() },
}));

vi.mock("../../../src/product/product-chief-of-staff", () => ({
  productChiefOfStaff: { generate: vi.fn() },
}));

vi.mock("../../../src/roadmap/database", () => ({
  roadmapDatabase: {},
}));

vi.mock("../../../src/policy/platform-intent", () => ({
  detectPlatformIntent: vi.fn(() => ({ platform: "productivity", source: "", evidence: [] })),
}));

vi.mock("../../../src/policy/platform-alignment", () => ({
  validatePlatformAlignment: vi.fn(() => ({
    result: "aligned",
    toolPlatform: "productivity",
    intentPlatform: "productivity",
    reason: "",
    suggestedAlternatives: [],
  })),
}));

vi.mock("../../../src/engineering/workflow-brief", () => ({
  workflowBriefGenerator: { generate: vi.fn() },
}));

vi.mock("../../../src/engineering/architecture-planner", () => ({
  architecturePlanner: { generate: vi.fn() },
}));

vi.mock("../../../src/engineering/scaffold-planner", () => ({
  scaffoldPlanner: { generate: vi.fn() },
}));

vi.mock("../../../src/engineering/jira-ticket-generator", () => ({
  jiraTicketGenerator: { generate: vi.fn() },
}));

vi.mock("../../../src/todo-manager", () => ({
  todoManager: {},
}));

vi.mock("../../../src/knowledge-store", () => ({
  knowledgeStore: {},
}));

vi.mock("../../../src/opencode-client", () => ({
  aiClient: { isConfigured: vi.fn(() => false) },
}));

vi.mock("../../../src/work-items/database", () => ({
  workItemDatabase: {},
}));

vi.mock("../../../src/dry-run", () => ({
  dryRunResult: {},
}));

vi.mock("../../../src/workflow-executor", () => ({
  workflowExecutor: {},
}));

vi.mock("../../../src/integrations/mcp", () => ({
  mcpClient: { isConfigured: vi.fn(() => false) },
}));

vi.mock("../../../src/codebase-indexer", () => ({
  codebaseIndexer: {},
}));

vi.mock("../../../src/knowledge-graph", () => ({
  knowledgeGraph: {},
}));

vi.mock("../../../src/memory/entity-memory", () => ({
  entityMemory: {
    findEntities: vi.fn(async () => ({ entities: [], total: 0 })),
    getEntityContext: vi.fn(async () => null),
    addEntityFact: vi.fn(async () => ({})),
  },
}));

vi.mock("../../../src/integrations/lsp/index.js", () => ({
  lspManager: {
    on: vi.fn(),
  },
}));

vi.mock("../../../src/code-review/review-assistant", () => ({
  reviewAssistant: { isConfigured: vi.fn(() => false) },
}));

vi.mock("../../../src/integrations/ticket-bridge/ticket-bridge", () => ({
  ticketBridge: {},
}));

vi.mock("../../../src/agent-runs/database", () => ({
  agentRunDatabase: {
    listRuns: mockListRuns,
    getRunWithSteps: mockGetRunWithSteps,
    getStats: mockGetStats,
  },
  AgentRunDatabase: vi.fn(),
}));

import { dispatchToolCall } from "../../../src/agent/tool-dispatcher";

describe("Agent Runs Handler Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("agent.list_runs", () => {
    it("returns runs scoped to the requesting user", async () => {
      mockListRuns.mockReturnValue({
        runs: [
          { id: "r1", userId: "alice", mode: "chat", status: "completed" },
        ],
        total: 1,
      });

      const result = await dispatchToolCall("agent.list_runs", {}, "alice");
      expect(result.success).toBe(true);
      expect(mockListRuns).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "alice" }),
      );
    });

    it("never passes params.userId to the database (IDOR prevention)", async () => {
      mockListRuns.mockReturnValue({ runs: [], total: 0 });

      // Even if a malicious client sends userId in params, it must be ignored
      const result = await dispatchToolCall(
        "agent.list_runs",
        { userId: "bob" },
        "alice",
      );
      expect(result.success).toBe(true);
      expect(mockListRuns).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "alice" }),
      );
    });

    it("validates limit param: non-numeric strings become undefined", async () => {
      mockListRuns.mockReturnValue({ runs: [], total: 0 });

      const result = await dispatchToolCall(
        "agent.list_runs",
        { limit: "abc", offset: "xyz" },
        "alice",
      );
      expect(result.success).toBe(true);
      expect(mockListRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: undefined,
          offset: undefined,
        }),
      );
    });

    it("validates limit param: clamps to 1-100 range", async () => {
      mockListRuns.mockReturnValue({ runs: [], total: 0 });

      const result = await dispatchToolCall(
        "agent.list_runs",
        { limit: 500, offset: -10 },
        "alice",
      );
      expect(result.success).toBe(true);
      expect(mockListRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 100,
          offset: 0,
        }),
      );
    });

    it("validates status param: only allows running/completed/failed", async () => {
      mockListRuns.mockReturnValue({ runs: [], total: 0 });

      const result = await dispatchToolCall(
        "agent.list_runs",
        { status: "running" },
        "alice",
      );
      expect(result.success).toBe(true);
      expect(mockListRuns).toHaveBeenCalledWith(
        expect.objectContaining({ status: "running" }),
      );
    });

    it("ignores invalid status values", async () => {
      mockListRuns.mockReturnValue({ runs: [], total: 0 });

      const result = await dispatchToolCall(
        "agent.list_runs",
        { status: "invalid_status" },
        "alice",
      );
      expect(result.success).toBe(true);
      expect(mockListRuns).toHaveBeenCalledWith(
        expect.objectContaining({ status: undefined }),
      );
    });

    it("returns structured error on database failure", async () => {
      mockListRuns.mockImplementation(() => {
        throw new Error("Database locked");
      });

      const result = await dispatchToolCall("agent.list_runs", {}, "alice");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to list agent runs");
    });
  });

  describe("agent.get_run", () => {
    it("returns run data for the owning user", async () => {
      mockGetRunWithSteps.mockReturnValue({
        id: "r1",
        userId: "alice",
        mode: "chat",
        status: "completed",
        steps: [],
      });

      const result = await dispatchToolCall(
        "agent.get_run",
        { runId: "r1" },
        "alice",
      );
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it("returns generic not-found for another users run (IDOR protection)", async () => {
      mockGetRunWithSteps.mockReturnValue({
        id: "r1",
        userId: "bob",
        mode: "chat",
        status: "completed",
        steps: [],
      });

      const result = await dispatchToolCall(
        "agent.get_run",
        { runId: "r1" },
        "alice",
      );
      expect(result.success).toBe(false);
      // Must not reveal that the run exists but belongs to someone else
      expect(result.error).toContain("not found");
      expect(result.error).not.toContain("authorized");
    });

    it("returns not-found for nonexistent run", async () => {
      mockGetRunWithSteps.mockReturnValue(null);

      const result = await dispatchToolCall(
        "agent.get_run",
        { runId: "nonexistent" },
        "alice",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("requires runId parameter", async () => {
      const result = await dispatchToolCall(
        "agent.get_run",
        {},
        "alice",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("runId is required");
    });

    it("rejects non-string runId (type validation)", async () => {
      const result = await dispatchToolCall(
        "agent.get_run",
        { runId: 12345 },
        "alice",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("runId is required");
    });

    it("rejects object runId (type validation)", async () => {
      const result = await dispatchToolCall(
        "agent.get_run",
        { runId: { id: "malicious" } },
        "alice",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("runId is required");
    });

    it("returns structured error on database failure", async () => {
      mockGetRunWithSteps.mockImplementation(() => {
        throw new Error("Database corrupted");
      });

      const result = await dispatchToolCall(
        "agent.get_run",
        { runId: "r1" },
        "alice",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to get agent run");
    });
  });

  describe("agent.get_run_stats", () => {
    it("returns user-scoped stats from listRuns", async () => {
      mockListRuns.mockReturnValue({
        runs: [
          { userId: "alice", status: "completed", toolLoopCount: 2 },
          { userId: "alice", status: "completed", toolLoopCount: 4 },
          { userId: "alice", status: "failed", toolLoopCount: 1 },
        ],
        total: 3,
      });

      const result = await dispatchToolCall(
        "agent.get_run_stats",
        {},
        "alice",
      );
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.totalRuns).toBe(3);
      expect(result.data.completedRuns).toBe(2);
      expect(result.data.failedRuns).toBe(1);
      expect(result.data.avgToolLoopCount).toBe(3);
      // Verify listRuns was called with the requesting user's ID (not global)
      expect(mockListRuns).toHaveBeenCalledWith(expect.objectContaining({ userId: "alice" }));
    });

    it("returns structured error on database failure", async () => {
      mockListRuns.mockImplementation(() => {
        throw new Error("Database locked");
      });

      const result = await dispatchToolCall(
        "agent.get_run_stats",
        {},
        "alice",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to get agent run stats");
    });
  });

  describe("agent.get_aicoder_status", () => {
    it("returns empty data when no aicoder runs exist", async () => {
      mockListRuns.mockReturnValue({ runs: [], total: 0 });

      const result = await dispatchToolCall(
        "agent.get_aicoder_status",
        {},
        "alice",
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ runs: [], current: null });
    });

    it("returns aicoder run metadata without step content", async () => {
      const run = {
        id: "ac1",
        sessionId: "s1",
        userId: "aicoder",
        mode: "code",
        model: "claude-3",
        status: "completed",
        errorMessage: null,
        promptTokens: 100,
        completionTokens: 200,
        totalTokens: 300,
        toolLoopCount: 2,
        startedAt: "2025-01-01T00:00:00.000Z",
        lastActivityAt: "2025-01-01T00:01:00.000Z",
        completedAt: "2025-01-01T00:01:00.000Z",
        cancelledAt: null,
      };
      mockListRuns.mockReturnValue({ runs: [run], total: 1 });

      const result = await dispatchToolCall(
        "agent.get_aicoder_status",
        {},
        "alice",
      );
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      // Current should have metadata but not steps
      expect(data.current).toBeDefined();
      expect(data.current).not.toHaveProperty("steps");
      // Sensitive fields should be stripped from current run
      expect(data.current).not.toHaveProperty("promptTokens");
      expect(data.current).not.toHaveProperty("completionTokens");
      expect(data.current).not.toHaveProperty("totalTokens");
      expect(data.current).not.toHaveProperty("sessionId");
      // Runs array should also have sensitive fields stripped
      const runs = data.runs as Record<string, unknown>[];
      for (const run of runs) {
        expect(run).not.toHaveProperty("promptTokens");
        expect(run).not.toHaveProperty("completionTokens");
        expect(run).not.toHaveProperty("totalTokens");
        expect(run).not.toHaveProperty("sessionId");
      }
      // Requesting user should be included
      expect(data.requestingUser).toBe("alice");
    });

    it("returns running aicoder run as current", async () => {
      const runningRun = {
        id: "ac-running",
        sessionId: "s1",
        userId: "aicoder",
        mode: "code",
        model: "claude-3",
        status: "running",
        errorMessage: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        toolLoopCount: 0,
        startedAt: "2025-01-01T00:00:00.000Z",
        lastActivityAt: "2025-01-01T00:00:30.000Z",
        completedAt: null,
        cancelledAt: null,
      };
      const completedRun = {
        id: "ac-completed",
        sessionId: "s2",
        userId: "aicoder",
        mode: "code",
        model: "claude-3",
        status: "completed",
        errorMessage: null,
        promptTokens: 100,
        completionTokens: 200,
        totalTokens: 300,
        toolLoopCount: 2,
        startedAt: "2024-12-31T00:00:00.000Z",
        lastActivityAt: "2024-12-31T00:01:00.000Z",
        completedAt: "2024-12-31T00:01:00.000Z",
        cancelledAt: null,
      };
      mockListRuns.mockReturnValue({
        runs: [runningRun, completedRun],
        total: 2,
      });

      const result = await dispatchToolCall(
        "agent.get_aicoder_status",
        {},
        "alice",
      );
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect((data.current as Record<string, unknown>).status).toBe("running");
    });

    it("returns structured error on database failure", async () => {
      mockListRuns.mockImplementation(() => {
        throw new Error("Database locked");
      });

      const result = await dispatchToolCall(
        "agent.get_aicoder_status",
        {},
        "alice",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to get aicoder status");
    });
  });
});