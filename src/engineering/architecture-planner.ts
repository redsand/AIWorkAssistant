import { WorkflowBrief } from "./workflow-brief";
import { aiClient } from "../agent/opencode-client";

export interface ArchitectureProposal {
  recommendedStack: {
    backend?: string;
    frontend?: string;
    database?: string;
    queue?: string;
    cache?: string;
  };
  systemBoundaries: string[];
  dataModel: string;
  apiDesign: string;
  eventModel: string;
  backgroundJobs: string[];
  integrations: string[];
  authStrategy: string;
  errorHandling: string;
  observability: string;
  deploymentModel: string;
  security: string;
  privacy: string;
  testingStrategy: string;
}

class ArchitecturePlanner {
  async generate(workflowBrief: WorkflowBrief): Promise<ArchitectureProposal> {
    if (!aiClient.isConfigured()) {
      return this.fallback();
    }

    try {
      const response = await aiClient.chat({
        messages: [
          {
            role: "system",
            content:
              "You are a senior architect. Given a workflow brief, produce an architecture proposal as a JSON object with these exact fields: recommendedStack ({backend, frontend, database, queue, cache}), systemBoundaries (string[]), dataModel (string), apiDesign (string), eventModel (string), backgroundJobs (string[]), integrations (string[]), authStrategy (string), errorHandling (string), observability (string), deploymentModel (string), security (string), privacy (string), testingStrategy (string). Respond with ONLY the JSON object, no markdown fences.",
          },
          {
            role: "user",
            content: `Generate an architecture proposal for this workflow brief:\n\n${JSON.stringify(workflowBrief, null, 2)}`,
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
        recommendedStack: parsed.recommendedStack || {},
        systemBoundaries: parsed.systemBoundaries || [],
        dataModel: parsed.dataModel || "",
        apiDesign: parsed.apiDesign || "",
        eventModel: parsed.eventModel || "",
        backgroundJobs: parsed.backgroundJobs || [],
        integrations: parsed.integrations || [],
        authStrategy: parsed.authStrategy || "",
        errorHandling: parsed.errorHandling || "",
        observability: parsed.observability || "",
        deploymentModel: parsed.deploymentModel || "",
        security: parsed.security || "",
        privacy: parsed.privacy || "",
        testingStrategy: parsed.testingStrategy || "",
      };
    } catch (error) {
      console.error(
        "[Architecture Planner] AI generation failed, using fallback:",
        error,
      );
      return this.fallback();
    }
  }

  private fallback(): ArchitectureProposal {
    return {
      recommendedStack: {
        backend: "TypeScript + Fastify",
        frontend: "React + TypeScript",
        database: "PostgreSQL",
        queue: "Redis + Bull",
        cache: "Redis",
      },
      systemBoundaries: ["API Gateway", "Core Service", "Worker Service"],
      dataModel: "To be designed based on workflow brief",
      apiDesign: "REST API with JSON",
      eventModel: "Event-driven architecture",
      backgroundJobs: ["Job processing", "Notifications", "Cleanup"],
      integrations: ["To be determined"],
      authStrategy: "OAuth 2.0 + JWT",
      errorHandling: "Global error handler + retry logic",
      observability: "Logging + metrics + tracing",
      deploymentModel: "Docker containers",
      security: "Input validation + RBAC + encryption",
      privacy: "Data minimization + compliance",
      testingStrategy: "Unit + integration + E2E tests",
    };
  }
}

export const architecturePlanner = new ArchitecturePlanner();
