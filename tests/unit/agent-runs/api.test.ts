import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import Fastify, { FastifyInstance } from "fastify";
import { AgentRunDatabase } from "../../../src/agent-runs/database";
import { agentRunsRoutes } from "../../../src/agent-runs/api";

describe("Agent Runs API Routes", () => {
  let db: AgentRunDatabase;
  let app: FastifyInstance;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runs-api-test-"));
    db = new AgentRunDatabase(path.join(tmpDir, "test.db"));

    app = Fastify();
    // Pass the test database via plugin options for isolation
    await app.register(agentRunsRoutes, { prefix: "/api", database: db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("GET /api/agent-runs", () => {
    it("returns an empty list when no runs exist", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.runs).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("returns runs list with default pagination", async () => {
      db.startRun({ userId: "user1", mode: "chat" });
      db.startRun({ userId: "user2", mode: "agent" });

      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.runs.length).toBe(2);
      expect(body.total).toBe(2);
    });

    it("filters by status", async () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });
      db.startRun({ userId: "user1", mode: "chat" });
      db.completeRun(run.id, { toolLoopCount: 1 });

      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs?status=completed",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.runs.length).toBe(1);
      expect(body.runs[0].status).toBe("completed");
    });

    it("filters by aicoder userId for monitoring", async () => {
      db.startRun({ userId: "aicoder", mode: "agent" });
      db.startRun({ userId: "user1", mode: "chat" });

      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs?userId=aicoder",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.runs.every((r: { userId: string }) => r.userId === "aicoder")).toBe(true);
    });

    it("ignores non-aicoder userId filter for unauthenticated requests", async () => {
      db.startRun({ userId: "user1", mode: "chat" });
      db.startRun({ userId: "user2", mode: "chat" });

      // Without auth, userId other than 'aicoder' is ignored
      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs?userId=user1",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // Should return all runs since non-aicoder userId is ignored without auth
      expect(body.runs.length).toBe(2);
    });

    it("applies limit and offset for pagination", async () => {
      for (let i = 0; i < 5; i++) {
        db.startRun({ userId: "user1", mode: "chat" });
      }

      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs?limit=2&offset=0",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.runs.length).toBe(2);
      expect(body.total).toBe(5);
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
    it("returns run with steps", async () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });
      db.addStep({ runId: run.id, stepType: "model_request", stepOrder: 0 });

      const response = await app.inject({
        method: "GET",
        url: `/api/agent-runs/${run.id}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(run.id);
      expect(body.steps).toHaveLength(1);
    });

    it("returns 404 for nonexistent run", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs/nonexistent-id",
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error).toBe("Run not found");
    });

    it("allows viewing aicoder runs without authentication", async () => {
      const run = db.startRun({ userId: "aicoder", mode: "agent" });
      db.addStep({ runId: run.id, stepType: "model_request", stepOrder: 0 });

      const response = await app.inject({
        method: "GET",
        url: `/api/agent-runs/${run.id}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(run.id);
    });
  });

  describe("GET /api/agent-runs/:id/steps", () => {
    it("returns steps for a run", async () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });
      db.addStep({ runId: run.id, stepType: "model_request", stepOrder: 0 });
      db.addStep({ runId: run.id, stepType: "model_response", stepOrder: 1 });

      const response = await app.inject({
        method: "GET",
        url: `/api/agent-runs/${run.id}/steps`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(2);
      expect(body[0].stepType).toBe("model_request");
      expect(body[1].stepType).toBe("model_response");
    });

    it("returns 404 for nonexistent run", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent-runs/nonexistent-id/steps",
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error).toBe("Run not found");
    });
  });
});