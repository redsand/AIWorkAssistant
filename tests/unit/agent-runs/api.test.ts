import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import Fastify, { FastifyInstance } from "fastify";
import { AgentRunDatabase } from "../../../src/agent-runs/database";
import { agentRunsRoutes } from "../../../src/agent-runs/api";

/**
 * Helper to create a Fastify app with a simulated auth middleware that
 * populates request.userId from the X-User-Id header.
 */
function createApp(db: AgentRunDatabase): FastifyInstance {
  const app = Fastify();
  // Simulate auth middleware by reading X-User-Id header
  app.addHook("preHandler", (request, _reply, done) => {
    const userId = request.headers["x-user-id"] as string | undefined;
    if (userId) {
      (request as any).userId = userId;
    }
    done();
  });
  return app;
}

describe("Agent Runs API Routes", () => {
  let db: AgentRunDatabase;
  let app: FastifyInstance;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runs-api-test-"));
    db = new AgentRunDatabase(path.join(tmpDir, "test.db"));

    app = createApp(db);
    await app.register(agentRunsRoutes, { prefix: "/api", database: db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("GET /api/agent-runs", () => {
    it("returns 401 when unauthenticated", async () => {
      db.startRun({ userId: "user1", mode: "chat" });

      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs",
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe("Authentication required");
    });

    it("returns only the authenticated user's runs", async () => {
      db.startRun({ userId: "user1", mode: "chat" });
      db.startRun({ userId: "user2", mode: "chat" });

      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs",
        headers: { "x-user-id": "user1" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.runs).toHaveLength(1);
      expect(body.runs[0].userId).toBe("user1");
      expect(body.total).toBe(1);
    });

    it("allows authenticated users to view aicoder runs", async () => {
      db.startRun({ userId: "aicoder", mode: "agent" });
      db.startRun({ userId: "user1", mode: "chat" });

      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs?userId=aicoder",
        headers: { "x-user-id": "user1" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.runs.every((r: { userId: string }) => r.userId === "aicoder")).toBe(true);
    });

    it("filters by status", async () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });
      db.startRun({ userId: "user1", mode: "chat" });
      db.completeRun(run.id, { toolLoopCount: 1 });

      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs?status=completed",
        headers: { "x-user-id": "user1" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.runs.length).toBe(1);
      expect(body.runs[0].status).toBe("completed");
    });

    it("applies limit and offset for pagination", async () => {
      for (let i = 0; i < 5; i++) {
        db.startRun({ userId: "user1", mode: "chat" });
      }

      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs?limit=2&offset=0",
        headers: { "x-user-id": "user1" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.runs.length).toBe(2);
      expect(body.total).toBe(5);
    });

    it("rejects non-numeric limit values by falling back to default", async () => {
      db.startRun({ userId: "user1", mode: "chat" });

      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs?limit=abc",
        headers: { "x-user-id": "user1" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // Falls back to default limit of 50
      expect(body.runs.length).toBe(1);
    });

    it("rejects non-numeric offset values by falling back to default", async () => {
      db.startRun({ userId: "user1", mode: "chat" });

      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs?offset=xyz",
        headers: { "x-user-id": "user1" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // Falls back to default offset of 0
      expect(body.runs.length).toBe(1);
    });

    it("scopes non-aicoder userId filter to requesting user", async () => {
      db.startRun({ userId: "alice", mode: "chat" });
      db.startRun({ userId: "bob", mode: "chat" });

      // Requesting as alice — should only see alice's runs regardless of userId param
      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs",
        headers: { "x-user-id": "alice" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.runs).toHaveLength(1);
      expect(body.runs[0].userId).toBe("alice");
    });
  });

  describe("GET /api/agent-runs/stats", () => {
    it("returns aggregate statistics", async () => {
      db.startRun({ userId: "user1", mode: "chat" });

      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs/stats",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.totalRuns).toBe(1);
      expect(body.runningRuns).toBe(1);
    });
  });

  describe("GET /api/agent-runs/aicoder", () => {
    it("returns empty when no aicoder runs exist", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs/aicoder",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.runs).toEqual([]);
      expect(body.current).toBeNull();
    });

    it("returns aicoder runs with stripped step content", async () => {
      const run = db.startRun({ userId: "aicoder", mode: "agent" });
      db.addStep({
        runId: run.id,
        stepType: "model_request",
        content: { prompt: "sensitive data" },
        stepOrder: 0,
      });
      db.addStep({
        runId: run.id,
        stepType: "tool_result",
        toolName: "read_file",
        sanitizedParams: { path: "/secret/file" },
        content: { output: "secret content" },
        stepOrder: 1,
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs/aicoder",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.runs.length).toBe(1);
      expect(body.current).not.toBeNull();
      // Verify step content is stripped (no content/sanitizedParams fields)
      if (body.current && body.current.steps) {
        for (const step of body.current.steps) {
          expect(step).not.toHaveProperty("content");
          expect(step).not.toHaveProperty("sanitizedParams");
        }
      }
    });
  });

  describe("GET /api/agent-runs/:id", () => {
    it("returns 401 when unauthenticated", async () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });

      const response = await app.inject({
        method: "GET",
        url: `/api/agent-runs/${run.id}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it("returns 403 when accessing another user's run", async () => {
      const run = db.startRun({ userId: "alice", mode: "chat" });

      const response = await app.inject({
        method: "GET",
        url: `/api/agent-runs/${run.id}`,
        headers: { "x-user-id": "bob" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toContain("Not authorized");
    });

    it("returns own run with full steps when authenticated as owner", async () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });
      db.addStep({ runId: run.id, stepType: "model_request", stepOrder: 0 });

      const response = await app.inject({
        method: "GET",
        url: `/api/agent-runs/${run.id}`,
        headers: { "x-user-id": "user1" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(run.id);
      expect(body.steps).toHaveLength(1);
      // Owner gets full step content
      expect(body.steps[0].content).toBeDefined();
    });

    it("returns aicoder run with stripped steps for any authenticated user", async () => {
      const run = db.startRun({ userId: "aicoder", mode: "agent" });
      db.addStep({
        runId: run.id,
        stepType: "model_request",
        content: { prompt: "sensitive prompt data" },
        stepOrder: 0,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/agent-runs/${run.id}`,
        headers: { "x-user-id": "user1" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(run.id);
      // aicoder runs have stripped step content
      expect(body.steps[0]).not.toHaveProperty("content");
      expect(body.steps[0]).not.toHaveProperty("sanitizedParams");
    });

    it("returns 404 for nonexistent run", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs/nonexistent-id",
        headers: { "x-user-id": "user1" },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error).toBe("Run not found");
    });

    it("prevents IDOR: unauthenticated user cannot view any run", async () => {
      const run = db.startRun({ userId: "alice", mode: "chat" });
      db.addStep({ runId: run.id, stepType: "model_request", stepOrder: 0 });

      const response = await app.inject({
        method: "GET",
        url: `/api/agent-runs/${run.id}`,
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("GET /api/agent-runs/:id/steps", () => {
    it("returns 401 when unauthenticated", async () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });

      const response = await app.inject({
        method: "GET",
        url: `/api/agent-runs/${run.id}/steps`,
      });

      expect(response.statusCode).toBe(401);
    });

    it("returns 403 when accessing another user's run steps", async () => {
      const run = db.startRun({ userId: "alice", mode: "chat" });

      const response = await app.inject({
        method: "GET",
        url: `/api/agent-runs/${run.id}/steps`,
        headers: { "x-user-id": "bob" },
      });

      expect(response.statusCode).toBe(403);
    });

    it("returns own steps with full content when authenticated as owner", async () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });
      db.addStep({ runId: run.id, stepType: "model_request", stepOrder: 0 });
      db.addStep({ runId: run.id, stepType: "model_response", stepOrder: 1 });

      const response = await app.inject({
        method: "GET",
        url: `/api/agent-runs/${run.id}/steps`,
        headers: { "x-user-id": "user1" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(2);
      expect(body[0].stepType).toBe("model_request");
      expect(body[1].stepType).toBe("model_response");
      // Owner sees full content
      expect(body[0].content).toBeDefined();
    });

    it("returns stripped steps for aicoder runs", async () => {
      const run = db.startRun({ userId: "aicoder", mode: "agent" });
      db.addStep({
        runId: run.id,
        stepType: "model_request",
        content: { prompt: "secret" },
        stepOrder: 0,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/agent-runs/${run.id}/steps`,
        headers: { "x-user-id": "user1" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      // aicoder steps have stripped content
      expect(body[0]).not.toHaveProperty("content");
      expect(body[0]).not.toHaveProperty("sanitizedParams");
    });

    it("returns 404 for nonexistent run", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs/nonexistent-id/steps",
        headers: { "x-user-id": "user1" },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error).toBe("Run not found");
    });

    it("prevents IDOR: unauthenticated user cannot view any steps", async () => {
      const run = db.startRun({ userId: "alice", mode: "chat" });
      db.addStep({ runId: run.id, stepType: "model_request", stepOrder: 0 });

      const response = await app.inject({
        method: "GET",
        url: `/api/agent-runs/${run.id}/steps`,
      });

      expect(response.statusCode).toBe(401);
    });
  });
});