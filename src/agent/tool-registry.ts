/**
 * Tool registry: defines available tools for each agent mode
 */

import { AGENT_MODES } from "../config/constants";

export interface Tool {
  name: string;
  description: string;
  params: Record<
    string,
    { type: string; description: string; required?: boolean }
  >;
  actionType: string;
  riskLevel: "low" | "medium" | "high";
}

/**
 * Tools available in Productivity Mode
 */
const PRODUCTIVITY_TOOLS: Tool[] = [
  // Calendar tools
  {
    name: "calendar.list_events",
    description: "List calendar events for a date range",
    params: {
      startDate: {
        type: "string",
        description: "Start date (ISO 8601)",
        required: true,
      },
      endDate: {
        type: "string",
        description: "End date (ISO 8601)",
        required: true,
      },
    },
    actionType: "calendar.event.list",
    riskLevel: "low",
  },
  {
    name: "calendar.create_focus_block",
    description: "Create a focus block for deep work",
    params: {
      title: {
        type: "string",
        description: "Focus block title",
        required: true,
      },
      startTime: {
        type: "string",
        description: "Start time (ISO 8601)",
        required: true,
      },
      duration: {
        type: "number",
        description: "Duration in minutes",
        required: true,
      },
      description: {
        type: "string",
        description: "What to work on",
        required: false,
      },
    },
    actionType: "calendar.focus_block.create",
    riskLevel: "medium",
  },
  {
    name: "calendar.create_health_block",
    description: "Create a health/fitness/mental health block",
    params: {
      title: { type: "string", description: "Block title", required: true },
      startTime: {
        type: "string",
        description: "Start time (ISO 8601)",
        required: true,
      },
      duration: {
        type: "number",
        description: "Duration in minutes",
        required: true,
      },
      type: {
        type: "string",
        description: "Type: fitness, meal, mental_health",
        required: true,
      },
    },
    actionType: "calendar.health_block.create",
    riskLevel: "medium",
  },

  // Jira tools
  {
    name: "jira.list_assigned",
    description: "List Jira issues assigned to user",
    params: {
      status: {
        type: "string",
        description: "Filter by status",
        required: false,
      },
      limit: { type: "number", description: "Max results", required: false },
    },
    actionType: "jira.issue.search",
    riskLevel: "low",
  },
  {
    name: "jira.get_issue",
    description: "Get details of a Jira issue",
    params: {
      key: {
        type: "string",
        description: "Jira issue key (e.g., PROJ-123)",
        required: true,
      },
    },
    actionType: "jira.issue.read",
    riskLevel: "low",
  },
  {
    name: "jira.add_comment",
    description: "Add comment to Jira issue",
    params: {
      key: { type: "string", description: "Jira issue key", required: true },
      body: { type: "string", description: "Comment body", required: true },
    },
    actionType: "jira.comment.create",
    riskLevel: "medium",
  },
  {
    name: "jira.transition_issue",
    description: "Transition Jira issue to new status",
    params: {
      key: { type: "string", description: "Jira issue key", required: true },
      transition: {
        type: "string",
        description: "Target status",
        required: true,
      },
      comment: {
        type: "string",
        description: "Optional comment",
        required: false,
      },
    },
    actionType: "jira.issue.transition",
    riskLevel: "high",
  },
  {
    name: "jira.list_projects",
    description: "List all accessible Jira projects",
    params: {},
    actionType: "jira.project.read",
    riskLevel: "low",
  },
  {
    name: "jira.get_project",
    description: "Get details of a Jira project by key",
    params: {
      key: {
        type: "string",
        description: "Jira project key (e.g., SOCAI)",
        required: true,
      },
    },
    actionType: "jira.project.read",
    riskLevel: "low",
  },
  {
    name: "jira.create_project",
    description: "Create a new Jira project",
    params: {
      key: {
        type: "string",
        description: "Project key (2-10 uppercase letters, e.g., SOCAI)",
        required: true,
      },
      name: { type: "string", description: "Project name", required: true },
      projectType: {
        type: "string",
        description: "Project type: software, business, or service_desk",
        required: false,
      },
      description: {
        type: "string",
        description: "Project description",
        required: false,
      },
    },
    actionType: "jira.project.create",
    riskLevel: "medium",
  },
  {
    name: "jira.create_issue",
    description:
      "Create a new Jira issue/ticket in a project. Use this when the user asks to create a ticket, bug, task, or story.",
    params: {
      project: {
        type: "string",
        description: "Jira project key (e.g., SIEM, IR, MDR)",
        required: true,
      },
      summary: {
        type: "string",
        description: "Issue title/summary",
        required: true,
      },
      description: {
        type: "string",
        description: "Detailed description of the issue",
        required: false,
      },
      issueType: {
        type: "string",
        description:
          "Issue type (e.g., Task, Bug, Story, Epic). Defaults to Task.",
        required: false,
      },
      assignee: {
        type: "string",
        description: "Username or email to assign the issue to",
        required: false,
      },
      priority: {
        type: "string",
        description:
          "Priority level (e.g., Highest, High, Medium, Low, Lowest)",
        required: false,
      },
      labels: {
        type: "string",
        description: "Comma-separated list of labels to apply",
        required: false,
      },
    },
    actionType: "jira.issue.create",
    riskLevel: "medium",
  },
  {
    name: "jira.update_issue",
    description:
      "Update fields on an existing Jira issue (summary, description, assignee, priority, labels, etc.)",
    params: {
      key: {
        type: "string",
        description: "Jira issue key (e.g., SIEM-123)",
        required: true,
      },
      summary: {
        type: "string",
        description: "New summary/title",
        required: false,
      },
      description: {
        type: "string",
        description: "New description",
        required: false,
      },
      assignee: {
        type: "string",
        description: "Username or email to reassign to",
        required: false,
      },
      priority: {
        type: "string",
        description: "Priority level (Highest, High, Medium, Low, Lowest)",
        required: false,
      },
      labels: {
        type: "string",
        description: "Comma-separated list of labels",
        required: false,
      },
    },
    actionType: "jira.issue.update",
    riskLevel: "medium",
  },
  {
    name: "jira.close_issue",
    description:
      "Close/resolve a Jira issue by transitioning it to Done or Closed status",
    params: {
      key: {
        type: "string",
        description: "Jira issue key (e.g., SIEM-123)",
        required: true,
      },
      comment: {
        type: "string",
        description: "Optional comment explaining why it was closed",
        required: false,
      },
    },
    actionType: "jira.issue.transition",
    riskLevel: "medium",
  },
  {
    name: "jira.search_issues",
    description:
      "Search for Jira issues using JQL (Jira Query Language). Use for finding issues by status, assignee, project, text, etc.",
    params: {
      jql: {
        type: "string",
        description:
          'JQL query (e.g., "project = SIEM AND status = Open ORDER BY created DESC")',
        required: true,
      },
      limit: {
        type: "number",
        description: "Maximum number of results (default 20)",
        required: false,
      },
    },
    actionType: "jira.issue.read",
    riskLevel: "low",
  },
  {
    name: "jira.list_transitions",
    description:
      "List available status transitions for a Jira issue (shows what statuses you can move it to)",
    params: {
      key: {
        type: "string",
        description: "Jira issue key (e.g., SIEM-123)",
        required: true,
      },
    },
    actionType: "jira.issue.read",
    riskLevel: "low",
  },
  {
    name: "jira.get_comments",
    description: "List comments on a Jira issue",
    params: {
      key: {
        type: "string",
        description: "Jira issue key (e.g., SIEM-123)",
        required: true,
      },
    },
    actionType: "jira.issue.read",
    riskLevel: "low",
  },

  // GitLab tools
  {
    name: "gitlab.list_merge_requests",
    description: "List merge requests",
    params: {
      status: {
        type: "string",
        description: "opened, closed, merged",
        required: false,
      },
      limit: { type: "number", description: "Max results", required: false },
    },
    actionType: "gitlab.mr.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.get_commit",
    description: "Get commit details",
    params: {
      projectId: {
        type: "string",
        description: "Project ID or path",
        required: true,
      },
      sha: { type: "string", description: "Commit SHA", required: true },
    },
    actionType: "gitlab.commit.read",
    riskLevel: "low",
  },

  // Planning tools
  {
    name: "productivity.generate_daily_plan",
    description: "Generate daily productivity plan",
    params: {
      date: { type: "string", description: "Date (ISO 8601)", required: true },
      includeJira: {
        type: "boolean",
        description: "Include Jira tickets",
        required: false,
      },
      includeGitLab: {
        type: "boolean",
        description: "Include GitLab activity",
        required: false,
      },
    },
    actionType: "productivity.plan.generate",
    riskLevel: "low",
  },
];

