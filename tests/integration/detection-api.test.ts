import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../../src/middleware/auth", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    isAuthConfigured: () => false,
    getApiKeyForAuth: () => "",
  };
});

describe("Detection API", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    const { buildServer } = await import("../../src/server");
    server = await buildServer();
    await server.ready();
  }, 120000);

  afterAll(async () => {
    if (server) await server.close();
  });

  describe("POST /api/detection/idea", () => {
    it("returns a structured detection proposal", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/detection/idea",
        payload: {
          name: "Suspicious OAuth Consent Grant Abuse",
          description: "User grants OAuth consent to an unverified third-party application",
          dataSource: "audit_logs",
          mitreTechniques: ["T1528"],
          severity: "high",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.summary).toBeDefined();
      expect(body.hypothesis).toBeDefined();
      expect(Array.isArray(body.dataSources)).toBe(true);
      expect(Array.isArray(body.mitreMapping)).toBe(true);
      expect(Array.isArray(body.testCases)).toBe(true);
      expect(Array.isArray(body.workItems)).toBe(true);
      expect(Array.isArray(body.draftFormats)).toBe(true);
    });

    it("returns 400 for invalid input", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/detection/idea",
        payload: {
          description: "Missing required name",
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe("Validation failed");
    });
  });

  describe("POST /api/detection/mitre", () => {
    it("returns technique mapping", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/detection/mitre",
        payload: {
          technique: "T1528",
          name: "Application Access Token",
          tactic: "Credential Access",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.techniques)).toBe(true);
      expect(body.techniques[0].id).toBe("T1528");
    });

    it("returns 400 for invalid body", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/detection/mitre",
        payload: { technique: 123 },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("POST /api/detection/tests", () => {
    it("returns generated test cases", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/detection/tests",
        payload: {
          name: "OAuth Abuse Detection",
          description: "Detect suspicious OAuth consent grants",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(3);
    });

    it("returns 400 for invalid input", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/detection/tests",
        payload: {
          description: "Missing required name",
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("POST /api/detection/work-items", () => {
    it("creates work items and returns their ids", async () => {
      const ideaRes = await server.inject({
        method: "POST",
        url: "/api/detection/idea",
        payload: {
          name: "OAuth Abuse Detection",
          description: "Detect suspicious OAuth consent grants",
          severity: "high",
        },
      });
      const idea = ideaRes.json();

      const response = await server.inject({
        method: "POST",
        url: "/api/detection/work-items",
        payload: { idea },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.created)).toBe(true);
      expect(body.created.length).toBe(idea.workItems.length);
    });

    it("returns 400 for invalid work item input", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/detection/work-items",
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe("Validation failed");
    });
  });

  describe("POST /api/detection/review", () => {
    it("returns a structured review", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/detection/review",
        payload: {
          name: "OAuth Abuse Detection",
          logic: "event where oauth_consent granted to unknown app",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.strengths)).toBe(true);
      expect(Array.isArray(body.weaknesses)).toBe(true);
      expect(["low", "medium", "high", "critical"]).toContain(body.falsePositiveRisk);
    });

    it("returns 400 for missing required fields", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/detection/review",
        payload: {
          name: "Missing logic",
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /api/detection/coverage-gaps", () => {
    it("returns coverage gap analysis", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/detection/coverage-gaps?existingDetections=Detect-1&existingDetections=Detect-2",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.gaps)).toBe(true);
      expect(Array.isArray(body.suggestedDetections)).toBe(true);
      expect(typeof body.coveragePercentage).toBe("number");
    });

    it("returns 400 for invalid query params", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/detection/coverage-gaps?existingDetections=single-string",
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
