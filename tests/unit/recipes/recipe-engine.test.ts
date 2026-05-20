import { describe, it, expect, beforeEach } from "vitest";
import {
  RecipeEngine,
  recipeEngine,
} from "../../../src/recipes/recipe-engine";
import type { Recipe } from "../../../src/recipes/types";
import { builtinRecipes } from "../../../src/recipes/builtin-recipes";

describe("RecipeEngine", () => {
  let engine: RecipeEngine;

  beforeEach(() => {
    engine = new RecipeEngine();
  });

  describe("listRecipes", () => {
    it("should return all built-in recipes", () => {
      const result = recipeEngine.listRecipes();
      expect(result.recipes).toHaveLength(builtinRecipes.length);
      expect(result.recipes[0]).toHaveProperty("id");
      expect(result.recipes[0]).toHaveProperty("name");
      expect(result.recipes[0]).toHaveProperty("description");
      expect(result.recipes[0]).toHaveProperty("category");
      expect(result.recipes[0]).toHaveProperty("tags");
      expect(result.recipes[0]).toHaveProperty("variableCount");
    });

    it("should return variableCount matching required variables", () => {
      const result = recipeEngine.listRecipes();
      for (const r of result.recipes) {
        const recipe = builtinRecipes.find((br) => br.id === r.id);
        const expected = recipe!.variables.filter((v) => v.required).length;
        expect(r.variableCount).toBe(expected);
      }
    });
  });

  describe("getRecipe", () => {
    it("should return a recipe by ID", () => {
      const recipe = recipeEngine.getRecipe("triage-new-ticket");
      expect(recipe).toBeDefined();
      expect(recipe!.id).toBe("triage-new-ticket");
      expect(recipe!.category).toBe("triage");
    });

    it("should return undefined for unknown recipe", () => {
      const recipe = recipeEngine.getRecipe("nonexistent");
      expect(recipe).toBeUndefined();
    });
  });

  describe("execute", () => {
    it("should throw if recipe not found", async () => {
      await expect(
        engine.execute("nonexistent", {}),
      ).rejects.toThrow("Recipe not found: nonexistent");
    });

    it("should throw if required variables are missing", async () => {
      await expect(
        engine.execute("triage-new-ticket", {}),
      ).rejects.toThrow("Missing required variable: ticketId");
    });

    it("should create an execution with correct status and structure", async () => {
      const execution = await engine.execute("triage-new-ticket", {
        ticketId: 42,
      });
      expect(execution.id).toBeDefined();
      expect(execution.recipeId).toBe("triage-new-ticket");
      expect(execution.status).toBe("running");
      expect(execution.startedAt).toBeDefined();
      expect(execution.steps).toHaveLength(3);
      expect(execution.steps[0].stepId).toBe("get-ticket");
      expect(execution.steps[0].status).toBe("pending");
      expect(execution.variables).toEqual({ ticketId: 42 });
    });

    it("should accept optional variables", async () => {
      const execution = await engine.execute("triage-new-ticket", {
        ticketId: 42,
        priority: "high",
      });
      expect(execution.variables).toEqual({ ticketId: 42, priority: "high" });
    });

    it("should accept non-required missing variables for daily-standup-prep", async () => {
      const execution = await engine.execute("daily-standup-prep", {});
      expect(execution.recipeId).toBe("daily-standup-prep");
      expect(execution.steps).toHaveLength(3);
    });
  });

  describe("getExecution", () => {
    it("should return a previously created execution", async () => {
      const execution = await engine.execute("triage-new-ticket", {
        ticketId: 42,
      });
      const retrieved = engine.getExecution(execution.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(execution.id);
    });

    it("should return undefined for unknown execution", () => {
      const result = engine.getExecution("nonexistent");
      expect(result).toBeUndefined();
    });
  });
});

describe("builtinRecipes", () => {
  it("should have 3 built-in recipes", () => {
    expect(builtinRecipes).toHaveLength(3);
  });

  it("each recipe should have a unique id", () => {
    const ids = builtinRecipes.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("each recipe should have a valid category", () => {
    const validCategories = [
      "triage",
      "investigation",
      "response",
      "reporting",
      "maintenance",
    ];
    for (const recipe of builtinRecipes) {
      expect(validCategories).toContain(recipe.category);
    }
  });

  it("each recipe should have at least one step", () => {
    for (const recipe of builtinRecipes) {
      expect(recipe.steps.length).toBeGreaterThan(0);
    }
  });

  it("each step should have valid onError values", () => {
    const validOnError = ["continue", "stop", "retry"];
    for (const recipe of builtinRecipes) {
      for (const step of recipe.steps) {
        expect(validOnError).toContain(step.onError);
      }
    }
  });

  it("triaged-new-ticket recipe should require ticketId", () => {
    const recipe = builtinRecipes.find((r) => r.id === "triage-new-ticket")!;
    const ticketIdVar = recipe.variables.find((v) => v.name === "ticketId");
    expect(ticketIdVar).toBeDefined();
    expect(ticketIdVar!.required).toBe(true);
    expect(ticketIdVar!.type).toBe("number");
  });

  it("escalate-hawk-ir-case recipe should require caseId and escalationReason", () => {
    const recipe = builtinRecipes.find(
      (r) => r.id === "escalate-hawk-ir-case",
    )!;
    const caseIdVar = recipe.variables.find((v) => v.name === "caseId");
    const reasonVar = recipe.variables.find(
      (v) => v.name === "escalationReason",
    );
    expect(caseIdVar!.required).toBe(true);
    expect(reasonVar!.required).toBe(true);
  });

  it("daily-standup-prep recipe should have date as optional with default", () => {
    const recipe = builtinRecipes.find(
      (r) => r.id === "daily-standup-prep",
    )!;
    const dateVar = recipe.variables.find((v) => v.name === "date");
    expect(dateVar).toBeDefined();
    expect(dateVar!.required).toBe(false);
    expect(dateVar!.defaultValue).toBe("today");
  });
});
