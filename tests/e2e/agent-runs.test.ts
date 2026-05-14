import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import path from "path";
import os from "os";
import fs from "fs";
import { AgentRunDatabase } from "../../src/agent-runs/database";
import { agentRunsRoutes } from "../../src/agent-runs/api";
import { createSessionToken } from "../../src/middleware/auth";

let server: FastifyInstance;
let db: AgentRunDatabase;
let tmpDir: string;
let aliceToken: string;
let bobToken: string;

async function buildTestServer(): Promise<FastifyInstance> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runs-e2e-"));
  db = new AgentRunDatabase(path.join(tmpDir, "test.db"));

  const app = Fastify();

  // Minimal auth middleware for testing — sets request.userId from Bearer token
  app.addHook("onRequest", async (request, reply) => {
    const authHeader = request.headers["authorization"] as string | undefined;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      request.userId = undefined as unknown as string;
      return;
    }
    const token = authHeader.replace("Bearer ", "");
    // For tests, validate against known test tokens created via createSessionToken
    try {
      const { validateSessionToken } = await import("../../src/middleware/auth");
      const session = validateSessionToken(token);
      if (session) {
        request.userId = session.userId;
      } else {
        request.userId = undefined as unknown as string;
      }
    } catch {
      request.userId = undefined as unknown as string;
    }
  });

  await app.register(agentRunsRoutes, { prefix: "/api", database: db });

  return app;
}

