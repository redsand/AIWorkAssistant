import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Verifies the execute endpoint is guarded: when auth is configured, an
// unauthenticated caller must not be able to trigger workflow actions.
let server: FastifyInstance;

describe("Workflow API authentication", () => {
  beforeAll(async () => {
    vi.resetModules();
    process.env.AUTH_PASSWORD = "test-password";
    process.env.AIWORKASSISTANT_API_KEY = "test-api-key";
    process.env.AI_PROVIDER = "opencode";
    process.env.NODE_ENV = "test";
    process.env.PORT = "0";

    const { buildServer } = await import("../../src/server");
    server = await buildServer();
    await server.ready();
  }, 180000);

  afterAll(async () => {
    if (server) await server.close();
  });

  it("rejects an unauthenticated execute request", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/workflow/actions/daily-standup-prep/execute",
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an unauthenticated execute even for an approval-gated action", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/workflow/actions/escalate-hawk-ir-case/execute",
      headers: { "x-approver": "reviewer" },
      payload: { caseId: "CASE-1", escalationReason: "active intrusion" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("allows an execute request with a valid API key", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/workflow/actions/daily-standup-prep/execute",
      headers: { "x-api-key": "test-api-key" },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("running");
  });

  it("rejects self-approval: the authenticated actor cannot be the approver", async () => {
    // The API-key identity resolves to "api-key-user"; naming the same identity
    // as approver is self-approval and must be refused.
    const response = await server.inject({
      method: "POST",
      url: "/api/workflow/actions/escalate-hawk-ir-case/execute",
      headers: { "x-api-key": "test-api-key", "x-approver": "api-key-user" },
      payload: { caseId: "CASE-1", escalationReason: "active intrusion" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("Self-approval not allowed");
  });

  it("allows an approval-gated action when a distinct approver signs off", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/workflow/actions/escalate-hawk-ir-case/execute",
      headers: { "x-api-key": "test-api-key", "x-approver": "second-reviewer" },
      payload: { caseId: "CASE-1", escalationReason: "active intrusion" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().approvedBy).toBe("second-reviewer");
  });

  it("rejects an unauthenticated request to list actions", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/workflow/actions",
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an unauthenticated request for a single action definition", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/workflow/actions/escalate-hawk-ir-case",
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an unauthenticated request to read an execution record", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/workflow/executions/any-id",
    });
    expect(response.statusCode).toBe(401);
  });

  it("allows reading actions with a valid API key", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/workflow/actions",
      headers: { "x-api-key": "test-api-key" },
    });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json().actions)).toBe(true);
  });
});
