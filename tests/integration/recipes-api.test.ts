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

describe("Recipes API", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    const { buildServer } = await import("../../src/server");
    server = await buildServer();
    await server.ready();
  }, 120000);

  afterAll(async () => {
    if (server) await server.close();
  });

  describe("GET /api/recipes", () => {
    it("returns recipe list", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/recipes",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.recipes).toBeDefined();
      expect(Array.isArray(body.recipes)).toBe(true);
      expect(body.recipes.length).toBeGreaterThanOrEqual(1);
    });

    it("each recipe in list has required fields", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/recipes",
      });

      const body = response.json();
      for (const recipe of body.recipes) {
        expect(recipe).toHaveProperty("id");
        expect(recipe).toHaveProperty("name");
        expect(recipe).toHaveProperty("description");
        expect(recipe).toHaveProperty("category");
        expect(recipe).toHaveProperty("tags");
        expect(recipe).toHaveProperty("variableCount");
        expect(typeof recipe.variableCount).toBe("number");
      }
    });
  });

  describe("GET /api/recipes/:id", () => {
    it("returns a recipe by ID", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/recipes/triage-new-ticket",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe("triage-new-ticket");
      expect(body.name).toBe("Triage New Support Ticket");
      expect(body.category).toBe("triage");
      expect(body.steps).toBeDefined();
      expect(Array.isArray(body.steps)).toBe(true);
    });

    it("returns error for unknown recipe", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/recipes/nonexistent",
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error).toBe("Recipe not found");
    });
  });

  describe("POST /api/recipes/:id/execute", () => {
    it("executes a recipe with valid variables", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/recipes/triage-new-ticket/execute",
        payload: { ticketId: 42 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBeDefined();
      expect(body.recipeId).toBe("triage-new-ticket");
      expect(body.status).toBe("running");
      expect(body.steps).toHaveLength(3);
    });

    it("returns error for missing required variables", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/recipes/triage-new-ticket/execute",
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /api/recipes/executions/:executionId", () => {
    it("returns a previously created execution", async () => {
      const execRes = await server.inject({
        method: "POST",
        url: "/api/recipes/triage-new-ticket/execute",
        payload: { ticketId: 42 },
      });
      const execution = execRes.json();

      const response = await server.inject({
        method: "GET",
        url: `/api/recipes/executions/${execution.id}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(execution.id);
    });

    it("returns error for unknown execution", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/recipes/executions/nonexistent",
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error).toBe("Execution not found");
    });
  });
});
