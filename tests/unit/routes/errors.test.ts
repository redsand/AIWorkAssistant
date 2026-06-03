import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { errorsRoutes } from "../../../src/routes/errors";
import { AgentRunDatabase } from "../../../src/agent-runs/database";
import type { ErrorLogEntry } from "../../../src/observability/error-log";

function createEntry(partial: Partial<ErrorLogEntry>): ErrorLogEntry {
  return {
    id: partial.id || "err-1",
    timestamp: partial.timestamp || new Date().toISOString(),
    severity: partial.severity || "error",
    source: partial.source || "server",
    category: partial.category || "request_error",
    message: partial.message || "request failed",
    fingerprint: partial.fingerprint || "fp-1",
    userId: partial.userId,
    sessionId: partial.sessionId,
    runId: partial.runId,
    context: partial.context,
  };
}

describe("errors route", () => {
  let db: AgentRunDatabase;
  let tmpDir: string;
  let server: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "errors-route-test-"));
    db = new AgentRunDatabase(path.join(tmpDir, "runs.db"));
    server = Fastify();
    server.addHook("preHandler", (request, _reply, done) => {
      const userId = request.headers["x-user-id"] as string | undefined;
      if (userId) request.userId = userId;
      done();
    });
  });

  afterEach(async () => {
    await server.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("requires authentication", async () => {
    await server.register(errorsRoutes, {
      prefix: "/api",
      database: db,
      log: { query: async () => [] },
    });

    const res = await server.inject({ method: "GET", url: "/api/errors" });

    expect(res.statusCode).toBe(401);
  });

  it("returns structured log entries and failed agent runs in one response", async () => {
    const run = db.startRun({
      userId: "web-user",
      mode: "productivity",
      sessionId: "session-1",
      provider: "zai",
      model: "glm-5.1",
    });
    db.failRun(run.id, "Z.ai API bad request: The messages parameter is illegal. Please check the documentation.");

    await server.register(errorsRoutes, {
      prefix: "/api",
      database: db,
      log: {
        query: async () => [
          createEntry({
            id: "err-structured",
            source: "server",
            category: "startup_failed",
            message: "listen EADDRINUSE",
          }),
        ],
      },
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/errors",
      headers: { "x-user-id": "user-1" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((item: ErrorLogEntry) => item.id)).toContain("err-structured");
    expect(body.items.map((item: ErrorLogEntry) => item.id)).toContain(`agent-run:${run.id}`);
    expect(body.summary.some((item: { category: string }) => item.category === "provider_message_payload")).toBe(true);
  });

  it("filters by sessionId", async () => {
    const included = db.startRun({ userId: "web-user", mode: "productivity", sessionId: "keep" });
    const excluded = db.startRun({ userId: "web-user", mode: "productivity", sessionId: "drop" });
    db.failRun(included.id, "model not found");
    db.failRun(excluded.id, "model not found");

    await server.register(errorsRoutes, {
      prefix: "/api",
      database: db,
      log: { query: async () => [] },
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/errors?sessionId=keep",
      headers: { "x-user-id": "user-1" },
    });

    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].runId).toBe(included.id);
  });
});
