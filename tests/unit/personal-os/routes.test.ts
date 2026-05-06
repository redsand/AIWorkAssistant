import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/integrations/file/calendar-service", () => ({
  fileCalendarService: { listEvents: vi.fn(() => []), isConfigured: vi.fn(() => true) },
}));
vi.mock("../../../src/integrations/jira/jira-client", () => ({
  jiraClient: { isConfigured: vi.fn(() => false) },
}));
vi.mock("../../../src/integrations/gitlab/gitlab-client", () => ({
  gitlabClient: { isConfigured: vi.fn(() => false), getDefaultProject: vi.fn(() => null) },
}));
vi.mock("../../../src/integrations/github/github-client", () => ({
  githubClient: { isConfigured: vi.fn(() => false) },
}));
vi.mock("../../../src/integrations/jitbit/jitbit-service", () => ({
  jitbitService: { isConfigured: vi.fn(() => false) },
}));
vi.mock("../../../src/roadmap/database", () => ({
  roadmapDatabase: { listRoadmaps: vi.fn(() => []), getMilestones: vi.fn(() => []), getItems: vi.fn(() => []) },
}));
vi.mock("../../../src/work-items/database", () => ({
  workItemDatabase: {
    listWorkItems: vi.fn(() => ({ items: [] })),
    createWorkItem: vi.fn((item: any) => ({ id: "new-1", ...item })),
  },
}));
vi.mock("../../../src/memory/conversation-manager", () => ({
  conversationManager: { getRelevantMemories: vi.fn(() => []) },
}));

import Fastify from "fastify";
import { personalOsRoutes } from "../../../src/routes/personal-os";

describe("Personal OS Routes", () => {
  async function buildApp() {
    const app = Fastify();
    await app.register(personalOsRoutes, { prefix: "/api/personal-os" });
    return app;
  }

  it("GET /brief returns 200 with brief data", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/personal-os/brief",
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.date).toBeTruthy();
    expect(body.markdown).toContain("Personal OS Brief");
    expect(body.todaysLoad).toBeDefined();
  });

  it("GET /brief with date param returns correct date", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/personal-os/brief?date=2025-06-15",
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.date).toBe("2025-06-15");
  });

  it("GET /brief with invalid date defaults to today", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/personal-os/brief?date=not-a-date",
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.date).toBeTruthy();
  });

  it("GET /open-loops returns 200", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/personal-os/open-loops",
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.openLoops).toBeDefined();
    expect(body.decisionsWaiting).toBeDefined();
  });

  it("GET /patterns returns 200", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/personal-os/patterns",
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.recurringPatterns).toBeDefined();
  });

  it("POST /work-items creates items with personal-os tags", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/personal-os/work-items",
      payload: {
        items: [
          {
            type: "personal",
            title: "Test work item",
            priority: "high",
          },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.created).toHaveLength(1);
  });

  it("POST /work-items rejects invalid type", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/personal-os/work-items",
      payload: {
        items: [
          {
            type: "invalid_type",
            title: "Bad item",
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("POST /work-items accepts valid items", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/personal-os/work-items",
      payload: {
        items: [
          {
            type: "personal",
            title: "Valid item",
            priority: "medium",
          },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
  });
});