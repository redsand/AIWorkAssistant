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
              "You are a senior developer. Given an architecture proposal, produce a scaffolding plan as a JSON object with these exact fields: repoStructure (string[]), packages (string[]), envConfig (string[]), scripts (string[]), dockerSetup (string), migrations (string[]), seedData (string[]), testSetup (string), linting (string), formatting (string), ciPipeline (string), docsStructure (string[]). Respond with ONLY the JSON object, no markdown fences.",
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
