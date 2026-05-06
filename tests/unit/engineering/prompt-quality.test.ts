import { describe, it, expect, vi, beforeEach } from "vitest";
import { workflowBriefGenerator } from "../../../src/engineering/workflow-brief";
import { architecturePlanner } from "../../../src/engineering/architecture-planner";
import { scaffoldPlanner } from "../../../src/engineering/scaffold-planner";
import type { WorkflowBrief } from "../../../src/engineering/workflow-brief";
import type { ArchitectureProposal } from "../../../src/engineering/architecture-planner";

const MOCK_IDEA =
  "A real-time collaboration tool for remote engineering teams to review code together";

function makeMockResponse(json: unknown) {
  const content = JSON.stringify(json);
  return {
    content,
    toolCalls: undefined,
    usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
    model: "test-model",
    done: true,
  };
}

const VALID_WORKFLOW_BRIEF_JSON = {
  problem:
    "Remote engineering teams lack a real-time collaborative code review tool that supports synchronous discussion",
  users: [
    "Senior engineer who reviews 10+ PRs daily and needs to annotate specific lines in real-time",
    "Junior developer who benefits from live walkthroughs of review feedback",
    "Engineering manager who needs visibility into review bottlenecks",
  ],
  jobsToBeDone: [
    "When I receive a complex PR, I want to walk through it live with the author, so I can explain my concerns interactively",
    "When I'm stuck on review feedback, I want to start a live session, so I can get immediate clarification",
  ],
  currentWorkflow:
    "Developers create PRs, reviewers leave async comments, author responds, cycle repeats 2-3 times",
  desiredWorkflow:
    "Developer creates PR, AI suggests optimal review time, reviewer joins live session, issues resolved in real-time",
  frictionPoints: [
    "Async review cycles take 2-3 days on average",
    "Comment threads lose context without live discussion",
    "No way to point at specific code interactively",
  ],
  decisions: [
    "Whether to use WebRTC or WebSocket for real-time communication",
    "Whether to integrate with existing Git providers or build standalone",
  ],
  inputs: [
    "Git diff data",
    "User presence status",
    "Cursor positions",
    "Comments",
  ],
  outputs: ["Review decisions", "Comment threads", "Session recordings"],
  states: [
    "draft",
    "awaiting_review",
    "in_review",
    "changes_requested",
    "approved",
  ],
  transitions: ["submit", "start_review", "request_changes", "approve"],
  edgeCases: [
    "User disconnects mid-session",
    "Merge conflict during review",
    "Large diffs timing out",
  ],
  humanInTheLoop: [
    "Final approval decision",
    "Conflict resolution",
    "Architecture discussion",
  ],
  automationOpportunities: [
    "Auto-schedule review sessions",
    "AI-assisted code analysis",
    "Auto-assign reviewers",
  ],
  guardrails: [
    "Max session duration",
    "Auto-save on disconnect",
    "Rate limiting for comments",
  ],
};

const VALID_ARCHITECTURE_JSON = {
  recommendedStack: {
    backend: "TypeScript + Fastify v4",
    frontend: "React 18 + TypeScript",
    database: "PostgreSQL 15 with JSONB for session data",
    queue: "Redis 7 + BullMQ for session management",
    cache: "Redis for real-time cursor positions",
  },
  systemBoundaries: [
    "WebSocket Gateway — handles real-time connections, cursor sync, presence",
    "Review Service — manages review sessions, comments, decisions",
    "Git Integration Service — fetches diffs, posts comments back to Git provider",
  ],
  dataModel:
    "Users (id, email, name), Reviews (id, pr_url, status, created_at), Sessions (id, review_id, started_at, ended_at), Comments (id, session_id, user_id, line, content, timestamp)",
  apiDesign:
    "REST for CRUD + WebSocket for real-time. POST /reviews, GET /reviews/:id, WS /reviews/:id/live",
  eventModel:
    "SessionStarted, CursorMoved, CommentAdded, ReviewCompleted, UserJoined, UserLeft",
  backgroundJobs: [
    "Session cleanup (every 5 min)",
    "Recording processing",
    "Git sync",
  ],
  integrations: [
    "GitHub API (REST)",
    "GitLab API (REST)",
    "VS Code Extension (LSP)",
  ],
  authStrategy: "OAuth 2.0 via Git provider + JWT for WebSocket auth",
  errorHandling:
    "Circuit breaker for Git APIs, exponential backoff, dead letter queue for failed events",
  observability:
    "OpenTelemetry traces, Prometheus metrics, structured JSON logging",
  deploymentModel:
    "Docker containers on Kubernetes, WebSocket via sticky sessions",
  security: "TLS 1.3, input sanitization, rate limiting, audit logging",
  privacy:
    "Session data encrypted at rest, auto-purge after 90 days, GDPR export",
  testingStrategy:
    "Unit tests for business logic, integration tests for WebSocket, E2E with Playwright",
};

