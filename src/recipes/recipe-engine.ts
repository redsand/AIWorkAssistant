import type { Recipe, RecipeExecution, RecipeListOutput } from "./types.js";
import { builtinRecipes } from "./builtin-recipes.js";
import { v4 as uuidv4 } from "uuid";

export class RecipeEngine {
  private recipes: Map<string, Recipe> = new Map();
  private executions: Map<string, RecipeExecution> = new Map();

  constructor() {
    for (const recipe of builtinRecipes) {
      this.recipes.set(recipe.id, recipe);
    }
  }

  listRecipes(): RecipeListOutput {
    return {
      recipes: Array.from(this.recipes.values()).map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        category: r.category,
        tags: r.tags,
        variableCount: r.variables.filter((v) => v.required).length,
      })),
    };
  }

  getRecipe(id: string): Recipe | undefined {
    return this.recipes.get(id);
  }

  async execute(
    recipeId: string,
    variables: Record<string, unknown>,
  ): Promise<RecipeExecution> {
    const recipe = this.recipes.get(recipeId);
    if (!recipe) {
      throw new Error(`Recipe not found: ${recipeId}`);
    }

    for (const v of recipe.variables) {
      if (v.required && !(v.name in variables)) {
        throw new Error(`Missing required variable: ${v.name}`);
      }
    }

    const execution: RecipeExecution = {
      id: uuidv4(),
      recipeId,
      status: "running",
      startedAt: new Date().toISOString(),
      steps: recipe.steps.map((s) => ({
        stepId: s.id,
        status: "pending",
      })),
      variables,
    };

    this.executions.set(execution.id, execution);

    return execution;
  }

  getExecution(executionId: string): RecipeExecution | undefined {
    return this.executions.get(executionId);
  }
}

export const recipeEngine = new RecipeEngine();
