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
      url: "/api/workflow/actions/escalate-hawk-ir-case/execute?approve=true",
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
});
