import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../../src/middleware/auth", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isAuthConfigured: () => false,
    getApiKeyForAuth: () => "",
    // Bypass the per-route guard here — these tests exercise workflow logic.
    // Auth enforcement is covered separately in workflow-auth.test.ts.
    requireAuth: () => true,
    authPreHandler: async () => {},
  };
});

describe("Workflow API", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    const { buildServer } = await import("../../src/server");
    server = await buildServer();
    await server.ready();
  }, 120000);

  afterAll(async () => {
    if (server) await server.close();
  });

  describe("GET /api/workflow/actions", () => {
    it("returns the list of built-in workflow actions", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/workflow/actions",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.actions)).toBe(true);
      expect(body.actions.length).toBeGreaterThanOrEqual(4);
      const standup = body.actions.find(
        (a: { id: string }) => a.id === "daily-standup-prep",
      );
      expect(standup).toBeDefined();
      expect(standup.riskLevel).toBe("low");
      expect(standup.approvalRequired).toBe(false);
    });
  });

  describe("GET /api/workflow/actions/:id", () => {
    it("returns a single action with its params and steps", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/workflow/actions/escalate-hawk-ir-case",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe("escalate-hawk-ir-case");
      expect(body.approvalRequired).toBe(true);
      expect(Array.isArray(body.params)).toBe(true);
      expect(Array.isArray(body.steps)).toBe(true);
    });

    it("returns 404 for an unknown action", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/workflow/actions/not-a-real-action",
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe("POST /api/workflow/actions/:id/execute", () => {
    it("starts an execution for a valid action", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/workflow/actions/triage-support-ticket/execute",
        payload: { ticketId: 99 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.actionId).toBe("triage-support-ticket");
      expect(body.status).toBe("running");
      expect(body.id).toBeTruthy();
    });

    it("returns 400 when a required parameter is missing", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/workflow/actions/triage-support-ticket/execute",
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it("returns 404 for an unknown action", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/workflow/actions/nope/execute",
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    });

    it("blocks an approval-required action without an approver", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/workflow/actions/escalate-hawk-ir-case/execute",
        payload: { caseId: "CASE-1", escalationReason: "active intrusion" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe("Approval required");
    });

    it("allows an approval-required action with a distinct, verified approver", async () => {
      // The approver proves identity with a real session token (auth is mocked
      // off here so the actor resolves to "unknown" — the approver "reviewer" is
      // a verified, distinct identity).
      const { createSessionToken } = await import("../../src/middleware/auth");
      const reviewerToken = createSessionToken("reviewer");
      const response = await server.inject({
        method: "POST",
        url: "/api/workflow/actions/escalate-hawk-ir-case/execute",
        headers: { "x-approver-token": reviewerToken },
        payload: { caseId: "CASE-1", escalationReason: "active intrusion" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.actionId).toBe("escalate-hawk-ir-case");
      expect(body.status).toBe("running");
      expect(body.approvedBy).toBe("reviewer");
    });

    it("rejects an approval-required action when the approver token is invalid", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/workflow/actions/escalate-hawk-ir-case/execute",
        headers: { "x-approver-token": "bogus-token" },
        payload: { caseId: "CASE-1", escalationReason: "active intrusion" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe("Invalid approver credentials");
    });

    it("rejects a non-object body", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/workflow/actions/daily-standup-prep/execute",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify("not-an-object"),
      });
      expect(response.statusCode).toBe(400);
    });

    it("returns 400 when a parameter has the wrong type", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/workflow/actions/triage-support-ticket/execute",
        payload: { ticketId: "not-a-number" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toMatch(/expected number/);
    });
  });

  describe("GET /api/workflow/executions/:executionId", () => {
    it("retrieves a previously started execution", async () => {
      const start = await server.inject({
        method: "POST",
        url: "/api/workflow/actions/daily-standup-prep/execute",
        payload: {},
      });
      const { id } = start.json();

      const response = await server.inject({
        method: "GET",
        url: `/api/workflow/executions/${id}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe(id);
    });

    it("returns 404 for an unknown execution", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/workflow/executions/missing-id",
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
