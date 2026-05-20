import { FastifyInstance } from "fastify";
import { recipeEngine } from "../recipes/recipe-engine.js";

export async function recipeRoutes(fastify: FastifyInstance) {
  fastify.get("/api/recipes", async () => {
    return recipeEngine.listRecipes();
  });

  fastify.get("/api/recipes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const recipe = recipeEngine.getRecipe(id);
    if (!recipe) {
      return reply.code(404).send({ error: "Recipe not found" });
    }
    return recipe;
  });

  fastify.post("/api/recipes/:id/execute", async (request, reply) => {
    const { id } = request.params as { id: string };
    const variables = request.body as Record<string, unknown>;
    try {
      const execution = await recipeEngine.execute(id, variables);
      return execution;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("Recipe not found")) {
        return reply.code(404).send({ error: message });
      }
      return reply.code(400).send({ error: message });
    }
  });

  fastify.get("/api/recipes/executions/:executionId", async (request, reply) => {
    const { executionId } = request.params as { executionId: string };
    const execution = recipeEngine.getExecution(executionId);
    if (!execution) {
      return reply.code(404).send({ error: "Execution not found" });
    }
    return execution;
  });
}
