import { FastifyInstance } from "fastify";
import { recipeEngine } from "../recipes/recipe-engine.js";

export async function recipeRoutes(fastify: FastifyInstance) {
  fastify.get("/api/recipes", async () => {
    return recipeEngine.listRecipes();
  });

  fastify.get("/api/recipes/:id", async (request) => {
    const { id } = request.params as { id: string };
    const recipe = recipeEngine.getRecipe(id);
    if (!recipe) {
      return { error: "Recipe not found" };
    }
    return recipe;
  });

  fastify.post("/api/recipes/:id/execute", async (request) => {
    const { id } = request.params as { id: string };
    const variables = request.body as Record<string, unknown>;
    const execution = await recipeEngine.execute(id, variables);
    return execution;
  });

  fastify.get("/api/recipes/executions/:executionId", async (request) => {
    const { executionId } = request.params as { executionId: string };
    const execution = recipeEngine.getExecution(executionId);
    if (!execution) {
      return { error: "Execution not found" };
    }
    return execution;
  });
}
