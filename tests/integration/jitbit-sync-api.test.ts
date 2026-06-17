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

describe("Jitbit Sync API", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    const { buildServer } = await import("../../src/server");
    server = await buildServer();
    await server.ready();
  }, 120000);

  afterAll(async () => {
    if (server) await server.close();
  });

  describe("POST /api/sync/jitbit", () => {
    it("triggers a sync and returns a result shape", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/sync/jitbit",
        payload: { days: 7, maxItems: 25 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(typeof body.synced).toBe("number");
      expect(typeof body.skipped).toBe("number");
      expect(typeof body.errors).toBe("number");
      expect(Array.isArray(body.items)).toBe(true);
    });

    it("accepts an empty body", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/sync/jitbit",
        payload: {},
      });

      expect(response.statusCode).toBe(200);
    });

    it("rejects out-of-range input", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/sync/jitbit",
        payload: { days: 1000 },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /api/sync/jitbit/status", () => {
    it("returns the synced count", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/sync/jitbit/status",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(typeof body.syncedCount).toBe("number");
    });
  });
});
