import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { isAuthConfigured, getApiKeyForAuth } from "../../src/middleware/auth";

vi.mock("../../src/middleware/auth", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // vi.fn so the auth-enforced suite can flip the global middleware on before
    // building its server. AUTH_PASSWORD is present in the test env (.env), so
    // the happy-path suite also stubs the per-route requireAuth guard to a
    // no-op; end-to-end enforcement is covered by the auth-enforced suite below.
    isAuthConfigured: vi.fn(() => false),
    getApiKeyForAuth: vi.fn(() => ""),
    requireAuth: vi.fn(async () => {}),
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

describe("Jitbit Sync API — auth enforced", () => {
  let server: FastifyInstance;
  let prevAuthPassword: string | undefined;

  beforeAll(async () => {
    // Configure auth so the global middleware registers and requireAuth enforces.
    prevAuthPassword = process.env.AUTH_PASSWORD;
    process.env.AUTH_PASSWORD = "test-secret";
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(getApiKeyForAuth).mockReturnValue("");

    const { buildServer } = await import("../../src/server");
    server = await buildServer();
    await server.ready();
  }, 120000);

  afterAll(async () => {
    if (server) await server.close();
    if (prevAuthPassword === undefined) {
      delete process.env.AUTH_PASSWORD;
    } else {
      process.env.AUTH_PASSWORD = prevAuthPassword;
    }
    vi.mocked(isAuthConfigured).mockReturnValue(false);
    vi.mocked(getApiKeyForAuth).mockReturnValue("");
  });

  it("rejects an unauthenticated POST with 401", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/sync/jitbit",
      payload: { days: 7 },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects an invalid token with 403", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/sync/jitbit",
      headers: { authorization: "Bearer wrong-token" },
      payload: { days: 7 },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects an unauthenticated GET status with 401", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/sync/jitbit/status",
    });

    expect(response.statusCode).toBe(401);
  });
});