const VALID_SCAFFOLD_JSON = {
  repoStructure: [
    "src/",
    "src/server.ts",
    "src/config/env.ts",
    "src/routes/",
    "src/services/",
    "src/websocket/",
    "tests/",
    "docker/",
    ".github/workflows/",
  ],
  packages: [
    "fastify@4.25.0",
    "@fastify/websocket@8.0.0",
    "ioredis@5.3.0",
    "better-sqlite3@9.4.0",
  ],
  envConfig: [
    "PORT=3000 — Server port (number, required)",
    "DATABASE_URL — PostgreSQL connection string (string, required)",
  ],
  scripts: [
    "dev — tsx watch src/server.ts",
    "build — tsc",
    "test — vitest run",
    "lint — eslint src/",
  ],
  dockerSetup: "FROM node:20-alpine AS builder...",
  migrations: ["001_create_users.sql", "002_create_reviews.sql"],
  seedData: ["seed_dev_users.sql"],
  testSetup: "Vitest with globals: true, environment: node",
  linting: "ESLint with @typescript-eslint/recommended",
  formatting: "Prettier with printWidth: 100, singleQuote: true",
  ciPipeline: "GitHub Actions: lint → typecheck → test → build → deploy",
  docsStructure: ["README.md", "docs/architecture.md", "docs/api.md"],
};

