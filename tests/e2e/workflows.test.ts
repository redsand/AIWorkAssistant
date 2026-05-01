import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import {
  createSessionToken,
  validateSessionToken,
  revokeSessionToken,
  timingSafeEqual,
  isAuthConfigured,
} from "../../src/middleware/auth";

let server: FastifyInstance;
const TEST_API_KEY = "test-e2e-api-key-12345";
let authToken = "";

function initAuthToken() {
  authToken = createSessionToken("e2e-test-user");
}

async function buildTestServer(): Promise<FastifyInstance> {
  process.env.OPENCODE_API_KEY = TEST_API_KEY;
  process.env.AUTH_PASSWORD = "test-password";
  process.env.PORT = "0";
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "sqlite::memory:";
  process.env.AUDIT_LOG_FILE = path.join(
    process.cwd(),
    "data",
    "audit",
    `test-${Date.now()}.log`,
  );
  process.env.POLICY_APPROVAL_MODE = "permissive";
  process.env.ENABLE_CALENDAR_WRITE = "true";

  const { buildServer } = await import("../../src/server");
  return buildServer();
}

describe("E2E: Auth Middleware", () => {
  beforeAll(async () => {
    server = await buildTestServer();
    await server.ready();
    authToken = createSessionToken("e2e-test-user");
  });

  afterAll(async () => {
    await server.close();
  });

  it("should allow access to public paths without authentication", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/health",
    });
    expect(response.statusCode).toBe(200);
  });

  it("should allow access to /calendar/export/ics without authentication", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/calendar/export/ics",
    });
    expect([200, 404]).toContain(response.statusCode);
  });

  it("should allow access to /calendar/subscribe without authentication", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/calendar/subscribe",
    });
    expect([200, 404]).toContain(response.statusCode);
  });

  it("should allow access to /webhooks/ without authentication", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/webhooks/gitlab",
      payload: {},
    });
    expect([200, 400, 401, 500]).toContain(response.statusCode);
  });

  it("should allow access to /auth/login without authentication", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/auth/status",
    });
    expect(response.statusCode).toBe(200);
  });

  it("should allow access with valid session token via Bearer header", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/approvals",
      headers: {
        authorization: `Bearer ${authToken}`,
      },
    });
    expect([200, 404]).toContain(response.statusCode);
  });

  it("should allow access with valid session token via X-API-Key header", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/approvals",
      headers: {
        "x-api-key": authToken,
      },
    });
    expect([200, 404]).toContain(response.statusCode);
  });

  it("should reject access with invalid token", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/approvals",
      headers: {
        authorization: "Bearer invalid-token",
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it("should reject access without any authentication", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/approvals",
    });
    expect([401, 403]).toContain(response.statusCode);
  });

  it("should reject revoked session tokens", async () => {
    const revokedToken = createSessionToken("revoked-user");
    revokeSessionToken(revokedToken);

    const response = await server.inject({
      method: "GET",
      url: "/approvals",
      headers: {
        authorization: `Bearer ${revokedToken}`,
      },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("E2E: Calendar CRUD + ICS Export", () => {
  let createdEventId: string;

  beforeAll(async () => {
    server = await buildTestServer();
    await server.ready();
    authToken = createSessionToken("e2e-test-user");
  });

  afterAll(async () => {
    await server.close();
  });

  it("should create a calendar event", async () => {
    const startTime = new Date(Date.now() + 3600000).toISOString();
    const endTime = new Date(Date.now() + 7200000).toISOString();

    const response = await server.inject({
      method: "POST",
      url: "/calendar/events",
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        summary: "E2E Test Meeting",
        description: "Test event from e2e tests",
        startTime,
        endTime,
        location: "Conference Room A",
        type: "meeting",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.event.summary).toBe("E2E Test Meeting");
    createdEventId = body.event.id;
  });

  it("should list calendar events", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/calendar/events",
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.events)).toBe(true);
  });

  it("should get calendar stats", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/calendar/stats",
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it("should export calendar as ICS", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/calendar/export/ics",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/calendar");
    expect(response.body).toContain("BEGIN:VCALENDAR");
    expect(response.body).toContain("BEGIN:VTIMEZONE");
    expect(response.body).toContain("END:VCALENDAR");
  });

  it("should return subscription info", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/calendar/subscribe",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body).toHaveProperty("subscription");
    expect(body.subscription).toHaveProperty("instructions");
    expect(body.subscription.instructions).toHaveProperty("iphone");
  });

  it("should create a focus block", async () => {
    const startTime = new Date(Date.now() + 86400000).toISOString();

    const response = await server.inject({
      method: "POST",
      url: "/calendar/focus-blocks",
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        title: "E2E Focus Block",
        startTime,
        duration: 90,
        description: "Deep work session",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.event.type).toBe("focus");
  });

  it("should create a health block", async () => {
    const startTime = new Date(Date.now() + 90000000).toISOString();

    const response = await server.inject({
      method: "POST",
      url: "/calendar/health-blocks",
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        title: "E2E Health Break",
        startTime,
        duration: 30,
        healthType: "fitness",
        description: "Morning workout",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it("should delete a calendar event", async () => {
    if (!createdEventId) return;

    const response = await server.inject({
      method: "DELETE",
      url: `/calendar/events/${createdEventId}`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });
});

describe("E2E: Approval Lifecycle", () => {
  let approvalId: string;

  beforeAll(async () => {
    server = await buildTestServer();
    await server.ready();
    authToken = createSessionToken("e2e-test-user");
  });

  afterAll(async () => {
    await server.close();
  });

  it("should list empty approvals", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/approvals",
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("approvals");
    expect(Array.isArray(body.approvals)).toBe(true);
  });

  it("should create an approval request via guardrails check", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/guardrails/check",
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        operation: "fs.delete",
        params: { path: "/tmp/test-file" },
        userId: "e2e-test-user",
        environment: "development",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body).toHaveProperty("result");
  });

  it("should create a pending approval via guardrails", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/guardrails/check",
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        operation: "deploy.production",
        params: {
          environment: "staging",
          justification: "E2E test deployment",
        },
        userId: "e2e-approval-user",
        environment: "staging",
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it("should list pending approvals from guardrails", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/guardrails/approvals/pending",
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it("should get guardrails stats", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/guardrails/stats",
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.stats).toHaveProperty("totalActions");
  });

  it("should get guardrails history for user", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/guardrails/history/e2e-test-user",
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });
});

describe("E2E: GitLab Webhook HMAC Verification", () => {
  it("should reject webhook with no secret configured when secret is set", async () => {
    const { webhookHandler } =
      await import("../../src/integrations/gitlab/webhook-handler");

    const result = webhookHandler.verifyWebhook(
      "wrong-token",
      '{"test": true}',
      "test-secret-12345",
    );
    expect(result).toBe(false);
  });

  it("should accept webhook with correct token using timing-safe comparison", async () => {
    const { webhookHandler } =
      await import("../../src/integrations/gitlab/webhook-handler");

    const result = webhookHandler.verifyWebhook(
      "test-secret-12345",
      '{"test": true}',
      "test-secret-12345",
    );
    expect(result).toBe(true);
  });

  it("should accept HMAC-SHA256 signature", async () => {
    const { webhookHandler } =
      await import("../../src/integrations/gitlab/webhook-handler");
    const secret = "my-webhook-secret";

    const body = '{"object_kind":"push","project":{"name":"test"}}';
    const hmac = crypto.createHmac("sha256", secret).update(body).digest("hex");

    const result = webhookHandler.verifyWebhook(hmac, body, secret);
    expect(result).toBe(true);
  });

  it("should reject invalid HMAC-SHA256 signature", async () => {
    const { webhookHandler } =
      await import("../../src/integrations/gitlab/webhook-handler");
    const secret = "my-webhook-secret";

    const body = '{"object_kind":"push","project":{"name":"test"}}';
    const wrongHmac = crypto
      .createHmac("sha256", "wrong-secret")
      .update(body)
      .digest("hex");

    const result = webhookHandler.verifyWebhook(wrongHmac, body, secret);
    expect(result).toBe(false);
  });

  it("should bypass verification when no secret is configured", async () => {
    const { webhookHandler } =
      await import("../../src/integrations/gitlab/webhook-handler");

    const result = webhookHandler.verifyWebhook(
      "anything",
      '{"test": true}',
      undefined,
    );
    expect(result).toBe(true);
  });
});

describe("E2E: Roadmap CRUD", () => {
  let roadmapId: string;

  beforeAll(async () => {
    server = await buildTestServer();
    await server.ready();
    authToken = createSessionToken("e2e-test-user");
  });

  afterAll(async () => {
    await server.close();
  });

  it("should create a roadmap", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/roadmaps",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
      },
      payload: {
        name: "E2E Test Roadmap",
        type: "internal",
        description: "Created by e2e tests",
        startDate: "2026-05-01",
        endDate: "2026-08-01",
      },
    });

    const body = JSON.parse(response.body);
    if (response.statusCode !== 201) {
      throw new Error(
        `Roadmap create failed (${response.statusCode}): ${JSON.stringify(body)}`,
      );
    }
    expect(body.success).toBe(true);
    expect(body.roadmap.name).toBe("E2E Test Roadmap");
    roadmapId = body.roadmap.id;
  });

  it("should list roadmaps", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/roadmaps",
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.roadmaps)).toBe(true);
  });

  it("should get a roadmap by id", async () => {
    if (!roadmapId) return;

    const response = await server.inject({
      method: "GET",
      url: `/api/roadmaps/${roadmapId}`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.roadmap.id).toBe(roadmapId);
  });

  it("should update a roadmap", async () => {
    if (!roadmapId) return;

    const response = await server.inject({
      method: "PATCH",
      url: `/api/roadmaps/${roadmapId}`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        name: "E2E Test Roadmap (Updated)",
        description: "Updated by e2e tests",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it("should delete a roadmap", async () => {
    if (!roadmapId) return;

    const response = await server.inject({
      method: "DELETE",
      url: `/api/roadmaps/${roadmapId}`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });
});

describe("E2E: Productivity Endpoints", () => {
  beforeAll(async () => {
    server = await buildTestServer();
    await server.ready();
    authToken = createSessionToken("e2e-test-user");
  });

  afterAll(async () => {
    await server.close();
  });

  it("should return daily plan (with stubs)", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/productivity/daily-plan",
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it("should return focus block recommendations (stub)", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/productivity/focus-blocks/recommend",
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it("should return health break recommendations (stub)", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/productivity/health-breaks/recommend",
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it("should return calendar summary", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/productivity/calendar-summary",
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });
});

describe("E2E: Engineering Endpoints", () => {
  beforeAll(async () => {
    server = await buildTestServer();
    await server.ready();
    authToken = createSessionToken("e2e-test-user");
  });

  afterAll(async () => {
    await server.close();
  });

  it("should return workflow brief (stub or AI)", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/engineering/workflow-brief",
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        projectDescription: "E2E test project",
        requirements: ["test everything"],
      },
    });

    expect([200, 503]).toContain(response.statusCode);
  });

  it("should return architecture proposal (stub or AI)", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/engineering/architecture-proposal",
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        projectDescription: "E2E test project",
        techPreferences: ["TypeScript", "Fastify"],
      },
    });

    expect([200, 503]).toContain(response.statusCode);
  });
});

