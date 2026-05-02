import { ArchitectureProposal } from "./architecture-planner";
import { aiClient } from "../agent/opencode-client";

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
  async generate(architecture: ArchitectureProposal): Promise<ScaffoldingPlan> {
    if (!aiClient.isConfigured()) {
      return this.fallback();
    }

    try {
      const response = await aiClient.chat({
        messages: [
          {
            role: "system",
            content:
              'You are a senior DevOps engineer and project scaffolder. Given an architecture proposal, produce a detailed scaffolding plan as a JSON object.\n\nBe SPECIFIC and COMPLETE. Include actual file paths, actual package names with versions, actual configuration values, and actual script commands.\n\nRequired JSON fields:\n- repoStructure (string[]): Complete directory tree with every directory and key file. Use tree format: "src/", "src/server.ts", "src/config/env.ts", etc. Include tests, docs, scripts, docker, ci directories.\n- packages (string[]): List EVERY package with specific versions. Group by: core, dev, testing, linting. Include the exact npm/pip/cargo package name and version.\n- envConfig (string[]): List EVERY environment variable with: name, description, type, default value, whether it\'s required, and example value. Include both dev and prod variations.\n- scripts (string[]): List every npm/make script with: name, command, description, and when to use it (dev, build, test, deploy, etc.).\n- dockerSetup (string): Provide the ACTUAL Dockerfile and docker-compose.yml content. Include multi-stage build, health checks, volume mounts, network configuration, and environment variable passthrough.\n- migrations (string[]): List every migration file with: filename, description, UP SQL, DOWN SQL. Include indexes, constraints, and foreign keys.\n- seedData (string[]): List every seed file with: filename, description, sample data. Include enough data for local development and testing.\n- testSetup (string): Specific test configuration. Include framework config, test directory structure, mock setup, fixture factories, helper functions, and CI integration.\n- linting (string): Actual ESLint/Biome/Ruff config. Include rules, overrides for different file types, and integration with CI.\n- formatting (string): Actual Prettier/Black config. Include print width, tab width, semicolons, trailing commas, etc.\n- ciPipeline (string): Actual CI pipeline YAML. Include stages: lint, typecheck, test, build, deploy. Include caching, parallel jobs, and artifact publishing.\n- docsStructure (string[]): List every documentation file with: filename, description, and what content it should contain.\n\nRespond with ONLY the JSON object, no markdown fences.',
          },
          {
            role: "user",
            content: `Generate a scaffolding plan for this architecture:\n\n${JSON.stringify(architecture, null, 2)}`,
          },
        ],
        temperature: 0.7,
      });

      const content = response.content.trim();
      const jsonStr = content
        .replace(/^```json?\n?/, "")
        .replace(/\n?```$/, "");
      const parsed = JSON.parse(jsonStr);

      return {
        repoStructure: parsed.repoStructure || [],
        packages: parsed.packages || [],
        envConfig: parsed.envConfig || [],
        scripts: parsed.scripts || [],
        dockerSetup: parsed.dockerSetup || "",
        migrations: parsed.migrations || [],
        seedData: parsed.seedData || [],
        testSetup: parsed.testSetup || "",
        linting: parsed.linting || "",
        formatting: parsed.formatting || "",
        ciPipeline: parsed.ciPipeline || "",
        docsStructure: parsed.docsStructure || [],
      };
    } catch (error) {
      console.error(
        "[Scaffold Planner] AI generation failed, using fallback:",
        error,
      );
      return this.fallback();
    }
  }

  private fallback(): ScaffoldingPlan {
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
      migrations: ["001_initial.sql"],
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
