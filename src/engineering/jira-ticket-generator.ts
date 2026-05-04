import { jiraService } from "../integrations/jira/jira-service";

interface ImplementationPlan {
  milestones: string[];
  firstVerticalSlice: string;
  tickets: Array<{
    summary: string;
    description: string;
    issueType: string;
    acceptanceCriteria: string[];
    estimationPoints?: number;
    codingPrompt?: string;
  }>;
}

class JiraTicketGenerator {
  async generate(
    plan: ImplementationPlan,
    projectKey: string,
  ): Promise<ImplementationPlan> {
    console.log("[Jira Ticket Generator] Generating tickets for", projectKey);
    return plan;
  }

  async createTickets(
    plan: ImplementationPlan,
    projectKey: string,
    userId: string,
  ) {
    const tickets = [];

    for (const ticket of plan.tickets) {
      try {
        const descriptionParts = [
          ticket.description,
          "",
          "## Acceptance Criteria",
          ...ticket.acceptanceCriteria.map((c) => `- ${c}`),
        ];

        // Include coding prompt if provided, otherwise add placeholder
        if (ticket.codingPrompt) {
          descriptionParts.push(
            "",
            "## Coding Prompt",
            "",
            ticket.codingPrompt,
          );
        } else {
          descriptionParts.push(
            "",
            "## Coding Prompt",
            "",
            "⚠️ **No coding prompt provided.** Add a self-contained specification with:",
            "- **File path** — exact file(s) to modify",
            "- **Current code** — the code as it exists now (with line numbers)",
            "- **Replacement code** — the new code",
            "- **Reasoning** — why this change solves the problem",
            "",
            "See [docs/creating-tickets.md](../docs/creating-tickets.md) for guidance.",
          );
        }

        const description = descriptionParts.join("\n");

        const result = await jiraService.createIssue(
          {
            project: projectKey,
            summary: ticket.summary,
            description,
            issueType: ticket.issueType,
          },
          userId,
        );

        if (result && typeof result === "object" && "approval" in result) {
          tickets.push({
            summary: ticket.summary,
            status: "pending_approval",
            approvalId: (result as { approval: { id: string } }).approval.id,
          });
        } else {
          tickets.push({
            key: (result as { key: string }).key,
            summary: ticket.summary,
            status: "created",
          });
        }
      } catch (error) {
        console.error(`Failed to create ticket: ${ticket.summary}`, error);
        tickets.push({
          summary: ticket.summary,
          status: "failed",
          error: (error as Error).message,
        });
      }
    }

    return tickets;
  }
}

export const jiraTicketGenerator = new JiraTicketGenerator();