describe("Engineering Prompt Quality", () => {
  let chatSpy: any;

  beforeEach(() => {
    chatSpy = vi.fn();
    vi.resetModules();
  });

  describe("WorkflowBriefGenerator", () => {
    it("should parse a valid JSON response from AI", async () => {
      chatSpy.mockResolvedValue(makeMockResponse(VALID_WORKFLOW_BRIEF_JSON));

      vi.doMock("../../../src/agent/opencode-client", () => ({
        aiClient: {
          isConfigured: () => true,
          chat: chatSpy,
        },
      }));

      const { workflowBriefGenerator: gen } =
        await import("../../../src/engineering/workflow-brief");
      const result = await gen.generate(MOCK_IDEA);

      expect(result.problem).toBeTypeOf("string");
      expect(result.problem.length).toBeGreaterThan(10);
      expect(result.users).toBeInstanceOf(Array);
      expect(result.users.length).toBeGreaterThanOrEqual(2);
      expect(result.jobsToBeDone).toBeInstanceOf(Array);
      expect(result.jobsToBeDone.length).toBeGreaterThanOrEqual(2);
      expect(result.frictionPoints).toBeInstanceOf(Array);
      expect(result.decisions).toBeInstanceOf(Array);
      expect(result.states).toBeInstanceOf(Array);
      expect(result.transitions).toBeInstanceOf(Array);
      expect(result.edgeCases).toBeInstanceOf(Array);
      expect(result.humanInTheLoop).toBeInstanceOf(Array);
      expect(result.automationOpportunities).toBeInstanceOf(Array);
      expect(result.guardrails).toBeInstanceOf(Array);
    });

    it("should return valid fallback when AI is not configured", async () => {
      vi.doMock("../../../src/agent/opencode-client", () => ({
        aiClient: { isConfigured: () => false, chat: chatSpy },
      }));

      const { workflowBriefGenerator: gen } =
        await import("../../../src/engineering/workflow-brief");
      const result = await gen.generate("test idea");

      expect(result.problem).toContain("test idea");
      expect(result.users.length).toBeGreaterThan(0);
      expect(result.frictionPoints.length).toBeGreaterThan(0);
    });

    it("should handle AI response wrapped in markdown code fences", async () => {
      const wrappedContent =
        "```json\n" + JSON.stringify(VALID_WORKFLOW_BRIEF_JSON) + "\n```";
      chatSpy.mockResolvedValue({
        content: wrappedContent,
        toolCalls: undefined,
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        model: "test",
        done: true,
      });

      vi.doMock("../../../src/agent/opencode-client", () => ({
        aiClient: { isConfigured: () => true, chat: chatSpy },
      }));

      const { workflowBriefGenerator: gen } =
        await import("../../../src/engineering/workflow-brief");
      const result = await gen.generate(MOCK_IDEA);

      expect(result.problem).toBe(VALID_WORKFLOW_BRIEF_JSON.problem);
      expect(result.users).toEqual(VALID_WORKFLOW_BRIEF_JSON.users);
    });

    it("should validate prompt sends correct system instructions", async () => {
      chatSpy.mockResolvedValue(makeMockResponse(VALID_WORKFLOW_BRIEF_JSON));

      vi.doMock("../../../src/agent/opencode-client", () => ({
        aiClient: { isConfigured: () => true, chat: chatSpy },
      }));

      const { workflowBriefGenerator: gen } =
        await import("../../../src/engineering/workflow-brief");
      await gen.generate(MOCK_IDEA);

      const call = chatSpy.mock.calls[0][0];
      const systemMsg = call.messages[0];

      expect(systemMsg.role).toBe("system");
      expect(systemMsg.content).toContain("JSON");
      expect(systemMsg.content).toContain("problem");
      expect(systemMsg.content).toContain("users");
      expect(systemMsg.content).toContain("jobsToBeDone");
      expect(systemMsg.content).toContain("frictionPoints");
      expect(systemMsg.content).toContain("decisions");
      expect(systemMsg.content).toContain("edgeCases");
      expect(systemMsg.content).toContain("guardrails");
      expect(systemMsg.content.length).toBeGreaterThan(500);
    });
  });

  describe("ArchitecturePlanner", () => {
    it("should parse a valid architecture JSON response", async () => {
      chatSpy.mockResolvedValue(makeMockResponse(VALID_ARCHITECTURE_JSON));

      vi.doMock("../../../src/agent/opencode-client", () => ({
        aiClient: { isConfigured: () => true, chat: chatSpy },
      }));

      const { architecturePlanner: planner } =
        await import("../../../src/engineering/architecture-planner");

      const brief: WorkflowBrief = VALID_WORKFLOW_BRIEF_JSON as WorkflowBrief;
      const result = await planner.generate(brief);

      expect(result.recommendedStack).toBeDefined();
      expect(result.recommendedStack.backend).toBeTruthy();
      expect(result.systemBoundaries).toBeInstanceOf(Array);
      expect(result.systemBoundaries.length).toBeGreaterThanOrEqual(2);
      expect(result.dataModel).toBeTypeOf("string");
      expect(result.apiDesign).toBeTypeOf("string");
      expect(result.authStrategy).toBeTypeOf("string");
      expect(result.testingStrategy).toBeTypeOf("string");
    });

    it("should validate prompt includes all required fields", async () => {
      chatSpy.mockResolvedValue(makeMockResponse(VALID_ARCHITECTURE_JSON));

      vi.doMock("../../../src/agent/opencode-client", () => ({
        aiClient: { isConfigured: () => true, chat: chatSpy },
      }));

      const { architecturePlanner: planner } =
        await import("../../../src/engineering/architecture-planner");

      await planner.generate(VALID_WORKFLOW_BRIEF_JSON as WorkflowBrief);

      const call = chatSpy.mock.calls[0][0];
      const systemMsg = call.messages[0];

      expect(systemMsg.content).toContain("recommendedStack");
      expect(systemMsg.content).toContain("systemBoundaries");
      expect(systemMsg.content).toContain("dataModel");
      expect(systemMsg.content).toContain("apiDesign");
      expect(systemMsg.content).toContain("authStrategy");
      expect(systemMsg.content).toContain("errorHandling");
      expect(systemMsg.content).toContain("testingStrategy");
    });

    it("should return valid fallback when AI is not configured", async () => {
      vi.doMock("../../../src/agent/opencode-client", () => ({
        aiClient: { isConfigured: () => false, chat: chatSpy },
      }));

      const { architecturePlanner: planner } =
        await import("../../../src/engineering/architecture-planner");

      const result = await planner.generate(
        VALID_WORKFLOW_BRIEF_JSON as WorkflowBrief,
      );

      expect(result.recommendedStack.backend).toBeTruthy();
      expect(result.systemBoundaries.length).toBeGreaterThan(0);
    });
  });

  describe("ScaffoldPlanner", () => {
    it("should parse a valid scaffold JSON response", async () => {
      chatSpy.mockResolvedValue(makeMockResponse(VALID_SCAFFOLD_JSON));

      vi.doMock("../../../src/agent/opencode-client", () => ({
        aiClient: { isConfigured: () => true, chat: chatSpy },
      }));

      const { scaffoldPlanner: planner } =
        await import("../../../src/engineering/scaffold-planner");

      const arch: ArchitectureProposal =
        VALID_ARCHITECTURE_JSON as ArchitectureProposal;
      const result = await planner.generate(arch);

      expect(result.repoStructure).toBeInstanceOf(Array);
      expect(result.repoStructure.length).toBeGreaterThan(3);
      expect(result.packages).toBeInstanceOf(Array);
      expect(result.packages.length).toBeGreaterThan(0);
      expect(result.dockerSetup).toBeTypeOf("string");
      expect(result.testSetup).toBeTypeOf("string");
      expect(result.ciPipeline).toBeTypeOf("string");
    });

    it("should validate prompt demands specific output", async () => {
      chatSpy.mockResolvedValue(makeMockResponse(VALID_SCAFFOLD_JSON));

      vi.doMock("../../../src/agent/opencode-client", () => ({
        aiClient: { isConfigured: () => true, chat: chatSpy },
      }));

      const { scaffoldPlanner: planner } =
        await import("../../../src/engineering/scaffold-planner");

      await planner.generate(VALID_ARCHITECTURE_JSON as ArchitectureProposal);

      const call = chatSpy.mock.calls[0][0];
      const systemMsg = call.messages[0];

      expect(systemMsg.content).toContain("repoStructure");
      expect(systemMsg.content).toContain("packages");
      expect(systemMsg.content).toContain("dockerSetup");
      expect(systemMsg.content).toContain("ciPipeline");
      expect(systemMsg.content).toContain("SPECIFIC");
    });
  });

  describe("JSON Parsing Robustness", () => {
    it("should handle partial JSON with missing fields gracefully", async () => {
      const partialJson = { problem: "test", users: ["user1"] };
      chatSpy.mockResolvedValue(makeMockResponse(partialJson));

      vi.doMock("../../../src/agent/opencode-client", () => ({
        aiClient: { isConfigured: () => true, chat: chatSpy },
      }));

      const { workflowBriefGenerator: gen } =
        await import("../../../src/engineering/workflow-brief");
      const result = await gen.generate("test");

      expect(result.problem).toBe("test");
      expect(result.users).toEqual(["user1"]);
      expect(result.jobsToBeDone).toEqual([]);
      expect(result.frictionPoints).toEqual([]);
    });

    it("should fall back when AI response has extra text around JSON", async () => {
      const messyContent =
        "Here's the workflow brief:\n\n" +
        JSON.stringify(VALID_WORKFLOW_BRIEF_JSON) +
        "\n\nLet me know if you need more details!";

      chatSpy.mockResolvedValue({
        content: messyContent,
        toolCalls: undefined,
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        model: "test",
        done: true,
      });

      vi.doMock("../../../src/agent/opencode-client", () => ({
        aiClient: { isConfigured: () => true, chat: chatSpy },
      }));

      const { workflowBriefGenerator: gen } = await import(
        "../../../src/engineering/workflow-brief"
      );
      const result = await gen.generate("test idea");

      expect(result.problem).toContain("test idea");
      expect(result.users.length).toBeGreaterThan(0);
    });

    it("should fall back gracefully when AI client returns undefined", async () => {
      // chatSpy returns undefined by default (vi.fn()); generator has a fallback
      vi.doMock("../../../src/agent/opencode-client", () => ({
        aiClient: { isConfigured: () => true, chat: chatSpy },
      }));

      const { workflowBriefGenerator: gen } =
        await import("../../../src/engineering/workflow-brief");

      const result = await gen.generate("test");
      expect(result).toBeDefined();
      expect(result.problem).toBeDefined();
    });

    it("should fall back gracefully on completely invalid JSON", async () => {
      chatSpy.mockResolvedValue({
        content: "I cannot generate a workflow brief for this idea.",
        toolCalls: undefined,
        usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
        model: "test",
        done: true,
      });

      vi.doMock("../../../src/agent/opencode-client", () => ({
        aiClient: { isConfigured: () => true, chat: chatSpy },
      }));

      const { workflowBriefGenerator: gen } =
        await import("../../../src/engineering/workflow-brief");
      const result = await gen.generate("test idea");

      expect(result.problem).toContain("test idea");
      expect(result.users.length).toBeGreaterThan(0);
    });
  });
});
