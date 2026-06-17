import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../../src/middleware/auth", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isAuthConfigured: () => false,
    getApiKeyForAuth: () => "",
  };
});

describe("Extraction API", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    const { buildServer } = await import("../../src/server");
    server = await buildServer();
    await server.ready();
  }, 120000);

  afterAll(async () => {
    if (server) await server.close();
  });

  describe("POST /api/extraction/extract", () => {
    it("returns extracted items from conversation text", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/extraction/extract",
        payload: {
          conversationText:
            "We need to fix the login bug.\nPlease review the deployment script.",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items[0].type).toBe("task");
      expect(body.items[0].source).toBe("chat");
      expect(typeof body.confidence).toBe("number");
      expect(typeof body.reasoning).toBe("string");
    });

    it("returns 400 for invalid input", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/extraction/extract",
        payload: { context: "missing conversationText" },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
