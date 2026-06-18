import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Verifies the execute endpoint is guarded: when auth is configured, an
// unauthenticated caller must not be able to trigger workflow actions.
let server: FastifyInstance;
// A real, validated session token for a *distinct* approver identity. The
// approver must prove ownership of its own session rather than asserting a name
// via a header, so the tests mint a genuine token via createSessionToken.
let approverToken: string;

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

    const { createSessionToken } = await import("../../src/middleware/auth");
    approverToken = createSessionToken("second-reviewer");
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
      headers: { "x-approver-token": approverToken },
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

  it("rejects an unverified approver: a self-asserted header cannot stand in for a session", async () => {
    // An arbitrary, unauthenticated approver token must be refused. The approver
    // identity is derived only from a validated session — a spoofed value can
    // never satisfy the separation-of-duties gate.
    const response = await server.inject({
      method: "POST",
      url: "/api/workflow/actions/escalate-hawk-ir-case/execute",
      headers: {
        "x-api-key": "test-api-key",
        "x-approver-token": "not-a-real-session-token",
      },
      payload: { caseId: "CASE-1", escalationReason: "active intrusion" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("Invalid approver credentials");
  });

  it("rejects self-approval: the authenticated actor cannot be the approver", async () => {
    // The actor authenticates as a session for "api-key-user"; presenting that
    // same identity's session token as approver is self-approval and refused.
    const { createSessionToken } = await import("../../src/middleware/auth");
    const selfToken = createSessionToken("api-key-user");
    const response = await server.inject({
      method: "POST",
      url: "/api/workflow/actions/escalate-hawk-ir-case/execute",
      headers: {
        "x-api-key": "test-api-key",
        "x-approver-token": selfToken,
      },
      payload: { caseId: "CASE-1", escalationReason: "active intrusion" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("Self-approval not allowed");
  });

  it("allows an approval-gated action when a distinct, verified approver signs off", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/workflow/actions/escalate-hawk-ir-case/execute",
      headers: {
        "x-api-key": "test-api-key",
        "x-approver-token": approverToken,
      },
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

  it("lets the triggering actor read their own execution record", async () => {
    const { createSessionToken } = await import("../../src/middleware/auth");
    const aliceToken = createSessionToken("alice");

    const start = await server.inject({
      method: "POST",
      url: "/api/workflow/actions/daily-standup-prep/execute",
      headers: { "x-api-key": aliceToken },
      payload: {},
    });
    expect(start.statusCode).toBe(200);
    const { id } = start.json();

    const read = await server.inject({
      method: "GET",
      url: `/api/workflow/executions/${id}`,
      headers: { "x-api-key": aliceToken },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().id).toBe(id);
  });

  it("forbids a different identity from reading someone else's execution", async () => {
    const { createSessionToken } = await import("../../src/middleware/auth");
    const aliceToken = createSessionToken("alice");
    const malloryToken = createSessionToken("mallory");

    const start = await server.inject({
      method: "POST",
      url: "/api/workflow/actions/daily-standup-prep/execute",
      headers: { "x-api-key": aliceToken },
      payload: {},
    });
    const { id } = start.json();

    const read = await server.inject({
      method: "GET",
      url: `/api/workflow/executions/${id}`,
      headers: { "x-api-key": malloryToken },
    });
    expect(read.statusCode).toBe(403);
    expect(read.json().error).toBe("Forbidden");
  });
});