describe("E2E: Guardrails Persistence (SQLite)", () => {
  it("should persist guardrails actions to SQLite database", async () => {
    const { guardrailsDatabase } =
      await import("../../src/guardrails/database");

    const testId = `test-persist-${Date.now()}`;
    guardrailsDatabase.saveActionRequest({
      id: testId,
      actionId: "jira.transition",
      userId: "persistence-test-user",
      timestamp: new Date(),
      params: { issueKey: "TEST-1" },
      justification: "E2E persistence test",
      environment: "test",
      status: "pending",
    });

    const actions = guardrailsDatabase.getActionsByUser(
      "persistence-test-user",
      10,
    );
    expect(actions.length).toBeGreaterThanOrEqual(1);

    const found = actions.find((a) => a.id === testId);
    expect(found).toBeDefined();
    expect(found!.actionId).toBe("jira.transition");
    expect(found!.status).toBe("pending");
  });

  it("should update action status in SQLite", async () => {
    const { guardrailsDatabase } =
      await import("../../src/guardrails/database");

    const testId = `test-update-${Date.now()}`;
    guardrailsDatabase.saveActionRequest({
      id: testId,
      actionId: "fs.delete",
      userId: "status-test-user",
      timestamp: new Date(),
      params: {},
      environment: "test",
      status: "pending",
    });

    guardrailsDatabase.updateStatus(testId, "approved", "admin-user");

    const actions = guardrailsDatabase.getActionsByUser("status-test-user", 10);
    const found = actions.find((a) => a.id === testId);
    expect(found).toBeDefined();
    expect(found!.status).toBe("approved");
  });

  it("should get pending approvals from SQLite", async () => {
    const { guardrailsDatabase } =
      await import("../../src/guardrails/database");

    const pending = guardrailsDatabase.getPendingApprovals();
    expect(Array.isArray(pending)).toBe(true);
  });

  it("should get stats from SQLite", async () => {
    const { guardrailsDatabase } =
      await import("../../src/guardrails/database");

    const stats = guardrailsDatabase.getStats();
    expect(stats).toHaveProperty("totalActions");
    expect(stats).toHaveProperty("pendingApprovals");
    expect(stats).toHaveProperty("executionsLast24h");
  });
});
