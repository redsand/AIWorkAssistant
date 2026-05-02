/**
 * Scaffolding plan generator
 * TODO: Implement actual scaffolding generation with AI provider
 */

import { ArchitectureProposal } from "./architecture-planner";

interface ScaffoldingPlan {
  repoStructure: string[];
  packages: string[];
  envConfig: string[];
  scripts: string[];
  dockerSetup: string;
  migrations: string[];
  seedData: string[];
  testSetup: string;
  linting: string;
  formatting: string;
  ciPipeline: string;
  docsStructure: string[];
}

class ScaffoldPlanner {
  /**
   * Generate scaffolding plan from architecture proposal
   */
  async generate(
    _architecture: ArchitectureProposal,
  ): Promise<ScaffoldingPlan> {
    // TODO: Use AI provider to generate scaffolding plan
    console.log("[Scaffold Planner] Generating from architecture");

    // Stub response
    return {
      repoStructure: [
        "src/",
        "src/server.ts",
        "src/config/",
        "src/routes/",
        "src/services/",
        "tests/",
      ],
      packages: ["fastify", "typescript", "vitest", "eslint"],
      envConfig: ["PORT", "DATABASE_URL", "API_KEY"],
      scripts: ["dev", "build", "test", "lint"],
      dockerSetup: "Dockerfile + docker-compose.yml",
      migrations: ["001_initial.sql", "002_users.sql"],
      seedData: ["seed_dev_data.sql"],
      testSetup: "Vitest + testing library",
      linting: "ESLint + TypeScript ESLint",
      formatting: "Prettier",
      ciPipeline: "GitHub Actions workflow",
      docsStructure: ["README.md", "docs/api.md", "docs/deployment.md"],
    };
  }
}

export const scaffoldPlanner = new ScaffoldPlanner();
