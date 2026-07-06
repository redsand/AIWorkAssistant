import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Regression: the root "/" path was exempted from auth with an exact
 * `request.url === "/"` check, but every other exemption in the same hook
 * (PUBLIC_PATHS.has, the html/css/js extension check) strips the query
 * string first. A bare navigation to "/" worked, but "/?redirect=%2Frunners"
 * (exactly what auth-guard.js produces when redirecting an unauthenticated
 * user back to login) fell through to verifyRequestAuth and got a raw JSON
 * 401 instead of the login page — with no way to ever authenticate since
 * the HTML never loaded. Every public HTML shell must tolerate a query
 * string, not just "/".
 */
let server: FastifyInstance;

describe("Public HTML shells tolerate a query string", () => {
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

  it("serves the root page for a bare '/' with no auth", async () => {
    const response = await server.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
  });

  it("serves the root page when redirected back with ?redirect=... and no auth", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/?redirect=%2Frunners",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json).toThrow();
  });

  it.each(["/runners", "/kanban", "/dashboard", "/comparison", "/eval"])(
    "serves %s with a trailing query string and no auth",
    async (path) => {
      const response = await server.inject({
        method: "GET",
        url: `${path}?foo=bar`,
      });
      expect(response.statusCode).toBe(200);
    },
  );
});
