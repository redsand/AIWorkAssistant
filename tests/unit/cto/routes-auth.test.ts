import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

let server: FastifyInstance;

describe("CTO routes authentication", () => {
  beforeAll(async () => {
    vi.resetModules();
    process.env.AUTH_PASSWORD = "test-password";
    process.env.OPENCODE_API_KEY = "test-api-key";
    process.env.AI_PROVIDER = "opencode";
    process.env.NODE_ENV = "test";
    process.env.PORT = "0";

    const { buildServer } = await import("../../../src/server");
    server = await buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("rejects unauthenticated daily command generation", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/cto/daily-command-center",
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects unauthenticated suggested work item creation", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/cto/daily-command-center/create-work-items",
      payload: { items: [] },
    });

    expect(response.statusCode).toBe(401);
  });
});
