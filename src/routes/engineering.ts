import { FastifyInstance } from "fastify";
import { opencodeClient } from "../agent/opencode-client";
import {
  workflowBriefGenerator,
  WorkflowBrief,
} from "../engineering/workflow-brief";
import {
  architecturePlanner,
  ArchitectureProposal,
} from "../engineering/architecture-planner";
import { scaffoldPlanner } from "../engineering/scaffold-planner";
import { jiraTicketGenerator } from "../engineering/jira-ticket-generator";

export async function engineeringRoutes(fastify: FastifyInstance) {
  fastify.post("/engineering/workflow-brief", async (request, _reply) => {
    const { idea } = request.body as { idea: string };

    if (!idea) {
      return { success: false, error: "idea is required" };
    }

    if (opencodeClient.isConfigured()) {
      try {
        const response = await opencodeClient.chat({
          messages: [
            {
              role: "system",
              content: `You are an expert workflow analyst. Given a project idea, produce a JSON workflow brief with these fields: problem (string), users (string array), jobsToBeDone (string array), currentWorkflow (string), desiredWorkflow (string), frictionPoints (string array), decisions (string array), inputs (string array), outputs (string array), states (string array), transitions (string array), edgeCases (string array), humanInTheLoop (string array), automationOpportunities (string array), guardrails (string array). Return ONLY valid JSON, no markdown.`,
            },
            { role: "user", content: idea },
          ],
          temperature: 0.5,
        });

        const content = response.content.trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const brief: WorkflowBrief = JSON.parse(jsonMatch[0]);
          return { success: true, brief, source: "ai" };
        }
      } catch (error) {
        console.error(
          "[Engineering] AI workflow brief generation failed, using fallback:",
          (error as Error).message,
        );
      }
    }

    const brief = await workflowBriefGenerator.generate(idea);
    return { success: true, brief, source: "fallback" };
  });

  fastify.post(
    "/engineering/architecture-proposal",
    async (request, _reply) => {
      const { brief } = request.body as { brief: WorkflowBrief };

      if (!brief) {
        return { success: false, error: "brief is required" };
      }

      if (opencodeClient.isConfigured()) {
        try {
          const response = await opencodeClient.chat({
            messages: [
              {
                role: "system",
                content: `You are an expert software architect. Given a workflow brief, produce a JSON architecture proposal with these fields: recommendedStack (object with backend, frontend, database, queue, cache strings), systemBoundaries (string array), dataModel (string), apiDesign (string), eventModel (string), backgroundJobs (string array), integrations (string array), authStrategy (string), errorHandling (string), observability (string), deploymentModel (string), security (string), privacy (string), testingStrategy (string). Return ONLY valid JSON, no markdown.`,
              },
              { role: "user", content: JSON.stringify(brief) },
            ],
            temperature: 0.5,
          });

          const content = response.content.trim();
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const proposal: ArchitectureProposal = JSON.parse(jsonMatch[0]);
            return { success: true, proposal, source: "ai" };
          }
        } catch (error) {
          console.error(
            "[Engineering] AI architecture generation failed, using fallback:",
            (error as Error).message,
          );
        }
      }

      const proposal = await architecturePlanner.generate(brief);
      return { success: true, proposal, source: "fallback" };
    },
  );

  fastify.post("/engineering/scaffolding-plan", async (request, _reply) => {
    const { architecture } = request.body as {
      architecture: ArchitectureProposal;
    };

    if (!architecture) {
      return { success: false, error: "architecture is required" };
    }

    if (opencodeClient.isConfigured()) {
      try {
        const response = await opencodeClient.chat({
          messages: [
            {
              role: "system",
              content: `You are an expert project scaffolder. Given an architecture proposal, produce a JSON scaffolding plan with these fields: repoStructure (string array of file paths), packages (string array of npm packages), envConfig (string array of env var names), scripts (string array of npm script names), dockerSetup (string), migrations (string array of migration file names), seedData (string array), testSetup (string), linting (string), formatting (string), ciPipeline (string), docsStructure (string array). Return ONLY valid JSON, no markdown.`,
            },
            { role: "user", content: JSON.stringify(architecture) },
          ],
          temperature: 0.5,
        });

        const content = response.content.trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const plan = JSON.parse(jsonMatch[0]);
          return { success: true, plan, source: "ai" };
        }
      } catch (error) {
        console.error(
          "[Engineering] AI scaffold generation failed, using fallback:",
          (error as Error).message,
        );
      }
    }

    const plan = await scaffoldPlanner.generate(architecture);
    return { success: true, plan, source: "fallback" };
  });

  fastify.post("/engineering/jira-tickets", async (request, _reply) => {
    const { plan, projectKey } = request.body as {
      plan: {
        milestones: string[];
        firstVerticalSlice: string;
        tickets: Array<{
          summary: string;
          description: string;
          issueType: string;
          acceptanceCriteria: string[];
          estimationPoints?: number;
        }>;
      };
      projectKey: string;
    };

    if (!plan || !projectKey) {
      return { success: false, error: "plan and projectKey are required" };
    }

    const enhancedPlan = await jiraTicketGenerator.generate(plan, projectKey);
    return { success: true, plan: enhancedPlan, source: "fallback" };
  });

  fastify.post("/engineering/jira-tickets/create", async (request, _reply) => {
    const { plan, projectKey, userId } = request.body as {
      plan: any;
      projectKey: string;
      userId: string;
    };

    if (!plan || !projectKey || !userId) {
      return {
        success: false,
        error: "plan, projectKey, and userId are required",
      };
    }

    const result = await jiraTicketGenerator.createTickets(
      plan,
      projectKey,
      userId,
    );
    return { success: true, tickets: result };
  });
}
