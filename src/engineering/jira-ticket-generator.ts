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
        const description = [
          ticket.description,
          "",
          "## Acceptance Criteria",
          ...ticket.acceptanceCriteria.map((c) => `- ${c}`),
        ].join("\n");

        const result = await jiraService.createIssue(
          {
            project: projectKey,
            summary: ticket.summary,
            description,
            issueType: ticket.issueType,
          },
          userId,
        );

        if ("approval" in result) {
          tickets.push({
            summary: ticket.summary,
            status: "pending_approval",
            approvalId: result.approval.id,
          });
        } else {
          tickets.push({
            key: (result as any).key,
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