/**
 * Tools available in Engineering Strategy Mode
 */
const ENGINEERING_TOOLS: Tool[] = [
  {
    name: "engineering.workflow_brief",
    description: "Generate workflow brief for project idea",
    params: {
      idea: {
        type: "string",
        description: "Project idea description",
        required: true,
      },
    },
    actionType: "engineering.workflow.brief",
    riskLevel: "low",
  },
  {
    name: "engineering.architecture_proposal",
    description: "Generate architecture proposal",
    params: {
      workflowBrief: {
        type: "string",
        description: "Workflow brief JSON",
        required: true,
      },
    },
    actionType: "engineering.architecture.proposal",
    riskLevel: "low",
  },
  {
    name: "engineering.scaffolding_plan",
    description: "Generate scaffolding plan",
    params: {
      architecture: {
        type: "string",
        description: "Architecture proposal JSON",
        required: true,
      },
    },
    actionType: "engineering.scaffolding.plan",
    riskLevel: "low",
  },
  {
    name: "engineering.jira_tickets",
    description: "Generate Jira tickets from implementation plan",
    params: {
      plan: {
        type: "string",
        description: "Implementation plan JSON",
        required: true,
      },
      projectKey: {
        type: "string",
        description: "Jira project key",
        required: true,
      },
    },
    actionType: "engineering.jira.tickets",
    riskLevel: "low",
  },
];

/**
 * Get tools by mode
 */
export function getTools(mode: string): Tool[] {
  switch (mode) {
    case AGENT_MODES.PRODUCTIVITY:
      return PRODUCTIVITY_TOOLS;
    case AGENT_MODES.ENGINEERING:
      return ENGINEERING_TOOLS;
    default:
      return [];
  }
}

/**
 * Get tool by name
 */
export function getTool(name: string, mode: string): Tool | undefined {
  const tools = getTools(mode);
  return tools.find((t) => t.name === name);
}

/**
 * Get all tools (for OpenClaw registration)
 */
export function getAllTools(): Tool[] {
  return [...PRODUCTIVITY_TOOLS, ...ENGINEERING_TOOLS];
}
