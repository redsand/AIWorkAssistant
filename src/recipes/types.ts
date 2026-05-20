export interface RecipeStep {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  condition?: string;
  waitFor?: string;
  onError: "continue" | "stop" | "retry";
  maxRetries?: number;
}

export interface RecipeVariable {
  name: string;
  description: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  defaultValue?: unknown;
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  category: "triage" | "investigation" | "response" | "reporting" | "maintenance";
  steps: RecipeStep[];
  variables: RecipeVariable[];
  tags: string[];
  version: string;
}

export interface RecipeExecution {
  id: string;
  recipeId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  steps: RecipeStepExecution[];
  variables: Record<string, unknown>;
}

export interface RecipeStepExecution {
  stepId: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
}

export interface RecipeListOutput {
  recipes: Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    tags: string[];
    variableCount: number;
  }>;
}