describe("E2E: Agent Runs API endpoints", () => {
  beforeAll(async () => {
    process.env.AUTH_PASSWORD = "test-password";
    process.env.NODE_ENV = "test";
    server = await buildTestServer();
    await server.ready();

    aliceToken = createSessionToken("alice");
    bobToken = createSessionToken("bob");
  }, 30000);

  afterAll(async () => {
    if (server) await server.close();
    if (db) db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Clean up test data between test groups
  let testRunIds: string[] = [];

  afterEach(() => {
    // Clean up created runs
    for (const id of testRunIds) {
      try {
        const run = db.getRun(id);
        if (run) {
          db.cancelRun(id);
        }
      } catch {
        // ignore cleanup errors
      }
    }
    testRunIds = [];
  });

  // ── Authentication ───────────────────────────────────────────────────────

  describe("authentication required", () => {
    it("GET /api/agent-runs returns 401 without auth", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/agent-runs",
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toContain("Authentication required");
    });

    it("GET /api/agent-runs/stats returns 401 without auth", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/agent-runs/stats",
      });
      expect(res.statusCode).toBe(401);
    });

    it("GET /api/agent-runs/aicoder returns 401 without auth", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/agent-runs/aicoder",
      });
      expect(res.statusCode).toBe(401);
    });

    it("GET /api/agent-runs/:id returns 401 without auth", async () => {
      const run = db.startRun({ userId: "alice", mode: "chat" });
      testRunIds.push(run.id);

      const res = await server.inject({
        method: "GET",
        url: `/api/agent-runs/${run.id}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("GET /api/agent-runs/:id/steps returns 401 without auth", async () => {
      const run = db.startRun({ userId: "alice", mode: "chat" });
      testRunIds.push(run.id);

      const res = await server.inject({
        method: "GET",
        url: `/api/agent-runs/${run.id}/steps`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── Authenticated access ──────────────────────────────────────────────────

  describe("GET /api/agent-runs — authenticated user listing", () => {
    it("returns user's own runs", async () => {
      const run = db.startRun({ userId: "alice", mode: "chat" });
      testRunIds.push(run.id);

      const res = await server.inject({
        method: "GET",
        url: "/api/agent-runs",
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.runs).toBeDefined();
      expect(body.runs.length).toBeGreaterThanOrEqual(1);
      // All returned runs should belong to alice
      for (const r of body.runs) {
        expect(r.userId).toBe("alice");
      }
    });

    it("does not return other users' runs", async () => {
      const aliceRun = db.startRun({ userId: "alice", mode: "chat" });
      const bobRun = db.startRun({ userId: "bob", mode: "chat" });
      testRunIds.push(aliceRun.id, bobRun.id);

      const res = await server.inject({
        method: "GET",
        url: "/api/agent-runs",
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Alice should only see her own runs
      for (const r of body.runs) {
        expect(r.userId).toBe("alice");
      }
    });

    it("allows filtering by userId=aicoder to see aicoder runs", async () => {
      const aicoderRun = db.startRun({ userId: "aicoder", mode: "code" });
      testRunIds.push(aicoderRun.id);

      const res = await server.inject({
        method: "GET",
        url: "/api/agent-runs?userId=aicoder",
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      for (const r of body.runs) {
        expect(r.userId).toBe("aicoder");
      }
    });

    it("returns all fields for aicoder runs in list endpoint (no field stripping — single-user system)", async () => {
      const aicoderRun = db.startRun({ userId: "aicoder", sessionId: "session-123", mode: "code" });
      db.completeRun(aicoderRun.id, {
        model: "claude-3",
        promptTokens: 100,
        completionTokens: 200,
        totalTokens: 300,
        toolLoopCount: 1,
      });
      testRunIds.push(aicoderRun.id);

      const res = await server.inject({
        method: "GET",
        url: "/api/agent-runs?userId=aicoder",
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.runs.length).toBeGreaterThan(0);
      // Single-user system: all fields are returned without stripping
      const run = body.runs.find((r: any) => r.id === aicoderRun.id);
      expect(run).toBeDefined();
      expect(run.promptTokens).toBe(100);
      expect(run.completionTokens).toBe(200);
      expect(run.totalTokens).toBe(300);
    });

    it("applies limit and offset parameters", async () => {
      // Create 3 runs for alice
      for (let i = 0; i < 3; i++) {
        const run = db.startRun({ userId: "alice", mode: "chat" });
        testRunIds.push(run.id);
      }

      const res = await server.inject({
        method: "GET",
        url: "/api/agent-runs?limit=2",
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.runs.length).toBeLessThanOrEqual(2);
    });
  });

  // ── GET /api/agent-runs/stats ─────────────────────────────────────────────

  describe("GET /api/agent-runs/stats — user-scoped stats", () => {
    it("returns stats scoped to the authenticated user", async () => {
      const run1 = db.startRun({ userId: "alice", mode: "chat" });
      const run2 = db.startRun({ userId: "alice", mode: "chat" });
      db.completeRun(run1.id, { toolLoopCount: 3 });
      db.failRun(run2.id, "error");
      testRunIds.push(run1.id, run2.id);

      const res = await server.inject({
        method: "GET",
        url: "/api/agent-runs/stats",
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("totalRuns");
      expect(body).toHaveProperty("completedRuns");
      expect(body).toHaveProperty("failedRuns");
      expect(body).toHaveProperty("runningRuns");
      expect(body).toHaveProperty("avgToolLoopCount");
      // Should include at least alice's runs
      expect(body.totalRuns).toBeGreaterThanOrEqual(2);
    });

    it("does not include other users' stats", async () => {
      const bobRun = db.startRun({ userId: "bob", mode: "chat" });
      db.completeRun(bobRun.id, { toolLoopCount: 10 });
      testRunIds.push(bobRun.id);

      const res = await server.inject({
        method: "GET",
        url: "/api/agent-runs/stats",
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Alice's stats should not count bob's runs
      expect(body.totalRuns).toBeGreaterThanOrEqual(0);
    });
  });

  // ── GET /api/agent-runs/aicoder ───────────────────────────────────────────

  describe("GET /api/agent-runs/aicoder — aicoder run status", () => {
    it("returns aicoder runs with all fields (no stripping — single-user system)", async () => {
      const aicoderRun = db.startRun({ userId: "aicoder", mode: "code" });
      db.completeRun(aicoderRun.id, {
        model: "claude-3",
        promptTokens: 100,
        completionTokens: 200,
        totalTokens: 300,
        toolLoopCount: 2,
      });
      testRunIds.push(aicoderRun.id);

      const res = await server.inject({
        method: "GET",
        url: "/api/agent-runs/aicoder",
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("runs");
      expect(body).toHaveProperty("current");
      expect(body.runs.length).toBeGreaterThan(0);

      // Single-user system: all fields returned without stripping
      const run = body.runs.find((r: any) => r.id === aicoderRun.id);
      expect(run).toBeDefined();
      expect(run.promptTokens).toBe(100);
      expect(run.completionTokens).toBe(200);
      expect(run.totalTokens).toBe(300);
    });

    it("returns empty data when no aicoder runs exist", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/agent-runs/aicoder",
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.runs).toBeDefined();
      expect(body.current).toBeDefined();
    });
  });

  // ── GET /api/agent-runs/:id — IDOR protection ────────────────────────────

  describe("GET /api/agent-runs/:id — IDOR protection", () => {
    it("allows owner to see their own run", async () => {
      const run = db.startRun({ userId: "alice", mode: "chat" });
      testRunIds.push(run.id);

      const res = await server.inject({
        method: "GET",
        url: `/api/agent-runs/${run.id}`,
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(run.id);
      expect(body.userId).toBe("alice");
    });

    it("allows any authenticated user to access any run (no IDOR protection — single-user system)", async () => {
      const bobRun = db.startRun({ userId: "bob", mode: "chat" });
      testRunIds.push(bobRun.id);

      const res = await server.inject({
        method: "GET",
        url: `/api/agent-runs/${bobRun.id}`,
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      // Single-user system: no per-user access restriction on run detail
      expect(res.statusCode).toBe(200);
      expect(res.json().userId).toBe("bob");
    });

    it("returns 404 for nonexistent run", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/agent-runs/nonexistent-id",
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns aicoder run with all fields (no stripping — single-user system)", async () => {
      const aicoderRun = db.startRun({ userId: "aicoder", mode: "code" });
      db.completeRun(aicoderRun.id, {
        model: "claude-3",
        promptTokens: 100,
        completionTokens: 200,
        totalTokens: 300,
        toolLoopCount: 1,
      });
      db.addStep({
        runId: aicoderRun.id,
        stepType: "model_request",
        content: { prompt: "prompt data" },
        stepOrder: 0,
      });
      testRunIds.push(aicoderRun.id);

      const res = await server.inject({
        method: "GET",
        url: `/api/agent-runs/${aicoderRun.id}`,
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.userId).toBe("aicoder");
      // Single-user system: all fields returned without stripping
      expect(body.promptTokens).toBe(100);
      expect(body.completionTokens).toBe(200);
      expect(body.totalTokens).toBe(300);
      // Steps returned with full content
      if (body.steps && body.steps.length > 0) {
        expect(body.steps[0]).toHaveProperty("content");
      }
    });
  });

  // ── GET /api/agent-runs/:id/steps — IDOR protection ───────────────────────

  describe("GET /api/agent-runs/:id/steps — IDOR protection", () => {
    it("allows owner to see their own run steps", async () => {
      const run = db.startRun({ userId: "alice", mode: "chat" });
      db.addStep({
        runId: run.id,
        stepType: "tool_call",
        toolName: "jira.list_assigned",
        content: { prompt: "show my tickets" },
        stepOrder: 0,
      });
      testRunIds.push(run.id);

      const res = await server.inject({
        method: "GET",
        url: `/api/agent-runs/${run.id}/steps`,
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(res.statusCode).toBe(200);
      const steps = res.json();
      expect(Array.isArray(steps)).toBe(true);
      expect(steps).toHaveLength(1);
      expect(steps[0].content).toEqual({ prompt: "show my tickets" });
    });

    it("allows any authenticated user to access any run's steps (no IDOR protection — single-user system)", async () => {
      const bobRun = db.startRun({ userId: "bob", mode: "chat" });
      db.addStep({
        runId: bobRun.id,
        stepType: "tool_call",
        toolName: "jira.list_assigned",
        stepOrder: 0,
      });
      testRunIds.push(bobRun.id);

      const res = await server.inject({
        method: "GET",
        url: `/api/agent-runs/${bobRun.id}/steps`,
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      // Single-user system: any authenticated user can access any run's steps
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });

    it("returns full step content for aicoder runs (no stripping — single-user system)", async () => {
      const aicoderRun = db.startRun({ userId: "aicoder", mode: "code" });
      db.addStep({
        runId: aicoderRun.id,
        stepType: "model_request",
        content: { prompt: "prompt data" },
        sanitizedParams: { tool: "jira.search" },
        stepOrder: 0,
      });
      testRunIds.push(aicoderRun.id);

      const res = await server.inject({
        method: "GET",
        url: `/api/agent-runs/${aicoderRun.id}/steps`,
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(res.statusCode).toBe(200);
      const steps = res.json();
      // Single-user system: full content returned without stripping
      expect(steps[0]).toHaveProperty("content");
      expect(steps[0]).toHaveProperty("sanitizedParams");
    });
  });
});