/**
 * Tool registry: defines available tools for each agent mode
 */

import { AGENT_MODES } from "../config/constants";
import type { Platform } from "../policy/types";

export interface Tool {
  name: string;
  description: string;
  params: Record<
    string,
    { type: string; description: string; required?: boolean }
  >;
  actionType: string;
  riskLevel: "low" | "medium" | "high";
  /** Optional override — if not set, platform is derived from the tool name prefix */
  platform?: Platform;
}

const PLATFORM_PREFIX_MAP: Record<string, Platform> = {
  github: "github",
  gitlab: "gitlab",
  jira: "jira",
  jitbit: "jitbit",
  calendar: "calendar",
  web: "web",
  local: "local",
  lsp: "lsp",
  codex: "codex",
  mcp: "mcp",
  productivity: "cross-platform",
  engineering: "cross-platform",
  cto: "cross-platform",
  personal_os: "cross-platform",
  roadmap: "cross-platform",
  todo: "cross-platform",
  knowledge: "cross-platform",
  codebase: "cross-platform",
  graph: "cross-platform",
  system: "cross-platform",
  agent: "cross-platform",
  workflow: "cross-platform",
  product: "cross-platform",
  hawk_ir: "hawk-ir",
  discover: "cross-platform",
  code_review: "cross-platform",
  ticket_bridge: "cross-platform",
};

export function getPlatformForToolName(toolName: string): Platform {
  const dotIndex = toolName.indexOf(".");
  const prefix = dotIndex > 0 ? toolName.substring(0, dotIndex) : toolName;
  return PLATFORM_PREFIX_MAP[prefix] || "cross-platform";
}

export function getPlatformForTool(tool: Tool): Platform {
  return tool.platform || getPlatformForToolName(tool.name);
}

export function getToolsByPlatform(
  mode: string,
  platform: Platform,
): Tool[] {
  return getAllToolsForMode(mode).filter(
    (t) => getPlatformForTool(t) === platform,
  );
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
      dryRun: {
        type: "boolean",
        description: "Preview what would happen without executing",
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
      dryRun: {
        type: "boolean",
        description: "Preview what would happen without executing",
        required: false,
      },
    },
    actionType: "calendar.health_block.create",
    riskLevel: "medium",
  },
  {
    name: "calendar.create_event",
    description: "Create a generic calendar event (meeting, appointment, etc.)",
    params: {
      summary: {
        type: "string",
        description: "Event title/summary",
        required: true,
      },
      startTime: {
        type: "string",
        description: "Start time (ISO 8601)",
        required: true,
      },
      endTime: {
        type: "string",
        description: "End time (ISO 8601)",
        required: true,
      },
      description: {
        type: "string",
        description: "Event description",
        required: false,
      },
      location: {
        type: "string",
        description: "Event location",
        required: false,
      },
      type: {
        type: "string",
        description: "Event type: meeting, focus, fitness, meal, mental_health, other. Default: meeting",
        required: false,
      },
    },
    actionType: "calendar.event.create",
    riskLevel: "medium",
  },
  {
    name: "calendar.update_event",
    description: "Update an existing calendar event",
    params: {
      eventId: {
        type: "string",
        description: "Event ID to update",
        required: true,
      },
      summary: {
        type: "string",
        description: "Updated event title",
        required: false,
      },
      startTime: {
        type: "string",
        description: "Updated start time (ISO 8601)",
        required: false,
      },
      endTime: {
        type: "string",
        description: "Updated end time (ISO 8601)",
        required: false,
      },
      description: {
        type: "string",
        description: "Updated description",
        required: false,
      },
      location: {
        type: "string",
        description: "Updated location",
        required: false,
      },
    },
    actionType: "calendar.event.update",
    riskLevel: "medium",
  },
  {
    name: "calendar.delete_event",
    description: "Delete a calendar event by ID",
    params: {
      eventId: {
        type: "string",
        description: "Event ID to delete",
        required: true,
      },
    },
    actionType: "calendar.event.delete",
    riskLevel: "high",
  },
  {
    name: "calendar.get_event",
    description: "Get a single calendar event by ID",
    params: {
      eventId: {
        type: "string",
        description: "Event ID to retrieve",
        required: true,
      },
    },
    actionType: "calendar.event.read",
    riskLevel: "low",
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
      dryRun: {
        type: "boolean",
        description: "Preview what would happen without executing",
        required: false,
      },
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
      dryRun: {
        type: "boolean",
        description: "Preview what would happen without executing",
        required: false,
      },
    },
    actionType: "jira.issue.create",
    riskLevel: "medium",
  },
  {
    name: "jira.create_issues",
    description:
      "Bulk create multiple Jira issues at once. Pass an array of issues with project, summary, description, issueType, and assignee. Use this instead of calling jira.create_issue multiple times when creating several tickets.",
    params: {
      issues: {
        type: "array",
        description:
          'JSON array of issue objects: [{"project":"IR","summary":"Title","description":"Details","issueType":"Story","assignee":"user"}]',
        required: true,
      },
    },
    actionType: "jira.issue.bulk_create",
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
      dryRun: {
        type: "boolean",
        description: "Preview what would happen without executing",
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
      dryRun: {
        type: "boolean",
        description: "Preview what would happen without executing",
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
    name: "gitlab.list_projects",
    description: "List GitLab projects you have access to",
    params: {},
    actionType: "gitlab.project.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.get_project",
    description:
      "Get details of a GitLab project by ID or path (e.g., 'siem' or 'hawkio/soc-agent')",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path (e.g., 'siem'). Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
    },
    actionType: "gitlab.project.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.list_merge_requests",
    description:
      "List merge requests for a GitLab project. Can filter by state (opened, closed, merged, all).",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      state: {
        type: "string",
        description:
          "Filter by state: opened, closed, merged, all. Defaults to opened.",
        required: false,
      },
    },
    actionType: "gitlab.mr.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.get_merge_request",
    description:
      "Get details of a specific merge request by its IID (e.g., !142)",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      mrIid: {
        type: "number",
        description: "Merge request IID (e.g., 142 for !142)",
        required: true,
      },
    },
    actionType: "gitlab.mr.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.create_merge_request",
    description: "Create a new merge request in a GitLab project",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      sourceBranch: {
        type: "string",
        description: "Source branch name",
        required: true,
      },
      targetBranch: {
        type: "string",
        description: "Target branch name (usually 'main' or 'master')",
        required: true,
      },
      title: {
        type: "string",
        description: "Merge request title",
        required: true,
      },
      description: {
        type: "string",
        description: "Merge request description (markdown)",
        required: false,
      },
      labels: {
        type: "string",
        description: "Comma-separated list of labels",
        required: false,
      },
      removeSourceBranch: {
        type: "boolean",
        description: "Remove source branch after merge (default: false)",
        required: false,
      },
      squash: {
        type: "boolean",
        description: "Squash commits on merge (default: false)",
        required: false,
      },
      dryRun: {
        type: "boolean",
        description: "Preview what would happen without executing",
        required: false,
      },
    },
    actionType: "gitlab.mr.create",
    riskLevel: "medium",
  },
  {
    name: "gitlab.merge_merge_request",
    description:
      "Accept/merge a merge request. The MR must be in a mergeable state.",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      mrIid: {
        type: "number",
        description: "Merge request IID (e.g., 142 for !142)",
        required: true,
      },
      squashCommitMessage: {
        type: "string",
        description: "Custom squash commit message (if squashing)",
        required: false,
      },
      shouldRemoveSourceBranch: {
        type: "boolean",
        description: "Remove source branch after merge",
        required: false,
      },
    },
    actionType: "gitlab.mr.merge",
    riskLevel: "high",
  },
  {
    name: "gitlab.add_mr_comment",
    description: "Add a comment to a merge request",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      mrIid: {
        type: "number",
        description: "Merge request IID",
        required: true,
      },
      body: {
        type: "string",
        description: "Comment body (markdown)",
        required: true,
      },
      dryRun: {
        type: "boolean",
        description: "Preview what would happen without executing",
        required: false,
      },
    },
    actionType: "gitlab.mr.comment",
    riskLevel: "medium",
  },
  {
    name: "gitlab.list_branches",
    description: "List branches in a GitLab project",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
    },
    actionType: "gitlab.branch.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.list_commits",
    description: "List commits for a branch in a GitLab project. If you don't know the project ID, call gitlab.list_projects first to find it.",
    params: {
      projectId: {
        type: "string",
        description:
          "Numeric project ID or URL-encoded path. If you only know the project name, call gitlab.list_projects first. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      ref: {
        type: "string",
        description: "Branch name or ref (defaults to main/master)",
        required: false,
      },
      since: {
        type: "string",
        description: "Only commits after this date (ISO 8601)",
        required: false,
      },
    },
    actionType: "gitlab.commit.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.get_commit",
    description: "Get details of a specific commit by SHA",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      sha: {
        type: "string",
        description: "Commit SHA (full or short)",
        required: true,
      },
    },
    actionType: "gitlab.commit.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.list_pipelines",
    description:
      "List CI/CD pipelines for a GitLab project, optionally filtered by branch",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      ref: {
        type: "string",
        description: "Filter by branch/ref name",
        required: false,
      },
    },
    actionType: "gitlab.pipeline.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.get_file",
    description:
      "Get a file from the repository (returns decoded file content)",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      filePath: {
        type: "string",
        description:
          "Path to the file in the repository (e.g., 'src/index.ts')",
        required: true,
      },
      ref: {
        type: "string",
        description: "Branch name or ref (defaults to main/master)",
        required: false,
      },
    },
    actionType: "gitlab.file.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.list_tree",
    description:
      "List files and directories in a GitLab repository. Use this to explore the repository structure before fetching specific files. Returns items with type 'tree' (directory) or 'blob' (file). Set recursive=true to get all files at once. All pages are fetched automatically.",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      path: {
        type: "string",
        description:
          "Subdirectory path to list (e.g., 'src', 'src/components'). Leave empty for root.",
        required: false,
      },
      ref: {
        type: "string",
        description: "Branch name or ref (defaults to default branch)",
        required: false,
      },
      recursive: {
        type: "boolean",
        description: "List all files recursively (not just one level)",
        required: false,
      },
    },
    actionType: "gitlab.repository.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.search_code",
    description:
      "Search for code in a GitLab project. Returns matching file paths and line snippets. Use this to find where functions, classes, or strings are defined.",
    params: {
      projectId: {
        type: "string",
        description:
          "Numeric project ID or URL-encoded path. If you only know the project name, call gitlab.list_projects first. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      query: {
        type: "string",
        description:
          "Search query - function name, class name, string literal, etc.",
        required: true,
      },
      ref: {
        type: "string",
        description: "Branch name or ref to search in",
        required: false,
      },
    },
    actionType: "gitlab.code.search",
    riskLevel: "low",
  },
  {
    name: "gitlab.create_branch",
    description: "Create a new branch in a GitLab project",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      branchName: {
        type: "string",
        description: "Name for the new branch (e.g., 'feature/new-login')",
        required: true,
      },
      ref: {
        type: "string",
        description:
          "Source branch or ref to create from (e.g., 'main', 'develop')",
        required: true,
      },
    },
    actionType: "gitlab.branch.create",
    riskLevel: "medium",
  },
  {
    name: "gitlab.get_mr_changes",
    description:
      "Get the diff/changes of a merge request - shows which files changed and the actual diff",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      mrIid: {
        type: "number",
        description: "Merge request IID (e.g., 142 for !142)",
        required: true,
      },
    },
    actionType: "gitlab.mr.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.list_mr_comments",
    description: "List comments/notes on a merge request",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      mrIid: {
        type: "number",
        description: "Merge request IID (e.g., 142 for !142)",
        required: true,
      },
    },
    actionType: "gitlab.mr.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.create_file",
    description:
      "Create a new file in the repository (creates a commit). Use this to add new files to a branch.",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      filePath: {
        type: "string",
        description: "Path for the new file (e.g., 'src/utils/helper.ts')",
        required: true,
      },
      content: {
        type: "string",
        description: "File content",
        required: true,
      },
      commitMessage: {
        type: "string",
        description: "Commit message for this change",
        required: true,
      },
      branch: {
        type: "string",
        description: "Target branch (must exist)",
        required: true,
      },
    },
    actionType: "gitlab.file.write",
    riskLevel: "high",
  },
  {
    name: "gitlab.update_file",
    description:
      "Update an existing file in the repository (creates a commit). Use this to modify file contents.",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      filePath: {
        type: "string",
        description: "Path to the file to update",
        required: true,
      },
      content: {
        type: "string",
        description: "New file content",
        required: true,
      },
      commitMessage: {
        type: "string",
        description: "Commit message for this change",
        required: true,
      },
      branch: {
        type: "string",
        description: "Target branch",
        required: true,
      },
    },
    actionType: "gitlab.file.write",
    riskLevel: "high",
  },
  {
    name: "gitlab.list_issues",
    description: "List GitLab project issues",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      state: {
        type: "string",
        description: "Filter by state: opened, closed, all",
        required: false,
      },
      labels: {
        type: "string",
        description: "Comma-separated label names to filter by",
        required: false,
      },
    },
    actionType: "gitlab.issue.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.get_issue",
    description: "Get details of a specific GitLab issue",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      issueIid: {
        type: "number",
        description: "Issue IID (e.g., 42 for #42)",
        required: true,
      },
    },
    actionType: "gitlab.issue.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.create_issue",
    description: "Create a new issue in a GitLab project",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      title: {
        type: "string",
        description: "Issue title",
        required: true,
      },
      description: {
        type: "string",
        description: "Issue description (markdown supported)",
        required: false,
      },
      labels: {
        type: "string",
        description: "Comma-separated list of labels",
        required: false,
      },
      dueDate: {
        type: "string",
        description: "Due date (ISO 8601 format, e.g., '2026-05-15')",
        required: false,
      },
    },
    actionType: "gitlab.issue.create",
    riskLevel: "medium",
  },
  {
    name: "gitlab.list_members",
    description: "List members of a GitLab project and their access levels",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
    },
    actionType: "gitlab.project.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.list_tags",
    description: "List repository tags (releases/versions)",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
    },
    actionType: "gitlab.tag.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.get_pipeline",
    description: "Get details of a specific CI/CD pipeline",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      pipelineId: {
        type: "number",
        description: "Pipeline ID",
        required: true,
      },
    },
    actionType: "gitlab.pipeline.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.list_pipeline_jobs",
    description: "List jobs in a specific CI/CD pipeline",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      pipelineId: {
        type: "number",
        description: "Pipeline ID",
        required: true,
      },
    },
    actionType: "gitlab.pipeline.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.retry_pipeline",
    description: "Retry a failed CI/CD pipeline",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      pipelineId: {
        type: "number",
        description: "Pipeline ID to retry",
        required: true,
      },
    },
    actionType: "gitlab.pipeline.write",
    riskLevel: "high",
  },
  {
    name: "gitlab.compare_refs",
    description:
      "Compare two branches, tags, or commits. Shows commits and file diffs between them.",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      from: {
        type: "string",
        description: "Source ref (branch, tag, or SHA)",
        required: true,
      },
      to: {
        type: "string",
        description: "Target ref (branch, tag, or SHA)",
        required: true,
      },
    },
    actionType: "gitlab.repository.read",
    riskLevel: "low",
  },
  {
    name: "gitlab.get_file_blame",
    description:
      "Get git blame for a file - shows which commit and author is responsible for each line",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
        required: false,
      },
      filePath: {
        type: "string",
        description: "Path to the file",
        required: true,
      },
      ref: {
        type: "string",
        description: "Branch name or ref",
        required: false,
      },
    },
    actionType: "gitlab.file.read",
    riskLevel: "low",
  },

  // ==================== GitHub Tools ====================
  {
    name: "github.list_repos",
    description: "List GitHub repositories accessible to you",
    params: {},
    actionType: "github.repo.read",
    riskLevel: "low",
  },
  {
    name: "github.get_repo",
    description:
      "Get details of a GitHub repository. Uses GITHUB_DEFAULT_OWNER/REPO if not specified.",
    params: {
      owner: {
        type: "string",
        description: "Repository owner (user or org)",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
    },
    actionType: "github.repo.read",
    riskLevel: "low",
  },
  {
    name: "github.list_tree",
    description:
      "List files and directories in a GitHub repository. Use to explore structure before fetching files.",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      path: {
        type: "string",
        description: "Subdirectory path to list. Leave empty for root.",
        required: false,
      },
      ref: {
        type: "string",
        description: "Branch, tag, or ref (defaults to default branch)",
        required: false,
      },
      recursive: {
        type: "boolean",
        description: "List all files recursively",
        required: false,
      },
    },
    actionType: "github.repo.read",
    riskLevel: "low",
  },
  {
    name: "github.search_code",
    description: "Search for code in a GitHub repository",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      query: { type: "string", description: "Search query", required: true },
    },
    actionType: "github.code.search",
    riskLevel: "low",
  },
  {
    name: "github.get_file",
    description:
      "Get a file from a GitHub repository (returns base64-encoded content)",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      filePath: {
        type: "string",
        description: "Path to the file",
        required: true,
      },
      ref: { type: "string", description: "Branch or ref", required: false },
    },
    actionType: "github.file.read",
    riskLevel: "low",
  },
  {
    name: "github.create_file",
    description: "Create a new file in a GitHub repository",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      filePath: {
        type: "string",
        description: "Path for the new file",
        required: true,
      },
      content: { type: "string", description: "File content", required: true },
      commitMessage: {
        type: "string",
        description: "Commit message",
        required: true,
      },
      branch: { type: "string", description: "Target branch", required: true },
    },
    actionType: "github.file.write",
    riskLevel: "high",
  },
  {
    name: "github.update_file",
    description: "Update an existing file in a GitHub repository",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      filePath: {
        type: "string",
        description: "Path to the file",
        required: true,
      },
      content: {
        type: "string",
        description: "New file content",
        required: true,
      },
      commitMessage: {
        type: "string",
        description: "Commit message",
        required: true,
      },
      branch: { type: "string", description: "Target branch", required: true },
      sha: {
        type: "string",
        description: "Current file SHA (required for updates)",
        required: true,
      },
    },
    actionType: "github.file.write",
    riskLevel: "high",
  },
  {
    name: "github.get_file_blame",
    description: "Get commit history for a file (git blame/annotate)",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      filePath: {
        type: "string",
        description: "Path to the file",
        required: true,
      },
      ref: { type: "string", description: "Branch or ref", required: false },
    },
    actionType: "github.file.read",
    riskLevel: "low",
  },
  {
    name: "github.list_branches",
    description: "List branches in a GitHub repository",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
    },
    actionType: "github.branch.read",
    riskLevel: "low",
  },
  {
    name: "github.create_branch",
    description: "Create a new branch in a GitHub repository",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      branchName: {
        type: "string",
        description: "Name for the new branch",
        required: true,
      },
      ref: {
        type: "string",
        description: "Source branch or SHA to create from",
        required: true,
      },
    },
    actionType: "github.branch.create",
    riskLevel: "medium",
  },
  {
    name: "github.list_tags",
    description: "List tags in a GitHub repository",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
    },
    actionType: "github.tag.read",
    riskLevel: "low",
  },
  {
    name: "github.list_commits",
    description: "List commits in a GitHub repository",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      ref: { type: "string", description: "Branch or ref", required: false },
      path: {
        type: "string",
        description: "Filter to commits touching this path",
        required: false,
      },
    },
    actionType: "github.commit.read",
    riskLevel: "low",
  },
  {
    name: "github.get_commit",
    description: "Get details of a specific commit",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      ref: { type: "string", description: "Commit SHA", required: true },
    },
    actionType: "github.commit.read",
    riskLevel: "low",
  },
  {
    name: "github.compare_refs",
    description: "Compare two branches, tags, or commits",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      base: { type: "string", description: "Base ref", required: true },
      head: { type: "string", description: "Head ref", required: true },
    },
    actionType: "github.repo.read",
    riskLevel: "low",
  },
  {
    name: "github.list_pull_requests",
    description: "List pull requests in a GitHub repository",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      state: {
        type: "string",
        description: "Filter: open, closed, all",
        required: false,
      },
    },
    actionType: "github.pr.read",
    riskLevel: "low",
  },
  {
    name: "github.get_pull_request",
    description: "Get details of a specific pull request",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      prNumber: {
        type: "number",
        description: "Pull request number",
        required: true,
      },
    },
    actionType: "github.pr.read",
    riskLevel: "low",
  },
  {
    name: "github.create_pull_request",
    description: "Create a new pull request",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      title: { type: "string", description: "PR title", required: true },
      body: {
        type: "string",
        description: "PR description (markdown)",
        required: false,
      },
      head: { type: "string", description: "Source branch", required: true },
      base: { type: "string", description: "Target branch", required: true },
      draft: {
        type: "boolean",
        description: "Create as draft PR",
        required: false,
      },
    },
    actionType: "github.pr.create",
    riskLevel: "medium",
  },
  {
    name: "github.merge_pull_request",
    description: "Merge a pull request",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      prNumber: {
        type: "number",
        description: "Pull request number",
        required: true,
      },
      mergeMethod: {
        type: "string",
        description: "Merge method: merge, squash, or rebase",
        required: false,
      },
      commitTitle: {
        type: "string",
        description: "Custom commit title",
        required: false,
      },
    },
    actionType: "github.pr.merge",
    riskLevel: "high",
  },
  {
    name: "github.list_pr_comments",
    description: "List review comments on a pull request",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      prNumber: {
        type: "number",
        description: "Pull request number",
        required: true,
      },
    },
    actionType: "github.pr.read",
    riskLevel: "low",
  },
  {
    name: "github.add_pr_comment",
    description: "Add a comment to a pull request",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      prNumber: {
        type: "number",
        description: "Pull request number",
        required: true,
      },
      body: {
        type: "string",
        description: "Comment body (markdown)",
        required: true,
      },
      dryRun: {
        type: "boolean",
        description: "Preview what would happen without executing",
        required: false,
      },
    },
    actionType: "github.pr.comment",
    riskLevel: "medium",
  },
  {
    name: "github.get_pr_files",
    description: "Get the files changed in a pull request",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      prNumber: {
        type: "number",
        description: "Pull request number",
        required: true,
      },
    },
    actionType: "github.pr.read",
    riskLevel: "low",
  },
  {
    name: "github.list_issues",
    description: "List issues in a GitHub repository",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      state: {
        type: "string",
        description: "Filter: open, closed, all",
        required: false,
      },
      labels: {
        type: "string",
        description: "Comma-separated label names",
        required: false,
      },
    },
    actionType: "github.issue.read",
    riskLevel: "low",
  },
  {
    name: "github.get_issue",
    description: "Get details of a specific issue",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      issueNumber: {
        type: "number",
        description: "Issue number",
        required: true,
      },
    },
    actionType: "github.issue.read",
    riskLevel: "low",
  },
  {
    name: "github.create_issue",
    description: "Create a new issue in a GitHub repository",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      title: { type: "string", description: "Issue title", required: true },
      body: {
        type: "string",
        description: "Issue description (markdown)",
        required: false,
      },
      labels: {
        type: "string",
        description: "Comma-separated list of labels",
        required: false,
      },
      assignees: {
        type: "string",
        description: "Comma-separated list of assignee usernames",
        required: false,
      },
      dryRun: {
        type: "boolean",
        description: "Preview what would happen without executing",
        required: false,
      },
    },
    actionType: "github.issue.create",
    riskLevel: "medium",
  },
  {
    name: "github.update_issue",
    description: "Update an issue (title, body, state, labels, assignees)",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      issueNumber: {
        type: "number",
        description: "Issue number",
        required: true,
      },
      title: { type: "string", description: "New title", required: false },
      body: { type: "string", description: "New body", required: false },
      state: { type: "string", description: "open or closed", required: false },
      labels: {
        type: "string",
        description: "Comma-separated labels",
        required: false,
      },
    },
    actionType: "github.issue.update",
    riskLevel: "medium",
  },
  {
    name: "github.list_issue_comments",
    description: "List comments on an issue",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      issueNumber: {
        type: "number",
        description: "Issue number",
        required: true,
      },
    },
    actionType: "github.issue.read",
    riskLevel: "low",
  },
  {
    name: "github.add_issue_comment",
    description: "Add a comment to an issue",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      issueNumber: {
        type: "number",
        description: "Issue number",
        required: true,
      },
      body: {
        type: "string",
        description: "Comment body (markdown)",
        required: true,
      },
    },
    actionType: "github.issue.comment",
    riskLevel: "medium",
  },
  {
    name: "github.list_collaborators",
    description: "List collaborators on a GitHub repository",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
    },
    actionType: "github.repo.read",
    riskLevel: "low",
  },
  {
    name: "github.list_workflows",
    description: "List GitHub Actions workflows in a repository",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
    },
    actionType: "github.actions.read",
    riskLevel: "low",
  },
  {
    name: "github.list_workflow_runs",
    description: "List GitHub Actions workflow runs",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      workflowId: {
        type: "string",
        description:
          "Workflow ID or filename (optional, lists all runs if omitted)",
        required: false,
      },
    },
    actionType: "github.actions.read",
    riskLevel: "low",
  },
  {
    name: "github.get_workflow_run",
    description: "Get details of a specific GitHub Actions workflow run",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      runId: { type: "number", description: "Workflow run ID", required: true },
    },
    actionType: "github.actions.read",
    riskLevel: "low",
  },
  {
    name: "github.list_workflow_run_jobs",
    description: "List jobs in a GitHub Actions workflow run",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      runId: { type: "number", description: "Workflow run ID", required: true },
    },
    actionType: "github.actions.read",
    riskLevel: "low",
  },
  {
    name: "github.rerun_workflow",
    description: "Re-run a failed GitHub Actions workflow",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      runId: {
        type: "number",
        description: "Workflow run ID to re-run",
        required: true,
      },
    },
    actionType: "github.actions.write",
    riskLevel: "high",
  },
  {
    name: "github.list_releases",
    description: "List releases in a GitHub repository",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
    },
    actionType: "github.release.read",
    riskLevel: "low",
  },
  {
    name: "github.create_release",
    description: "Create a new release in a GitHub repository",
    params: {
      owner: {
        type: "string",
        description: "Repository owner",
        required: false,
      },
      repo: { type: "string", description: "Repository name", required: false },
      tagName: {
        type: "string",
        description: "Tag name (e.g., 'v1.0.0')",
        required: true,
      },
      name: { type: "string", description: "Release title", required: false },
      body: {
        type: "string",
        description: "Release description (markdown)",
        required: false,
      },
      targetCommitish: {
        type: "string",
        description: "Target branch or SHA",
        required: false,
      },
      draft: {
        type: "boolean",
        description: "Create as draft",
        required: false,
      },
      prerelease: {
        type: "boolean",
        description: "Mark as pre-release",
        required: false,
      },
    },
    actionType: "github.release.create",
    riskLevel: "high",
  },

  // ==================== Code Review Tools ====================
  {
    name: "code_review.github_pr",
    description:
      "Review a GitHub pull request. Fetches PR metadata, changed files, diff, and CI check status, then produces a structured review with risk level, must-fix/should-fix items, security concerns, and a suggested review comment. Does NOT post or merge.",
    params: {
      owner: {
        type: "string",
        description: "Repository owner (user or org)",
        required: true,
      },
      repo: {
        type: "string",
        description: "Repository name",
        required: true,
      },
      prNumber: {
        type: "number",
        description: "Pull request number",
        required: true,
      },
    },
    actionType: "code_review.github_pr",
    riskLevel: "low",
  },
  {
    name: "code_review.gitlab_mr",
    description:
      "Review a GitLab merge request. Fetches MR metadata, changed files, diff, and pipeline status, then produces a structured review with risk level, must-fix/should-fix items, security concerns, and a suggested review comment. Does NOT post or merge.",
    params: {
      projectId: {
        type: "string",
        description: "GitLab project ID or path (e.g. '123' or 'group/repo')",
        required: true,
      },
      mrIid: {
        type: "number",
        description: "Merge request internal ID (the !N number)",
        required: true,
      },
    },
    actionType: "code_review.gitlab_mr",
    riskLevel: "low",
  },
  {
    name: "code_review.release_readiness",
    description:
      "Generate a release readiness report for a GitHub PR or GitLab MR. Includes Go/No-Go recommendation, known risks, deployment notes, rollback plan, customer impact, and a draft internal announcement. Does NOT deploy or merge.",
    params: {
      platform: {
        type: "string",
        description: "Platform: 'github' or 'gitlab'",
        required: true,
      },
      owner: {
        type: "string",
        description: "GitHub repository owner (required for GitHub)",
        required: false,
      },
      repo: {
        type: "string",
        description: "GitHub repository name (required for GitHub)",
        required: false,
      },
      prNumber: {
        type: "number",
        description: "GitHub PR number (required for GitHub)",
        required: false,
      },
      projectId: {
        type: "string",
        description: "GitLab project ID or path (required for GitLab)",
        required: false,
      },
      mrIid: {
        type: "number",
        description: "GitLab MR internal ID (required for GitLab)",
        required: false,
      },
      notes: {
        type: "string",
        description: "Optional additional context (deployment constraints, stakeholder notes, etc.)",
        required: false,
      },
    },
    actionType: "code_review.release_readiness",
    riskLevel: "low",
  },
  {
    name: "code_review.generate_comment",
    description:
      "Format a previously generated CodeReview object into a ready-to-post markdown review comment. Returns the formatted comment string — does NOT post it.",
    params: {
      review: {
        type: "object",
        description: "CodeReview object (output from code_review.github_pr or code_review.gitlab_mr)",
        required: true,
      },
    },
    actionType: "code_review.generate_comment",
    riskLevel: "low",
  },
  {
    name: "code_review.create_work_item",
    description:
      "Create a work item from a code review or release readiness report. Links to the PR/MR URL and records the recommendation and risk level.",
    params: {
      title: {
        type: "string",
        description: "Work item title",
        required: true,
      },
      type: {
        type: "string",
        description: "Work item type: 'code_review' or 'release'",
        required: true,
      },
      prUrl: {
        type: "string",
        description: "PR/MR URL to link",
        required: false,
      },
      riskLevel: {
        type: "string",
        description: "Risk level from the review: low, medium, high, or critical",
        required: false,
      },
      recommendation: {
        type: "string",
        description: "Recommendation from the review",
        required: false,
      },
      description: {
        type: "string",
        description: "Optional additional description",
        required: false,
      },
      priority: {
        type: "string",
        description: "Priority: low, medium, high, or critical. Defaults to the review risk level.",
        required: false,
      },
    },
    actionType: "code_review.create_work_item",
    riskLevel: "low",
  },

  // ==================== Web Search Tools ====================
  {
    name: "web.search",
    description:
      "Search the web for information using Tavily (primary) or Google Custom Search (fallback). Returns search results with titles, URLs, snippets, and optionally an AI-generated answer. Use for research, looking up documentation, finding solutions, checking current information.",
    params: {
      query: {
        type: "string",
        description: "Search query",
        required: true,
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results (default 5, max 20)",
        required: false,
      },
      searchDepth: {
        type: "string",
        description:
          'Search depth: "basic" (fast, 1 credit) or "advanced" (thorough, 2 credits). Default: basic.',
        required: false,
      },
      topic: {
        type: "string",
        description:
          'Search topic: "general", "news", or "finance". Use "news" for current events.',
        required: false,
      },
    },
    actionType: "web.search",
    riskLevel: "low",
  },
  {
    name: "web.fetch_page",
    description:
      "Fetch and extract text content from a web page URL. Returns cleaned text content (HTML tags removed). Use to read documentation, articles, or any web page content.",
    params: {
      url: {
        type: "string",
        description: "URL of the page to fetch",
        required: true,
      },
    },
    actionType: "web.fetch",
    riskLevel: "low",
  },

  // ==================== Todo Management Tools ====================
  {
    name: "todo.create_list",
    description:
      "Create a new todo/task list for tracking multi-step work. Returns the list with its ID. Use when starting a complex multi-step task that needs progress tracking.",
    params: {
      title: {
        type: "string",
        description: "Title for the todo list",
        required: true,
      },
      items: {
        type: "array",
        description:
          'Array of items to add, each with "content" and optional "priority" (high/medium/low)',
        required: false,
      },
    },
    actionType: "todo.manage",
    riskLevel: "low",
  },
  {
    name: "todo.add_item",
    description:
      "Add items to an existing todo list. Use when new subtasks are discovered during execution.",
    params: {
      listId: {
        type: "string",
        description: "ID of the todo list",
        required: true,
      },
      items: {
        type: "array",
        description:
          'Array of items to add, each with "content" and optional "priority"',
        required: true,
      },
    },
    actionType: "todo.manage",
    riskLevel: "low",
  },
  {
    name: "todo.update_item",
    description:
      "Update a todo item status, result, or priority. Use to mark items as in_progress, completed, or cancelled.",
    params: {
      listId: {
        type: "string",
        description: "ID of the todo list",
        required: true,
      },
      itemId: {
        type: "string",
        description: "ID of the todo item",
        required: true,
      },
      status: {
        type: "string",
        description:
          'New status: "pending", "in_progress", "completed", "cancelled"',
        required: false,
      },
      result: {
        type: "string",
        description: "Result or output of the task",
        required: false,
      },
      priority: {
        type: "string",
        description: "New priority: high, medium, low",
        required: false,
      },
    },
    actionType: "todo.manage",
    riskLevel: "low",
  },
  {
    name: "todo.get_list",
    description:
      "Get a todo list with all items and their statuses. Use to check progress or find the next pending item.",
    params: {
      listId: {
        type: "string",
        description: "ID of the todo list",
        required: true,
      },
    },
    actionType: "todo.manage",
    riskLevel: "low",
  },
  {
    name: "todo.list_lists",
    description: "List all todo lists with progress summaries.",
    params: {
      sessionId: {
        type: "string",
        description: "Filter by session ID",
        required: false,
      },
    },
    actionType: "todo.manage",
    riskLevel: "low",
  },
  {
    name: "todo.delete_list",
    description: "Delete an entire todo list.",
    params: {
      listId: {
        type: "string",
        description: "ID of the todo list to delete",
        required: true,
      },
    },
    actionType: "todo.manage",
    riskLevel: "low",
  },
  {
    name: "todo.clear_completed",
    description:
      "Remove completed and cancelled items from a todo list, keeping only pending and in_progress items.",
    params: {
      listId: {
        type: "string",
        description: "ID of the todo list",
        required: true,
      },
    },
    actionType: "todo.manage",
    riskLevel: "low",
  },

  // ==================== Knowledge Store Tools ====================
  {
    name: "knowledge.store",
    description:
      "Store important information in the knowledge base for later retrieval. Use for research findings, important documentation, architecture decisions, or any information worth remembering across sessions.",
    params: {
      title: {
        type: "string",
        description: "Short title for the knowledge entry",
        required: true,
      },
      content: {
        type: "string",
        description: "The content to store",
        required: true,
      },
      source: {
        type: "string",
        description:
          'Source type: "web_search", "web_page", "file_read", "conversation", "manual"',
        required: false,
      },
      tags: {
        type: "array",
        description: "Tags for categorization",
        required: false,
      },
      url: {
        type: "string",
        description: "Source URL if applicable",
        required: false,
      },
    },
    actionType: "knowledge.manage",
    riskLevel: "low",
  },
  {
    name: "knowledge.search",
    description:
      "Search the knowledge base for previously stored information. Returns matching entries ranked by relevance. Use before doing new research to avoid duplicating work.",
    params: {
      query: {
        type: "string",
        description: "Search query",
        required: true,
      },
      limit: {
        type: "number",
        description: "Max results (default 5)",
        required: false,
      },
      source: {
        type: "string",
        description: "Filter by source type",
        required: false,
      },
      tags: {
        type: "array",
        description: "Filter by tags",
        required: false,
      },
    },
    actionType: "knowledge.read",
    riskLevel: "low",
  },
  {
    name: "knowledge.recent",
    description:
      "Get recently stored knowledge entries. Useful for reviewing what has been learned or stored recently.",
    params: {
      limit: {
        type: "number",
        description: "Max entries to return (default 10)",
        required: false,
      },
      source: {
        type: "string",
        description: "Filter by source type",
        required: false,
      },
    },
    actionType: "knowledge.read",
    riskLevel: "low",
  },
  {
    name: "knowledge.get",
    description: "Get a specific knowledge entry by ID with full content.",
    params: {
      id: {
        type: "string",
        description: "Knowledge entry ID",
        required: true,
      },
    },
    actionType: "knowledge.read",
    riskLevel: "low",
  },
  {
    name: "knowledge.delete",
    description: "Delete a knowledge entry by ID.",
    params: {
      id: {
        type: "string",
        description: "Knowledge entry ID to delete",
        required: true,
      },
    },
    actionType: "knowledge.manage",
    riskLevel: "low",
  },
  {
    name: "knowledge.stats",
    description:
      "Get knowledge base statistics: total entries, breakdown by source, date range.",
    params: {},
    actionType: "knowledge.read",
    riskLevel: "low",
  },

  // ==================== Agent Spawn Tool ====================
  {
    name: "agent.spawn",
    description:
      "Spawn a sub-agent to execute a focused task in parallel. The sub-agent runs independently and returns its result. Use for parallel execution of independent subtasks (e.g., research one topic while creating a ticket for another). The main agent can spawn multiple sub-agents and collect results.",
    params: {
      task: {
        type: "string",
        description:
          "Clear, self-contained task description for the sub-agent. Include all context needed since the sub-agent starts fresh.",
        required: true,
      },
      systemPrompt: {
        type: "string",
        description:
          'Optional custom system prompt for the sub-agent. Use to specialize: "You are a researcher...", "You are a Jira expert..."',
        required: false,
      },
    },
    actionType: "agent.spawn",
    riskLevel: "medium",
  },

  // ==================== Workflow Orchestration Tools ====================
  {
    name: "workflow.create",
    description:
      "Create a new end-to-end workflow for autonomous task execution. The workflow progresses through phases: research → document → implement → review → approve → complete. Each phase is executed by spawning sub-agents. Use for complex tasks that need full autonomy.",
    params: {
      title: {
        type: "string",
        description: "Title of the workflow/task",
        required: true,
      },
      jiraKey: {
        type: "string",
        description: "Associated Jira ticket key (e.g., PROJ-123)",
        required: false,
      },
      roadmapItemId: {
        type: "string",
        description: "Associated roadmap item ID",
        required: false,
      },
      skipPhases: {
        type: "array",
        description:
          'Phases to skip (e.g., ["document", "review"] to skip docs and review)',
        required: false,
      },
    },
    actionType: "workflow.manage",
    riskLevel: "medium",
  },
  {
    name: "workflow.advance",
    description:
      "Advance a workflow to the next phase. Provide the result of the current phase. The workflow will move to the next phase and return the updated state.",
    params: {
      workflowId: {
        type: "string",
        description: "ID of the workflow",
        required: true,
      },
      result: {
        type: "string",
        description: "Result or output from the current phase",
        required: true,
      },
    },
    actionType: "workflow.manage",
    riskLevel: "low",
  },
  {
    name: "workflow.get",
    description:
      "Get the current state of a workflow including all phases, their statuses, and results.",
    params: {
      workflowId: {
        type: "string",
        description: "ID of the workflow",
        required: true,
      },
    },
    actionType: "workflow.manage",
    riskLevel: "low",
  },
  {
    name: "workflow.list",
    description: "List all workflows with their current phase and progress.",
    params: {},
    actionType: "workflow.manage",
    riskLevel: "low",
  },
  {
    name: "workflow.execute_phase",
    description:
      "Execute the current phase of a workflow by spawning a sub-agent with the appropriate system prompt. The sub-agent will use research/document/implement/review tools as needed. Returns the sub-agent's output.",
    params: {
      workflowId: {
        type: "string",
        description: "ID of the workflow",
        required: true,
      },
    },
    actionType: "workflow.execute",
    riskLevel: "medium",
  },

  // ==================== Local Filesystem Tools ====================
  {
    name: "local.read_file",
    description:
      "Read a file from the local filesystem. Returns file content as text. For files over 1MB, use local.file_summary to see the structure, local.read_section to read specific symbols, or local.file_chunks to read in sections.",
    params: {
      path: {
        type: "string",
        description:
          "Absolute or relative path to the file (relative to project root)",
        required: true,
      },
      offset: {
        type: "number",
        description:
          "Line number to start reading from (1-indexed). Useful for large files.",
        required: false,
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read. Defaults to 500.",
        required: false,
      },
    },
    actionType: "local.file.read",
    riskLevel: "low",
  },
  {
    name: "local.list_tree",
    description:
      "List files and directories in a local path. Returns a tree of files. Use to explore project structure, find files, understand codebase layout.",
    params: {
      path: {
        type: "string",
        description:
          "Directory path to list. Defaults to project root if not specified.",
        required: false,
      },
      maxDepth: {
        type: "number",
        description:
          "Maximum directory depth to traverse. Defaults to 3. Use 1 for shallow listing.",
        required: false,
      },
    },
    actionType: "local.tree.read",
    riskLevel: "low",
  },
  {
    name: "local.search_code",
    description:
      "Search for a text pattern in local files using regex. Returns matching file paths and line numbers. Use to find where functions, classes, or strings are defined or used.",
    params: {
      pattern: {
        type: "string",
        description:
          "Regex pattern to search for (e.g., 'function handleClick', 'class UserService', 'import.*axios')",
        required: true,
      },
      path: {
        type: "string",
        description: "Directory to search in. Defaults to project root.",
        required: false,
      },
      include: {
        type: "string",
        description:
          'File glob pattern to include (e.g., "*.ts", "*.tsx", "*.{ts,js}")',
        required: false,
      },
    },
    actionType: "local.code.search",
    riskLevel: "low",
  },

  {
    name: "local.file_summary",
    description:
      "Get a structural summary of a file — total lines, size, language, list of exports/functions/classes with line ranges, and imports. Use before reading a large file to understand its layout, then target specific sections with local.read_section or local.read_file.",
    params: {
      path: {
        type: "string",
        description:
          "Absolute or relative path to the file (relative to project root)",
        required: true,
      },
    },
    actionType: "local.file.summary",
    riskLevel: "low",
  },
  {
    name: "local.read_section",
    description:
      "Read a specific section of a file by symbol name (function, class, interface) or line range. For large files, use local.file_summary first to find symbol names and line ranges, then target sections precisely.",
    params: {
      path: {
        type: "string",
        description:
          "Absolute or relative path to the file (relative to project root)",
        required: true,
      },
      symbol: {
        type: "string",
        description:
          "Symbol name (function, class, interface) to read. Returns from its start line to the next symbol or file end.",
        required: false,
      },
      startLine: {
        type: "number",
        description:
          "1-indexed start line. Used if no symbol given. Defaults to beginning of file.",
        required: false,
      },
      endLine: {
        type: "number",
        description:
          "1-indexed end line. Used if no symbol given. Defaults to startLine + 200, max 500 lines.",
        required: false,
      },
    },
    actionType: "local.file.section",
    riskLevel: "low",
  },
  {
    name: "local.file_chunks",
    description:
      "Get a chunk manifest for a large file, or read a specific chunk by ID. In manifest mode (no chunkId), returns a list of chunks with line ranges and previews. With chunkId, returns that chunk's content. Use for files too large to read in one call.",
    params: {
      path: {
        type: "string",
        description:
          "Absolute or relative path to the file (relative to project root)",
        required: true,
      },
      chunkSize: {
        type: "number",
        description: "Lines per chunk (default 200, max 500)",
        required: false,
      },
      chunkId: {
        type: "number",
        description:
          "If provided, returns just that chunk's content instead of the manifest",
        required: false,
      },
    },
    actionType: "local.file.chunk",
    riskLevel: "low",
  },
  {
    name: "codebase.search",
    description:
      "Search the indexed codebase using semantic (vector) or keyword (TF-IDF) search. Returns relevant code chunks with file paths, line numbers, and content. Use for finding related code, understanding architecture, or locating implementations. Faster than local.search_code for conceptual queries.",
    params: {
      query: {
        type: "string",
        description:
          "Search query — can be a concept ('error handling'), function name ('handleAuth'), or any text",
        required: true,
      },
      language: {
        type: "string",
        description:
          'Filter by programming language (e.g., "typescript", "python")',
        required: false,
      },
      filePath: {
        type: "string",
        description: "Filter by file path substring (e.g., 'src/agent/')",
        required: false,
      },
      limit: {
        type: "number",
        description: "Max results (default 10)",
        required: false,
      },
    },
    actionType: "codebase.search",
    riskLevel: "low",
  },
  {
    name: "codebase.stats",
    description:
      "Get statistics about the indexed codebase: total files, chunks, languages, and embedding status.",
    params: {},
    actionType: "codebase.stats",
    riskLevel: "low",
  },

  {
    name: "graph.add_node",
    description:
      "Add a node to the knowledge graph for tracking architecture decisions, ADRs, components, requirements, assumptions, risks, tradeoffs, and reasoning chains. Each node has a type, title, content, status, and tags.",
    params: {
      type: {
        type: "string",
        description:
          'Node type: "decision", "adr", "component", "api_endpoint", "data_model", "requirement", "assumption", "risk", "tradeoff", "pattern", "reasoning"',
        required: true,
      },
      title: {
        type: "string",
        description: "Short title for this graph node",
        required: true,
      },
      content: {
        type: "string",
        description: "Full content/description of the node",
        required: true,
      },
      status: {
        type: "string",
        description:
          'Status: "proposed", "accepted", "deprecated", "superseded". Default: proposed',
        required: false,
      },
      context: {
        type: "string",
        description: "Context or background for this decision/node",
        required: false,
      },
      tags: {
        type: "array",
        description: "Tags for categorization",
        required: false,
      },
    },
    actionType: "graph.manage",
    riskLevel: "low",
  },
  {
    name: "graph.add_edge",
    description:
      "Add a relationship between two knowledge graph nodes. Use to model dependencies, alternatives, tradeoffs, etc.",
    params: {
      sourceId: {
        type: "string",
        description: "Source node ID",
        required: true,
      },
      targetId: {
        type: "string",
        description: "Target node ID",
        required: true,
      },
      type: {
        type: "string",
        description:
          'Edge type: "depends_on", "implements", "alternative_to", "supersedes", "related_to", "constrains", "enables", "blocks", "derives_from", "tested_by"',
        required: true,
      },
      description: {
        type: "string",
        description: "Description of this relationship",
        required: false,
      },
    },
    actionType: "graph.manage",
    riskLevel: "low",
  },
  {
    name: "graph.get_node",
    description: "Get a knowledge graph node by ID.",
    params: {
      id: {
        type: "string",
        description: "Node ID",
        required: true,
      },
    },
    actionType: "graph.read",
    riskLevel: "low",
  },
  {
    name: "graph.query",
    description:
      "Query knowledge graph nodes by type, status, tags, or text search.",
    params: {
      type: {
        type: "string",
        description: "Filter by node type",
        required: false,
      },
      status: {
        type: "string",
        description: "Filter by status",
        required: false,
      },
      tags: {
        type: "array",
        description: "Filter by tags",
        required: false,
      },
      search: {
        type: "string",
        description: "Text search across title, content, and context",
        required: false,
      },
      limit: {
        type: "number",
        description: "Max results (default 20)",
        required: false,
      },
    },
    actionType: "graph.read",
    riskLevel: "low",
  },
  {
    name: "graph.neighbors",
    description:
      "Get the neighborhood of a node — its connected nodes and relationships, up to a specified depth.",
    params: {
      nodeId: {
        type: "string",
        description: "Node ID to explore from",
        required: true,
      },
      depth: {
        type: "number",
        description: "Max traversal depth (default 2)",
        required: false,
      },
    },
    actionType: "graph.read",
    riskLevel: "low",
  },
  {
    name: "graph.update_node",
    description: "Update a knowledge graph node's fields.",
    params: {
      id: {
        type: "string",
        description: "Node ID",
        required: true,
      },
      title: {
        type: "string",
        description: "New title",
        required: false,
      },
      content: {
        type: "string",
        description: "New content",
        required: false,
      },
      status: {
        type: "string",
        description: "New status",
        required: false,
      },
      tags: {
        type: "array",
        description: "New tags",
        required: false,
      },
    },
    actionType: "graph.manage",
    riskLevel: "low",
  },
  {
    name: "graph.delete_node",
    description: "Delete a knowledge graph node and all its relationships.",
    params: {
      id: {
        type: "string",
        description: "Node ID to delete",
        required: true,
      },
    },
    actionType: "graph.manage",
    riskLevel: "low",
  },
  {
    name: "graph.summary",
    description:
      "Get knowledge graph summary statistics: total nodes, edges, breakdowns by type and status.",
    params: {},
    actionType: "graph.read",
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
  {
    name: "productivity.generate_weekly_plan",
    description:
      "Generate a weekly productivity plan covering 1 or 2 weeks. Distributes Jira tasks intelligently across days by priority, fills afternoons with focus blocks, includes health breaks, and provides an encouraging schedule with a big-picture overview. Use this when the user asks for a weekly view, wants to see their schedule at a distance, or says 'plan my week'.",
    params: {
      startDate: {
        type: "string",
        description:
          "Start date for the plan (ISO 8601). Defaults to next Monday if not provided.",
        required: false,
      },
      weeks: {
        type: "number",
        description: "Number of weeks to plan: 1 or 2. Defaults to 1.",
        required: false,
      },
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
  {
    name: "cto.daily_command_center",
    description:
      "Generate Tim's CTO Daily Command Center operating brief from calendar, Jira, GitLab, GitHub, roadmap, work items, Jitbit support activity, and conversation memory. Read-only; suggests drafts and work items but does not send customer-facing updates.",
    params: {
      date: {
        type: "string",
        description: "Brief date in YYYY-MM-DD format. Defaults to today.",
        required: false,
      },
      daysBack: {
        type: "number",
        description: "How many days back to inspect recent activity. Default 7.",
        required: false,
      },
      includeCalendar: { type: "boolean", description: "Include calendar signals", required: false },
      includeJira: { type: "boolean", description: "Include Jira signals", required: false },
      includeGitLab: { type: "boolean", description: "Include GitLab signals", required: false },
      includeGitHub: { type: "boolean", description: "Include GitHub signals", required: false },
      includeRoadmap: { type: "boolean", description: "Include roadmap signals", required: false },
      includeWorkItems: { type: "boolean", description: "Include Work Items", required: false },
      includeJitbit: { type: "boolean", description: "Include Jitbit customer/support signals", required: false },
    },
    actionType: "cto.daily_command_center",
    riskLevel: "low",
  },
  {
    name: "cto.create_suggested_work_items",
    description:
      "Create work items from the CTO Daily Command Center's suggested drafts and follow-ups. Only creates items the user explicitly approves.",
    params: {
      items: {
        type: "string",
        description: "JSON array of work item objects with type, title, description, priority, tags",
        required: true,
      },
      source: {
        type: "string",
        description: "Source for the work items. Default 'cto_brief'.",
        required: false,
      },
    },
    actionType: "cto.create_suggested_work_items",
    riskLevel: "medium",
  },

  // ── Entity Memory Tools ─────────────────────────────────────────
  {
    name: "memory.find_entities",
    description:
      "Search entity memory for people, customers, companies, repos, Jira issues, PRs, decisions, and preferences. Use this when Tim asks what we know about someone or something.",
    params: {
      query: { type: "string", description: "Text to search across entity names and summaries" },
      type: {
        type: "string",
        description:
          "Filter by entity type: person, customer, company, project, repo, jira_issue, gitlab_mr, github_pr, roadmap, work_item, decision, preference, system, vendor",
      },
      limit: { type: "number", description: "Max results to return (default 10, max 50)" },
    },
    actionType: "memory.find_entities",
    riskLevel: "low",
  },
  {
    name: "memory.get_entity_context",
    description:
      "Get everything known about a specific entity: its summary, all facts collected, and its links to other entities. Best for 'What do we know about customer ACME?' or 'Tell me about repo hawk-ir-cloud-v3'.",
    params: {
      type: {
        type: "string",
        description: "Entity type (person, customer, company, repo, jira_issue, etc.)",
        required: true,
      },
      name: { type: "string", description: "Entity name to look up", required: true },
    },
    actionType: "memory.get_entity_context",
    riskLevel: "low",
  },
  {
    name: "memory.add_entity_fact",
    description:
      "Store a new fact about a named entity. Creates the entity if it does not exist. Use this to remember something specific: a customer preference, a decision made, a person's role.",
    params: {
      type: {
        type: "string",
        description: "Entity type (person, customer, company, repo, jira_issue, etc.)",
        required: true,
      },
      name: { type: "string", description: "Entity name", required: true },
      fact: { type: "string", description: "The fact to store about this entity", required: true },
      source: { type: "string", description: "Where this fact came from (e.g. 'conversation', 'jitbit')" },
    },
    actionType: "memory.add_entity_fact",
    riskLevel: "low",
  },

  // ── Personal OS Tools ──────────────────────────────────────────
  {
    name: "personal_os.brief",
    description:
      "Generate a Personal OS brief: today's load, open loops, decisions waiting, recurring patterns, suggested delegations, focus blocks, energy risks, and things to stop doing. Aggregates calendar, Jira, GitLab, GitHub, Jitbit, work items, and memory. Read-only.",
    params: {
      date: {
        type: "string",
        description: "Brief date in YYYY-MM-DD format. Defaults to today.",
        required: false,
      },
      daysBack: {
        type: "number",
        description: "How many days back to inspect. Default 7.",
        required: false,
      },
      includeCalendar: { type: "boolean", description: "Include calendar signals", required: false },
      includeJira: { type: "boolean", description: "Include Jira signals", required: false },
      includeGitLab: { type: "boolean", description: "Include GitLab signals", required: false },
      includeGitHub: { type: "boolean", description: "Include GitHub signals", required: false },
      includeWorkItems: { type: "boolean", description: "Include work items", required: false },
      includeJitbit: { type: "boolean", description: "Include Jitbit support signals", required: false },
      includeRoadmap: { type: "boolean", description: "Include roadmap signals", required: false },
      includeMemory: { type: "boolean", description: "Include conversation memory context", required: false },
    },
    actionType: "personal_os.brief",
    riskLevel: "low",
  },
  {
    name: "personal_os.open_loops",
    description:
      "Summarize unresolved decisions, tasks, and follow-ups across all sources (work items, Jira, GitLab MRs, GitHub PRs, Jitbit tickets).",
    params: {
      userId: { type: "string", description: "User ID", required: false },
    },
    actionType: "personal_os.open_loops",
    riskLevel: "low",
  },
  {
    name: "personal_os.detect_patterns",
    description:
      "Detect recurring patterns in work items and calendar data over the past N days. Identifies meeting overload, context switching, review bottlenecks, and task clustering.",
    params: {
      daysBack: { type: "number", description: "Number of days to analyze (7-90). Default 30.", required: false },
    },
    actionType: "personal_os.detect_patterns",
    riskLevel: "low",
  },
  {
    name: "personal_os.suggest_focus",
    description:
      "Suggest calendar focus blocks based on open loops, priorities, and schedule gaps. Does NOT create calendar events unless the user explicitly asks.",
    params: {
      date: { type: "string", description: "Date for focus blocks in YYYY-MM-DD format. Defaults to today.", required: false },
      minDurationMinutes: { type: "number", description: "Minimum focus block duration in minutes. Default 60.", required: false },
    },
    actionType: "personal_os.suggest_focus",
    riskLevel: "low",
  },
  {
    name: "personal_os.create_work_items",
    description:
      "Create work items from Personal OS brief suggestions. Only creates items the user has explicitly approved.",
    params: {
      items: { type: "string", description: "JSON array of work item objects with type, title, description, priority, source, tags", required: true },
    },
    actionType: "personal_os.create_work_items",
    riskLevel: "medium",
  },

  // ── Product Chief of Staff Tools ────────────────────────────────
  {
    name: "product.workflow_brief",
    description:
      "Turn a product idea into a structured workflow-first product brief. Covers problem, users, actors, job-to-be-done, trigger, desired outcome, current/proposed workflows, friction, automation opportunities, human-in-the-loop moments, MVP scope, non-goals, risks, and success criteria.",
    params: {
      idea: {
        type: "string",
        description: "Product idea or problem description",
        required: true,
      },
      context: {
        type: "string",
        description: "Additional context or background information",
        required: false,
      },
    },
    actionType: "product.workflow_brief",
    riskLevel: "low",
  },
  {
    name: "product.roadmap_proposal",
    description:
      "Generate a roadmap proposal from a theme. Includes why now, customer evidence, engineering impact, proposed milestones, work items, dependencies, risks, cut line, and demo criteria.",
    params: {
      theme: {
        type: "string",
        description: "Roadmap theme or initiative name",
        required: true,
      },
      customerEvidence: {
        type: "string",
        description: "Known customer evidence or signals",
        required: false,
      },
      engineeringConstraints: {
        type: "string",
        description: "Engineering constraints or considerations",
        required: false,
      },
      timeHorizon: {
        type: "string",
        description: "Time horizon (e.g., 'Q2 2026', '6 months')",
        required: false,
      },
    },
    actionType: "product.roadmap_proposal",
    riskLevel: "low",
  },
  {
    name: "product.roadmap_drift",
    description:
      "Analyze roadmap drift — compare shipped vs planned progress. Shows completion rates, overdue milestones, at-risk items, and a drift score for each active roadmap.",
    params: {
      roadmapId: {
        type: "string",
        description: "Specific roadmap ID to analyze. Omit for all active roadmaps.",
        required: false,
      },
    },
    actionType: "product.roadmap_drift",
    riskLevel: "low",
  },
  {
    name: "product.customer_signals",
    description:
      "Extract customer signals from Jitbit support tickets. Detects repeated asks, high-friction areas, stale support themes, and customers waiting on roadmap promises.",
    params: {
      daysBack: {
        type: "number",
        description: "Number of days to look back for ticket analysis. Default 14.",
        required: false,
      },
      limit: {
        type: "number",
        description: "Maximum number of tickets to analyze. Default 50.",
        required: false,
      },
    },
    actionType: "product.customer_signals",
    riskLevel: "low",
  },
  {
    name: "product.weekly_update",
    description:
      "Generate a weekly product update from roadmap progress, work items, and Jitbit customer signals. Covers shipped, in-progress, blocked, customer signals, roadmap changes, decisions needed, and next week priorities.",
    params: {
      weekStart: {
        type: "string",
        description: "Week start date in YYYY-MM-DD format. Defaults to today.",
        required: false,
      },
      daysBack: {
        type: "number",
        description: "Number of days to look back. Default 7.",
        required: false,
      },
    },
    actionType: "product.weekly_update",
    riskLevel: "low",
  },
  {
    name: "product.create_work_items",
    description:
      "Create work items from product roadmap proposals or signals. Only creates items the user has explicitly approved.",
    params: {
      items: {
        type: "string",
        description: "JSON array of work item objects with type, title, description, priority, tags",
        required: true,
      },
      source: {
        type: "string",
        description: "Source for the work items. Default 'roadmap'.",
        required: false,
      },
    },
    actionType: "product.create_work_items",
    riskLevel: "medium",
  },
  {
    name: "product.shipped_vs_planned",
    description:
      "Summarize shipped vs planned items across roadmaps. Compares completed milestones/items against planned ones to show delivery velocity.",
    params: {
      roadmapId: {
        type: "string",
        description: "Optional roadmap ID to scope the comparison. If omitted, analyzes all roadmaps.",
        required: false,
      },
    },
    actionType: "product.shipped_vs_planned",
    riskLevel: "low",
  },

  // ── Roadmap Tools ──────────────────────────────────────────────
  {
    name: "roadmap.list",
    description:
      "List all roadmaps. Returns name, type, status, dates, and milestone counts. Use this when the user asks about roadmaps or project plans.",
    params: {
      type: {
        type: "string",
        description: "Filter by type: 'client' or 'internal'",
        required: false,
      },
      status: {
        type: "string",
        description:
          "Filter by status: 'draft', 'active', 'completed', 'archived'",
        required: false,
      },
    },
    actionType: "roadmap.read",
    riskLevel: "low",
  },
  {
    name: "roadmap.get",
    description:
      "Get a single roadmap by ID, including its milestones and items. Use this to show roadmap details.",
    params: {
      id: {
        type: "string",
        description: "Roadmap ID (UUID)",
        required: true,
      },
    },
    actionType: "roadmap.read",
    riskLevel: "low",
  },
  {
    name: "roadmap.create",
    description:
      "Create a new roadmap with name, type, dates, and optional Jira link.",
    params: {
      name: {
        type: "string",
        description: "Roadmap name",
        required: true,
      },
      type: {
        type: "string",
        description: "'client' or 'internal'",
        required: true,
      },
      startDate: {
        type: "string",
        description: "Start date (YYYY-MM-DD)",
        required: true,
      },
      endDate: {
        type: "string",
        description: "End date (YYYY-MM-DD), optional",
        required: false,
      },
      status: {
        type: "string",
        description:
          "'draft', 'active', 'completed', or 'archived'. Default: draft",
        required: false,
      },
      description: {
        type: "string",
        description: "Roadmap description",
        required: false,
      },
      jiraProjectKey: {
        type: "string",
        description: "Link to a Jira project key",
        required: false,
      },
    },
    actionType: "roadmap.write",
    riskLevel: "medium",
  },
  {
    name: "roadmap.update",
    description:
      "Update an existing roadmap's fields (name, status, dates, etc.).",
    params: {
      id: {
        type: "string",
        description: "Roadmap ID (UUID)",
        required: true,
      },
      name: { type: "string", description: "New name", required: false },
      status: { type: "string", description: "New status", required: false },
      startDate: {
        type: "string",
        description: "New start date",
        required: false,
      },
      endDate: { type: "string", description: "New end date", required: false },
      description: {
        type: "string",
        description: "New description",
        required: false,
      },
    },
    actionType: "roadmap.write",
    riskLevel: "medium",
  },
  {
    name: "roadmap.add_milestone",
    description:
      "Add a milestone to a roadmap. Milestones group items and have target dates.",
    params: {
      roadmapId: {
        type: "string",
        description: "Roadmap ID to add milestone to",
        required: true,
      },
      name: { type: "string", description: "Milestone name", required: true },
      targetDate: {
        type: "string",
        description: "Target date (YYYY-MM-DD)",
        required: true,
      },
      description: {
        type: "string",
        description: "Milestone description",
        required: false,
      },
      jiraEpicKey: {
        type: "string",
        description: "Link to a Jira epic key",
        required: false,
      },
    },
    actionType: "roadmap.write",
    riskLevel: "medium",
  },
  {
    name: "roadmap.add_item",
    description:
      "Add an item (feature, task, bug, etc.) to a milestone within a roadmap.",
    params: {
      milestoneId: {
        type: "string",
        description: "Milestone ID to add item to",
        required: true,
      },
      title: { type: "string", description: "Item title", required: true },
      type: {
        type: "string",
        description:
          "'feature', 'task', 'bug', 'technical_debt', or 'research'",
        required: false,
      },
      priority: {
        type: "string",
        description: "'low', 'medium', 'high', or 'critical'",
        required: false,
      },
      description: {
        type: "string",
        description: "Item description",
        required: false,
      },
      jiraKey: {
        type: "string",
        description: "Link to a Jira issue key",
        required: false,
      },
    },
    actionType: "roadmap.write",
    riskLevel: "medium",
  },
  {
    name: "roadmap.update_milestone",
    description:
      "Update a milestone's name, target date, status, or description",
    params: {
      id: {
        type: "string",
        description: "Milestone ID",
        required: true,
      },
      name: {
        type: "string",
        description: "New milestone name",
        required: false,
      },
      targetDate: {
        type: "string",
        description: "New target date (YYYY-MM-DD)",
        required: false,
      },
      status: {
        type: "string",
        description: "New status: pending, in_progress, completed, or at_risk",
        required: false,
      },
      description: {
        type: "string",
        description: "New description",
        required: false,
      },
    },
    actionType: "roadmap.write",
    riskLevel: "medium",
  },
  {
    name: "roadmap.update_item",
    description:
      "Update a roadmap item's title, status, priority, type, or other fields",
    params: {
      id: {
        type: "string",
        description: "Item ID",
        required: true,
      },
      title: { type: "string", description: "New title", required: false },
      status: {
        type: "string",
        description: "New status: todo, in_progress, done, or blocked",
        required: false,
      },
      priority: {
        type: "string",
        description: "New priority: low, medium, high, or critical",
        required: false,
      },
      type: {
        type: "string",
        description:
          "New type: feature, task, bug, technical_debt, or research",
        required: false,
      },
      description: {
        type: "string",
        description: "New description",
        required: false,
      },
      jiraKey: {
        type: "string",
        description: "New linked Jira issue key",
        required: false,
      },
    },
    actionType: "roadmap.write",
    riskLevel: "medium",
  },
  {
    name: "roadmap.delete",
    description:
      "Delete a roadmap and all its milestones and items. This is irreversible.",
    params: {
      id: {
        type: "string",
        description: "Roadmap ID to delete",
        required: true,
      },
    },
    actionType: "roadmap.write",
    riskLevel: "high",
  },
  {
    name: "roadmap.delete_milestone",
    description: "Delete a milestone and all its items. This is irreversible.",
    params: {
      id: {
        type: "string",
        description: "Milestone ID to delete",
        required: true,
      },
    },
    actionType: "roadmap.write",
    riskLevel: "high",
  },
  {
    name: "roadmap.delete_item",
    description: "Delete a single item from a milestone. This is irreversible.",
    params: {
      id: {
        type: "string",
        description: "Item ID to delete",
        required: true,
      },
    },
    actionType: "roadmap.write",
    riskLevel: "high",
  },

  // ==================== Codex CLI Tools ====================
  {
    name: "codex.run",
    description:
      "Run the Codex CLI coding agent with a prompt to implement code changes. Codex will analyze the codebase, plan changes, write code, and run tests. Use this for autonomous implementation of tasks described in tickets or plans. Returns the output of the coding session.",
    params: {
      prompt: {
        type: "string",
        description:
          "Detailed implementation prompt for Codex. Include what to build, which files to modify, acceptance criteria, and any constraints.",
        required: true,
      },
      cwd: {
        type: "string",
        description: "Working directory for Codex. Defaults to project root.",
        required: false,
      },
      model: {
        type: "string",
        description:
          'Model to use (e.g., "o4-mini", "gpt-4o"). Defaults to CODEX_MODEL env var or "o4-mini".',
        required: false,
      },
      approvalMode: {
        type: "string",
        description:
          'Approval mode: "suggest" (shows changes for review), "auto-edit" (auto-applies edits), "full-auto" (full autonomy). Defaults to "suggest".',
        required: false,
      },
    },
    actionType: "codex.run",
    riskLevel: "high",
  },

  {
    name: "mcp.call_tool",
    description:
      "Call a tool from a connected MCP (Model Context Protocol) server. MCP provides standardized access to external tool providers like Tavily. Use mcp.list_tools to see available MCP tools.",
    params: {
      toolName: {
        type: "string",
        description: "Name of the MCP tool to call",
        required: true,
      },
      args: {
        type: "object",
        description: "Arguments to pass to the MCP tool",
        required: true,
      },
    },
    actionType: "mcp.call",
    riskLevel: "low",
  },
  {
    name: "mcp.list_tools",
    description:
      "List all available tools from connected MCP (Model Context Protocol) servers. Returns tool names, descriptions, and required parameters.",
    params: {},
    actionType: "mcp.list",
    riskLevel: "low",
  },

  // ==================== System Tools ====================
  {
    name: "system.check_health",
    description:
      "Check the health and integration status of the AI Assistant. Returns provider status (configured, valid, active model) and integration status (GitHub, GitLab, Jira — configured and valid). Use this to verify connections are working or to report status to the user.",
    params: {
      includeDetails: {
        type: "boolean",
        description:
          "Include detailed status for each integration (API URLs, error messages). Default: false.",
        required: false,
      },
    },
    actionType: "system.check_health",
    riskLevel: "low",
  },

  // ==================== Jitbit Tools ====================
  {
    name: "jitbit.search_tickets",
    description:
      "Search Jitbit support tickets by text and optional filters. Use for finding tickets assigned to a user, customer support history, incidents, and support request lookup.",
    params: {
      query: {
        type: "string",
        description: "Search text",
        required: true,
      },
      assignedToUserId: {
        type: "number",
        description: "Optional user ID to filter tickets assigned to this user",
        required: false,
      },
      fromUserId: {
        type: "number",
        description: "Optional user ID to filter tickets created by this user",
        required: false,
      },
      dateFrom: {
        type: "string",
        description: "Optional ticket creation start date, YYYY-MM-DD",
        required: false,
      },
      dateTo: {
        type: "string",
        description: "Optional ticket creation end date, YYYY-MM-DD",
        required: false,
      },
      categoryId: {
        type: "number",
        description: "Optional Jitbit category ID",
        required: false,
      },
      statusId: {
        type: "number",
        description: "Optional Jitbit status ID",
        required: false,
      },
    },
    actionType: "jitbit.search_tickets",
    riskLevel: "low",
  },
  {
    name: "jitbit.get_ticket",
    description:
      "Get a Jitbit ticket with comments and an assistant-friendly summary.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
    },
    actionType: "jitbit.get_ticket",
    riskLevel: "low",
  },
  {
    name: "jitbit.list_recent_tickets",
    description:
      "List recent Jitbit customer activity from support tickets. Useful for CTO daily briefs and customer intelligence.",
    params: {
      days: {
        type: "number",
        description: "How many days back to look. Default: 7",
        required: false,
      },
      limit: {
        type: "number",
        description: "Maximum tickets to return. Default: 25",
        required: false,
      },
    },
    actionType: "jitbit.list_recent_tickets",
    riskLevel: "low",
  },
  {
    name: "jitbit.get_customer_snapshot",
    description:
      "Get a customer snapshot from Jitbit by company ID or company name, including users, open requests, recent activity, and high-priority tickets.",
    params: {
      companyId: {
        type: "number",
        description: "Jitbit company ID",
        required: false,
      },
      companyName: {
        type: "string",
        description: "Company name to search",
        required: false,
      },
    },
    actionType: "jitbit.get_customer_snapshot",
    riskLevel: "low",
  },
  {
    name: "jitbit.find_followups",
    description:
      "Find open Jitbit tickets that have not been updated recently and may need customer follow-up.",
    params: {
      daysSinceUpdate: {
        type: "number",
        description: "Minimum days since last update. Default: 3",
        required: false,
      },
      limit: {
        type: "number",
        description: "Maximum tickets to return. Default: 25",
        required: false,
      },
    },
    actionType: "jitbit.find_followups",
    riskLevel: "low",
  },
  {
    name: "jitbit.add_ticket_comment",
    description:
      "Add a comment to a Jitbit support ticket. Use only when the user explicitly asks to update support context or follow-up notes.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
      body: {
        type: "string",
        description: "Comment body",
        required: true,
      },
      forTechsOnly: {
        type: "boolean",
        description: "Whether the comment is internal/technician-only",
        required: false,
      },
      dryRun: {
        type: "boolean",
        description: "Preview what would happen without executing",
        required: false,
      },
    },
    actionType: "jitbit.add_ticket_comment",
    riskLevel: "medium",
  },
  {
    name: "jitbit.create_ticket",
    description:
      "Create a new Jitbit support ticket. Requires a category ID and subject.",
    params: {
      categoryId: {
        type: "number",
        description: "Jitbit category ID (required)",
        required: true,
      },
      subject: {
        type: "string",
        description: "Ticket subject/title",
        required: true,
      },
      body: {
        type: "string",
        description: "Ticket body/description",
        required: false,
      },
      priorityId: {
        type: "number",
        description: "Priority ID",
        required: false,
      },
      assignedToUserId: {
        type: "number",
        description: "User ID to assign the ticket to",
        required: false,
      },
      tags: {
        type: "string",
        description: "Comma-separated tags",
        required: false,
      },
      companyId: {
        type: "number",
        description: "Company ID to associate with the ticket",
        required: false,
      },
    },
    actionType: "jitbit.create_ticket",
    riskLevel: "medium",
  },
  {
    name: "jitbit.close_ticket",
    description:
      "Close a Jitbit support ticket by setting its status to Closed.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
    },
    actionType: "jitbit.close_ticket",
    riskLevel: "medium",
  },
  {
    name: "jitbit.reopen_ticket",
    description:
      "Reopen a closed Jitbit support ticket by setting its status to Open or New.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
    },
    actionType: "jitbit.reopen_ticket",
    riskLevel: "medium",
  },
  {
    name: "jitbit.assign_ticket",
    description:
      "Assign a Jitbit support ticket to a specific user.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
      assignedUserId: {
        type: "number",
        description: "User ID to assign the ticket to",
        required: true,
      },
    },
    actionType: "jitbit.assign_ticket",
    riskLevel: "medium",
  },
  {
    name: "jitbit.delete_ticket",
    description:
      "Permanently delete a Jitbit support ticket. This action is irreversible and requires approval.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
    },
    actionType: "jitbit.delete_ticket",
    riskLevel: "high",
  },
  {
    name: "jitbit.merge_tickets",
    description:
      "Merge multiple Jitbit support tickets into one. Source tickets will be merged into the target ticket.",
    params: {
      targetTicketId: {
        type: "number",
        description: "The ticket ID to merge into",
        required: true,
      },
      sourceTicketIds: {
        type: "string",
        description: "Comma-separated ticket IDs to merge from",
        required: true,
      },
    },
    actionType: "jitbit.merge_tickets",
    riskLevel: "medium",
  },
  {
    name: "jitbit.forward_ticket",
    description:
      "Forward a Jitbit support ticket to an email address.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
      toEmail: {
        type: "string",
        description: "Email address to forward to",
        required: true,
      },
      ccEmails: {
        type: "string",
        description: "Comma-separated CC email addresses",
        required: false,
      },
      body: {
        type: "string",
        description: "Optional message body",
        required: false,
      },
    },
    actionType: "jitbit.forward_ticket",
    riskLevel: "medium",
  },
  {
    name: "jitbit.list_assets",
    description:
      "List Jitbit assets with optional filters. Use for asset inventory and management.",
    params: {
      search: {
        type: "string",
        description: "Search text for assets",
        required: false,
      },
      categoryId: {
        type: "number",
        description: "Filter by category ID",
        required: false,
      },
      companyId: {
        type: "number",
        description: "Filter by company ID",
        required: false,
      },
      count: {
        type: "number",
        description: "Maximum results to return",
        required: false,
      },
      page: {
        type: "number",
        description: "Page number for pagination",
        required: false,
      },
    },
    actionType: "jitbit.list_assets",
    riskLevel: "low",
  },
  {
    name: "jitbit.get_asset",
    description:
      "Get details of a specific Jitbit asset by ID.",
    params: {
      assetId: {
        type: "number",
        description: "Jitbit asset ID",
        required: true,
      },
    },
    actionType: "jitbit.get_asset",
    riskLevel: "low",
  },
  {
    name: "jitbit.create_asset",
    description:
      "Create a new Jitbit asset.",
    params: {
      name: {
        type: "string",
        description: "Asset name (required)",
        required: true,
      },
      categoryId: {
        type: "number",
        description: "Category ID",
        required: false,
      },
      companyId: {
        type: "number",
        description: "Company ID",
        required: false,
      },
      serialNumber: {
        type: "string",
        description: "Serial number",
        required: false,
      },
      notes: {
        type: "string",
        description: "Notes about the asset",
        required: false,
      },
    },
    actionType: "jitbit.create_asset",
    riskLevel: "medium",
  },
  {
    name: "jitbit.update_asset",
    description:
      "Update an existing Jitbit asset.",
    params: {
      assetId: {
        type: "number",
        description: "Jitbit asset ID",
        required: true,
      },
      name: {
        type: "string",
        description: "Asset name",
        required: false,
      },
      serialNumber: {
        type: "string",
        description: "Serial number",
        required: false,
      },
      companyId: {
        type: "number",
        description: "Company ID",
        required: false,
      },
      notes: {
        type: "string",
        description: "Notes about the asset",
        required: false,
      },
    },
    actionType: "jitbit.update_asset",
    riskLevel: "medium",
  },
  {
    name: "jitbit.delete_asset",
    description:
      "Permanently delete a Jitbit asset. This action is irreversible and requires approval.",
    params: {
      assetId: {
        type: "number",
        description: "Jitbit asset ID",
        required: true,
      },
    },
    actionType: "jitbit.delete_asset",
    riskLevel: "high",
  },
  {
    name: "jitbit.search_assets",
    description:
      "Search Jitbit assets by text query.",
    params: {
      query: {
        type: "string",
        description: "Search query for assets",
        required: true,
      },
    },
    actionType: "jitbit.search_assets",
    riskLevel: "low",
  },
  {
    name: "jitbit.disable_asset",
    description:
      "Disable a Jitbit asset by ID (soft delete — the asset is retained but marked inactive).",
    params: {
      assetId: {
        type: "number",
        description: "Asset ID to disable",
        required: true,
      },
    },
    actionType: "jitbit.disable_asset",
    riskLevel: "medium",
  },
  {
    name: "jitbit.add_tag",
    description:
      "Add a tag to a Jitbit support ticket.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
      tagName: {
        type: "string",
        description: "Tag name to add",
        required: true,
      },
    },
    actionType: "jitbit.add_tag",
    riskLevel: "low",
  },
  {
    name: "jitbit.remove_tag",
    description:
      "Remove a tag from a Jitbit support ticket. NOTE: The Jitbit API does not support removing individual tags; use updateTicket with the tags field to replace all tags instead.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
      tagName: {
        type: "string",
        description: "Tag name to remove",
        required: true,
      },
    },
    actionType: "jitbit.remove_tag",
    riskLevel: "low",
  },
  {
    name: "jitbit.add_time_entry",
    description:
      "Add a time tracking entry to a Jitbit support ticket.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
      minutes: {
        type: "number",
        description: "Number of minutes spent",
        required: true,
      },
      date: {
        type: "string",
        description: "Date for the entry, YYYY-MM-DD",
        required: false,
      },
      comment: {
        type: "string",
        description: "Optional note about the time entry",
        required: false,
      },
      billable: {
        type: "boolean",
        description: "Whether the time is billable",
        required: false,
      },
    },
    actionType: "jitbit.add_time_entry",
    riskLevel: "medium",
  },
  {
    name: "jitbit.update_ticket",
    description:
      "Update fields on a Jitbit support ticket (subject, body, priority, category, status, etc.).",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
      fields: {
        type: "object",
        description: "Fields to update (subject, body, priorityId, categoryId, statusId, assignedUserId, etc.)",
        required: true,
      },
    },
    actionType: "jitbit.update_ticket",
    riskLevel: "medium",
  },
  {
    name: "jitbit.list_users",
    description:
      "List Jitbit users with optional filters (company, department, search).",
    params: {
      companyId: {
        type: "number",
        description: "Filter by company ID",
        required: false,
      },
      count: {
        type: "number",
        description: "Max number of users to return",
        required: false,
      },
    },
    actionType: "jitbit.list_users",
    riskLevel: "low",
  },
  {
    name: "jitbit.search_users",
    description:
      "Search Jitbit users by name or email.",
    params: {
      query: {
        type: "string",
        description: "Search query (name or email)",
        required: true,
      },
    },
    actionType: "jitbit.search_users",
    riskLevel: "low",
  },
  {
    name: "jitbit.list_companies",
    description:
      "List all Jitbit companies (organizations).",
    params: {},
    actionType: "jitbit.list_companies",
    riskLevel: "low",
  },
  {
    name: "jitbit.search_companies",
    description:
      "Search Jitbit companies by name.",
    params: {
      query: {
        type: "string",
        description: "Company name search query",
        required: true,
      },
    },
    actionType: "jitbit.search_companies",
    riskLevel: "low",
  },
  {
    name: "jitbit.list_categories",
    description:
      "List Jitbit ticket categories.",
    params: {},
    actionType: "jitbit.list_categories",
    riskLevel: "low",
  },
  {
    name: "jitbit.list_priorities",
    description:
      "List Jitbit ticket priorities.",
    params: {},
    actionType: "jitbit.list_priorities",
    riskLevel: "low",
  },
  {
    name: "jitbit.subscribe_to_ticket",
    description:
      "Subscribe the current user to a Jitbit ticket to receive notifications.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
      userId: {
        type: "number",
        description: "User ID to subscribe (optional, defaults to current user)",
        required: false,
      },
    },
    actionType: "jitbit.subscribe_to_ticket",
    riskLevel: "low",
  },
  {
    name: "jitbit.unsubscribe_from_ticket",
    description:
      "Unsubscribe the current user from a Jitbit ticket.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
      userId: {
        type: "number",
        description: "User ID to unsubscribe (optional, defaults to current user)",
        required: false,
      },
    },
    actionType: "jitbit.unsubscribe_from_ticket",
    riskLevel: "low",
  },
  {
    name: "jitbit.list_attachments",
    description:
      "List attachments on a Jitbit ticket.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
    },
    actionType: "jitbit.list_attachments",
    riskLevel: "low",
  },
  {
    name: "jitbit.add_attachment",
    description:
      "Add an attachment to a Jitbit ticket.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
      fileName: {
        type: "string",
        description: "File name for the attachment",
        required: true,
      },
      data: {
        type: "string",
        description: "Base64-encoded file data",
        required: true,
      },
    },
    actionType: "jitbit.add_attachment",
    riskLevel: "medium",
  },
  {
    name: "jitbit.get_attachment",
    description:
      "Get a specific Jitbit attachment by ID.",
    params: {
      attachmentId: {
        type: "number",
        description: "Attachment ID",
        required: true,
      },
    },
    actionType: "jitbit.get_attachment",
    riskLevel: "low",
  },
  {
    name: "jitbit.delete_attachment",
    description:
      "Delete a Jitbit attachment by ID.",
    params: {
      attachmentId: {
        type: "number",
        description: "Attachment ID to delete",
        required: true,
      },
    },
    actionType: "jitbit.delete_attachment",
    riskLevel: "medium",
  },
  {
    name: "jitbit.summarize_ticket",
    description:
      "Get a Jitbit ticket with its comments and an AI-ready summary. Useful for quickly understanding a ticket's current state.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
    },
    actionType: "jitbit.summarize_ticket",
    riskLevel: "low",
  },
  {
    name: "jitbit.list_custom_fields",
    description:
      "List custom fields for Jitbit tickets (optionally filtered by category).",
    params: {
      categoryId: {
        type: "number",
        description: "Filter custom fields by category ID",
        required: false,
      },
    },
    actionType: "jitbit.list_custom_fields",
    riskLevel: "low",
  },
  {
    name: "jitbit.get_custom_field_values",
    description:
      "Get custom field values for a Jitbit ticket.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
    },
    actionType: "jitbit.get_custom_field_values",
    riskLevel: "low",
  },
  {
    name: "jitbit.set_custom_field_value",
    description:
      "Set a custom field value on a Jitbit ticket.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
      fieldId: {
        type: "number",
        description: "Custom field ID",
        required: true,
      },
      value: {
        type: "string",
        description: "Value to set",
        required: true,
      },
    },
    actionType: "jitbit.set_custom_field_value",
    riskLevel: "medium",
  },
  {
    name: "jitbit.list_tags",
    description:
      "List all tags in Jitbit.",
    params: {},
    actionType: "jitbit.list_tags",
    riskLevel: "low",
  },
  {
    name: "jitbit.list_sections",
    description:
      "List Jitbit sections (optionally filtered by category).",
    params: {
      categoryId: {
        type: "number",
        description: "Filter sections by category ID",
        required: false,
      },
    },
    actionType: "jitbit.list_sections",
    riskLevel: "low",
  },
  {
    name: "jitbit.get_time_entries",
    description:
      "Get time tracking entries for a Jitbit ticket.",
    params: {
      ticketId: {
        type: "number",
        description: "Jitbit ticket ID",
        required: true,
      },
    },
    actionType: "jitbit.get_time_entries",
    riskLevel: "low",
  },
  {
    name: "jitbit.get_automation_rule",
    description:
      "Get details of a specific Jitbit automation rule by ID.",
    params: {
      ruleId: {
        type: "number",
        description: "Automation rule ID",
        required: true,
      },
    },
    actionType: "jitbit.get_automation_rule",
    riskLevel: "low",
  },
  {
    name: "jitbit.enable_automation_rule",
    description:
      "Enable a Jitbit automation rule.",
    params: {
      ruleId: {
        type: "number",
        description: "Automation rule ID to enable",
        required: true,
      },
    },
    actionType: "jitbit.enable_automation_rule",
    riskLevel: "medium",
  },
  {
    name: "jitbit.disable_automation_rule",
    description:
      "Disable a Jitbit automation rule.",
    params: {
      ruleId: {
        type: "number",
        description: "Automation rule ID to disable",
        required: true,
      },
    },
    actionType: "jitbit.disable_automation_rule",
    riskLevel: "medium",
  },

  // ==================== HAWK IR Tools ====================
  {
    name: "hawk_ir.get_cases",
    description:
      "Get HAWK IR incident response cases with optional filters. Defaults to last 10 days. Max range is 10 days — use weeklyReport for longer periods.",
    params: {
      startDate: {
        type: "string",
        description: "Start date filter (YYYY-MM-DD). Defaults to 10 days ago.",
        required: false,
      },
      stopDate: {
        type: "string",
        description: "End date filter (YYYY-MM-DD). Defaults to now.",
        required: false,
      },
      groupId: {
        type: "string",
        description: "Filter by group ID",
        required: false,
      },
      limit: {
        type: "number",
        description: "Max number of cases to return (default 20, max 100)",
        required: false,
      },
      offset: {
        type: "number",
        description: "Number of cases to skip for pagination",
        required: false,
      },
    },
    actionType: "hawk_ir.get_cases",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.get_case",
    description:
      "Get a specific HAWK IR case by ID with full details.",
    params: {
      caseId: {
        type: "string",
        description: "HAWK IR case ID (with or without # prefix)",
        required: true,
      },
    },
    actionType: "hawk_ir.get_case",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.get_case_summary",
    description:
      "Get a summary of a HAWK IR case including key details and recommendations.",
    params: {
      caseId: {
        type: "string",
        description: "HAWK IR case ID",
        required: true,
      },
    },
    actionType: "hawk_ir.get_case_summary",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.get_risky_open_cases",
    description:
      "Get HAWK IR cases that are high risk and NOT yet escalated (excludes escalated cases). Use this for finding cases that need attention or escalation. For already-escalated cases, use hawk_ir.get_escalated_cases instead.",
    params: {
      minRiskLevel: {
        type: "string",
        description: "Minimum risk level: low, medium, moderate, high, critical (default: high)",
        required: false,
      },
      limit: {
        type: "number",
        description: "Max cases to return (default 25)",
        required: false,
      },
    },
    actionType: "hawk_ir.get_risky_open_cases",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.get_escalated_cases",
    description:
      "Get HAWK IR cases that have been escalated (escalated=true). Use this for customer briefings, escalation reports, and tracking which incidents have been elevated. Returns open escalated cases sorted by escalation time.",
    params: {
      limit: {
        type: "number",
        description: "Max cases to return (default 25)",
        required: false,
      },
    },
    actionType: "hawk_ir.get_escalated_cases",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.deescalate_case",
    description:
      "De-escalate a HAWK IR case with a reason. Requires approval.",
    params: {
      caseId: {
        type: "string",
        description: "HAWK IR case ID",
        required: true,
      },
      reason: {
        type: "string",
        description: "Reason for de-escalation",
        required: true,
      },
      note: {
        type: "string",
        description: "Optional additional note",
        required: false,
      },
    },
    actionType: "hawk_ir.deescalate_case",
    riskLevel: "high",
  },
  {
    name: "hawk_ir.add_case_note",
    description:
      "Add a note/comment to a HAWK IR case. Use to document findings, link to Jira tickets, or record investigation decisions. Requires approval.",
    params: {
      caseId: {
        type: "string",
        description: "HAWK IR case ID (e.g., \"#635:1069\" or \"635:1069\")",
        required: true,
      },
      body: {
        type: "string",
        description: "Note content to add to the case (markdown supported)",
        required: true,
      },
    },
    actionType: "hawk_ir.add_case_note",
    riskLevel: "medium",
  },
  {
    name: "hawk_ir.update_case_status",
    description:
      "Update the progress status of a HAWK IR case. Valid statuses: New, Open, In Progress, Closed, Resolved. High risk — requires approval.",
    params: {
      caseId: {
        type: "string",
        description: "HAWK IR case ID (e.g., \"#635:1069\" or \"635:1069\")",
        required: true,
      },
      status: {
        type: "string",
        description: "Target status: New, Open, In Progress, Closed, or Resolved",
        required: true,
      },
      comment: {
        type: "string",
        description: "Optional reason for the status change (also added as a case note)",
        required: false,
      },
    },
    actionType: "hawk_ir.update_case_status",
    riskLevel: "high",
  },
  {
    name: "hawk_ir.update_case_risk",
    description:
      "Update the risk level of a HAWK IR case. Valid levels: Informational, Low, Moderate, High, Critical. High risk — requires approval.",
    params: {
      caseId: {
        type: "string",
        description: "HAWK IR case ID (e.g., \"#635:1069\" or \"635:1069\")",
        required: true,
      },
      riskLevel: {
        type: "string",
        description: "Target risk level: Informational, Low, Moderate, High, or Critical",
        required: true,
      },
      reason: {
        type: "string",
        description: "Justification for the risk level change (also added as a case note)",
        required: false,
      },
    },
    actionType: "hawk_ir.update_case_risk",
    riskLevel: "high",
  },
  {
    name: "hawk_ir.escalate_case",
    description:
      "Escalate a HAWK IR case. Marks the case as escalated with an escalation type, optional vendor name, and optional ticket ID. Critical risk — requires MFA and approval.",
    params: {
      caseId: {
        type: "string",
        description: 'HAWK IR case ID (e.g., "#635:1069" or "635:1069")',
        required: true,
      },
      type: {
        type: "string",
        description: "Escalation type: vendor, internal, or customer",
        required: true,
      },
      vendor: {
        type: "string",
        description: "Vendor name (e.g., 'Customer'). Used when type is 'vendor'.",
        required: false,
      },
      ticketId: {
        type: "string",
        description: "External ticket ID to link (e.g., 'JITBIT-99032784')",
        required: false,
      },
      comment: {
        type: "string",
        description: "Optional note to add to the case when escalating",
        required: false,
      },
    },
    actionType: "hawk_ir.escalate_case",
    riskLevel: "high",
  },
  {
    name: "hawk_ir.assign_case",
    description:
      "Assign a HAWK IR case to a specific owner by user ID. Medium risk — requires approval.",
    params: {
      caseId: {
        type: "string",
        description: 'HAWK IR case ID (e.g., "#635:1069" or "635:1069")',
        required: true,
      },
      ownerId: {
        type: "string",
        description: "User ID of the new case owner",
        required: true,
      },
      comment: {
        type: "string",
        description: "Optional note to add to the case when assigning",
        required: false,
      },
    },
    actionType: "hawk_ir.assign_case",
    riskLevel: "medium",
  },
  {
    name: "hawk_ir.merge_cases",
    description:
      "Merge a duplicate HAWK IR source case into a canonical target case. High risk — source case is closed/redirected and requires approval.",
    params: {
      sourceCaseId: {
        type: "string",
        description: 'Source case ID to merge from (e.g., "#635:1068")',
        required: true,
      },
      targetCaseId: {
        type: "string",
        description: 'Target case ID to merge into (e.g., "#635:1069")',
        required: true,
      },
    },
    actionType: "hawk_ir.merge_cases",
    riskLevel: "high",
  },
  {
    name: "hawk_ir.rename_case",
    description:
      "Rename a HAWK IR case. Low risk cosmetic change, but still requires approval.",
    params: {
      caseId: {
        type: "string",
        description: 'HAWK IR case ID (e.g., "#635:1069")',
        required: true,
      },
      name: {
        type: "string",
        description: "New case name",
        required: true,
      },
    },
    actionType: "hawk_ir.rename_case",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.update_case_details",
    description:
      "Update the details/context field of a HAWK IR case. Medium risk — modifies case record and requires approval.",
    params: {
      caseId: {
        type: "string",
        description: 'HAWK IR case ID (e.g., "#635:1069")',
        required: true,
      },
      details: {
        type: "string",
        description: "Case details text",
        required: true,
      },
    },
    actionType: "hawk_ir.update_case_details",
    riskLevel: "medium",
  },
  {
    name: "hawk_ir.set_case_categories",
    description:
      "Set categories on a HAWK IR case. Use hawk_ir.get_case_categories first to discover valid categories.",
    params: {
      caseId: {
        type: "string",
        description: 'HAWK IR case ID (e.g., "#635:1069")',
        required: true,
      },
      categories: {
        type: "array",
        description: 'Array of category names, e.g. ["Vulnerability Scanner", "False Positive"]',
        required: true,
      },
    },
    actionType: "hawk_ir.set_case_categories",
    riskLevel: "medium",
  },
  {
    name: "hawk_ir.add_ignore_label",
    description:
      "Add a suppression/ignore label to reduce future false positive noise. High risk — suppresses matching alerts and requires approval.",
    params: {
      label: {
        type: "string",
        description: "Label text to add to the ignore list",
        required: true,
      },
      category: {
        type: "string",
        description: "Optional label category",
        required: false,
      },
    },
    actionType: "hawk_ir.add_ignore_label",
    riskLevel: "high",
  },
  {
    name: "hawk_ir.delete_ignore_label",
    description:
      "Remove a suppression/ignore label, re-enabling alerts that were previously suppressed. High risk — requires approval.",
    params: {
      labelId: {
        type: "string",
        description: "Ignore label ID to remove",
        required: true,
      },
    },
    actionType: "hawk_ir.delete_ignore_label",
    riskLevel: "high",
  },
  {
    name: "hawk_ir.get_case_categories",
    description: "Get available HAWK IR case categories before setting case categories.",
    params: {},
    actionType: "hawk_ir.get_case_categories",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.get_case_labels",
    description: "Get HAWK IR ignore labels and label categories.",
    params: {},
    actionType: "hawk_ir.get_case_labels",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.quarantine_host",
    description:
      "Quarantine a host/IP in HAWK IR. Blocks network access for the specified target and associates it with a case. Critical risk — requires MFA, approval, and dry run.",
    params: {
      caseId: {
        type: "string",
        description: 'Case ID to associate the quarantine with (e.g., "#635:1069")',
        required: true,
      },
      target: {
        type: "string",
        description: "IP address or hostname to quarantine (e.g., '10.42.73.9')",
        required: true,
      },
      type: {
        type: "string",
        description: "Quarantine type. Default: 'ip'. Options: 'ip', 'hostname'",
        required: false,
      },
      expires: {
        type: "string",
        description: "Expiration: '-1' for indefinite (default), or duration like '1h', '24h', '7d', '1w'",
        required: false,
      },
    },
    actionType: "hawk_ir.quarantine_host",
    riskLevel: "high",
  },
  {
    name: "hawk_ir.unquarantine_host",
    description:
      "Remove quarantine from a host/IP in HAWK IR. Reverts the quarantine record, restoring network access. Critical risk — requires MFA and approval.",
    params: {
      caseId: {
        type: "string",
        description: 'Case ID the quarantine is associated with (e.g., "#635:1069")',
        required: true,
      },
      target: {
        type: "string",
        description: "IP address or hostname to unquarantine (e.g., '10.42.73.9')",
        required: true,
      },
    },
    actionType: "hawk_ir.unquarantine_host",
    riskLevel: "high",
  },
  {
    name: "hawk_ir.search_logs",
    description:
      "Search HAWK IR logs/explore data with query and optional filters (index, date range, pagination).",
    params: {
      query: {
        type: "string",
        description: "Search query string",
        required: true,
      },
      index: {
        type: "string",
        description: "Log index to search",
        required: false,
      },
      from: {
        type: "string",
        description: "Start date/time filter",
        required: false,
      },
      to: {
        type: "string",
        description: "End date/time filter",
        required: false,
      },
      size: {
        type: "number",
        description: "Max results to return",
        required: false,
      },
    },
    actionType: "hawk_ir.search_logs",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.get_available_indexes",
    description:
      "List available HAWK IR log indexes for explore/search.",
    params: {},
    actionType: "hawk_ir.get_available_indexes",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.get_fields",
    description:
      "Get available field names for a HAWK IR log index. Use this to discover searchable field names before constructing search queries. Field names can be used in search queries like 'audit_login: false' or 'ip_src: 10.0.0.1'.",
    params: {
      idx: {
        type: "string",
        description: "Index name (from get_available_indexes)",
        required: true,
      },
    },
    actionType: "hawk_ir.get_fields",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.get_assets",
    description:
      "Get HAWK IR assets (endpoints) with optional filters (search, pagination, sort).",
    params: {
      search: {
        type: "string",
        description: "Search term for asset name/IP",
        required: false,
      },
      limit: {
        type: "number",
        description: "Max results to return (default 25)",
        required: false,
      },
    },
    actionType: "hawk_ir.get_assets",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.get_asset_summary",
    description:
      "Get a summary of all HAWK IR assets including tag counts, OS distribution, and adapter counts.",
    params: {},
    actionType: "hawk_ir.get_asset_summary",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.get_identities",
    description:
      "Get HAWK IR identities with optional filters (search, pagination).",
    params: {
      search: {
        type: "string",
        description: "Search term for identity name",
        required: false,
      },
      limit: {
        type: "number",
        description: "Max results to return (default 25)",
        required: false,
      },
    },
    actionType: "hawk_ir.get_identities",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.get_identity_summary",
    description:
      "Get a summary of all HAWK IR identities including tag counts, admin counts, and adapter counts.",
    params: {},
    actionType: "hawk_ir.get_identity_summary",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.list_nodes",
    description:
      "List HAWK IR nodes (sensors/agents) with optional group ID filter.",
    params: {
      groupIds: {
        type: "string",
        description: "Comma-separated group IDs to filter nodes",
        required: false,
      },
    },
    actionType: "hawk_ir.list_nodes",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.get_active_nodes",
    description:
      "Get active HAWK IR nodes (approved sensors/agents), sorted by most recently seen.",
    params: {},
    actionType: "hawk_ir.get_active_nodes",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.list_dashboards",
    description:
      "List HAWK IR dashboards.",
    params: {},
    actionType: "hawk_ir.list_dashboards",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.run_dashboard",
    description:
      "Run a HAWK IR dashboard widget query for data aggregation. Supports pagination via body.pagination (limit, offset, page). Time range enforced to max 10 days.",
    params: {
      dashboardId: {
        type: "string",
        description: "Dashboard ID to run",
        required: true,
      },
      body: {
        type: "object",
        description: "Request body: { widget?, index?, timeRange: { from, to }, pagination: { limit, offset, page } }",
        required: false,
      },
    },
    actionType: "hawk_ir.run_dashboard",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.run_dashboard_query",
    description:
      "Run an ad-hoc HAWK IR dashboard query without needing a saved dashboard. Time range is enforced to a maximum of 10 days. For longer periods use hawk_ir.weekly_report or hawk_ir.monthly_summary.",
    params: {
      from: {
        type: "string",
        description: "Start of the query time range (ISO 8601)",
        required: true,
      },
      to: {
        type: "string",
        description: "End of the query time range (ISO 8601). Defaults to now.",
        required: false,
      },
      query: {
        type: "string",
        description: "Lucene/KQL query string. Defaults to '*'.",
        required: false,
      },
      index: {
        type: "string",
        description: "Index pattern to query (e.g. 'logs-*')",
        required: false,
      },
      type: {
        type: "string",
        description: "Visualization type: table, bar, line, pie, count, or metric. Defaults to 'table'.",
        required: false,
      },
      columns: {
        type: "array",
        description: "List of field names to include as columns",
        required: false,
      },
      groupBy: {
        type: "array",
        description: "List of field names to group results by",
        required: false,
      },
      metrics: {
        type: "array",
        description: "Metric definitions: array of { field, operator }",
        required: false,
      },
      size: {
        type: "number",
        description: "Maximum number of results to return. Defaults to 25.",
        required: false,
      },
      sort: {
        type: "object",
        description: "Sort order: { field, direction: 'asc'|'desc' }",
        required: false,
      },
      pagination: {
        type: "object",
        description: "Pagination: { limit?, offset?, page? }",
        required: false,
      },
    },
    actionType: "hawk_ir.run_dashboard_query",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.weekly_report",
    description:
      "Generate a HAWK IR weekly report covering the last 10 days. Returns aggregated dashboard query results. For custom time ranges use hawk_ir.run_dashboard_query.",
    params: {
      query: {
        type: "string",
        description: "Optional Lucene/KQL filter query. Defaults to '*'.",
        required: false,
      },
      index: {
        type: "string",
        description: "Index pattern to query (e.g. 'logs-*')",
        required: false,
      },
      columns: {
        type: "array",
        description: "List of field names to include as columns",
        required: false,
      },
      groupBy: {
        type: "array",
        description: "List of field names to group results by",
        required: false,
      },
      metrics: {
        type: "array",
        description: "Metric definitions: array of { field, operator }",
        required: false,
      },
      size: {
        type: "number",
        description: "Maximum number of results to return. Defaults to 25.",
        required: false,
      },
    },
    actionType: "hawk_ir.weekly_report",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.monthly_summary",
    description:
      "Generate a HAWK IR monthly summary by running up to 3 weekly queries (each within the 10-day limit) and returning combined results. Use for trend analysis across ~30 days.",
    params: {
      query: {
        type: "string",
        description: "Optional Lucene/KQL filter query. Defaults to '*'.",
        required: false,
      },
      index: {
        type: "string",
        description: "Index pattern to query (e.g. 'logs-*')",
        required: false,
      },
      columns: {
        type: "array",
        description: "List of field names to include as columns",
        required: false,
      },
      groupBy: {
        type: "array",
        description: "List of field names to group results by",
        required: false,
      },
      metrics: {
        type: "array",
        description: "Metric definitions: array of { field, operator }",
        required: false,
      },
    },
    actionType: "hawk_ir.monthly_summary",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.get_case_count",
    description:
      "Get the count of HAWK IR incident response cases within the last 10 days.",
    params: {},
    actionType: "hawk_ir.get_case_count",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.get_recent_cases",
    description:
      "Get recent HAWK IR incident response cases from the last 10 days with pagination.",
    params: {
      limit: {
        type: "number",
        description: "Maximum number of cases to return. Default: 20",
        required: false,
      },
      offset: {
        type: "number",
        description: "Number of cases to skip for pagination. Default: 0",
        required: false,
      },
    },
    actionType: "hawk_ir.get_recent_cases",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.get_log_histogram",
    description:
      "Get histogram data for HAWK IR log explore queries. Returns time-bucketed counts for visualization.",
    params: {
      q: {
        type: "string",
        description: "Search query string",
        required: true,
      },
      idx: {
        type: "string",
        description: "Index to search",
        required: false,
      },
      from: {
        type: "string",
        description: "Start date/time filter",
        required: false,
      },
      to: {
        type: "string",
        description: "End date/time filter",
        required: false,
      },
      interval: {
        type: "string",
        description: "Histogram interval (e.g. '1h', '1d')",
        required: false,
      },
    },
    actionType: "hawk_ir.get_log_histogram",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.get_saved_searches",
    description:
      "Get saved search configurations from HAWK IR.",
    params: {},
    actionType: "hawk_ir.get_saved_searches",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.get_artefacts",
    description:
      "Get HAWK IR artefacts (forensic artifacts) with optional asset filter.",
    params: {
      asset: {
        type: "string",
        description: "Filter artefacts by asset identifier",
        required: false,
      },
    },
    actionType: "hawk_ir.get_artefacts",
    riskLevel: "low",
  },
  {
    name: "hawk_ir.execute_hybrid_tool",
    description:
      "Dispatch a hybrid investigation command to a HAWK IR node. Requires Admin or SOC privileges. Use to run forensic commands on remote sensors.",
    params: {
      groupId: {
        type: "string",
        description: "Group ID to target",
        required: true,
      },
      cmd: {
        type: "string",
        description: "Command to execute on the node",
        required: true,
      },
      data: {
        type: "object",
        description: "Optional data payload for the command",
        required: false,
      },
      targetNodeId: {
        type: "string",
        description: "Optional specific node ID to target",
        required: false,
      },
      timeoutMs: {
        type: "number",
        description: "Optional timeout in milliseconds",
        required: false,
      },
    },
    actionType: "hawk_ir.execute_hybrid_tool",
    riskLevel: "high",
  },

  // ==================== Work Items Tools ====================
  {
    name: "work_items.create",
    description:
      "Create a work item to track a task, decision, code review, customer follow-up, roadmap item, or other work. Work items persist across sessions and can link to Jira/GitHub/GitLab resources.",
    params: {
      type: {
        type: "string",
        description:
          'Item type: task, decision, code_review, roadmap, customer_followup, detection, research, personal, support, release',
        required: true,
      },
      title: {
        type: "string",
        description: "Short title for the work item",
        required: true,
      },
      description: {
        type: "string",
        description: "Detailed description",
        required: false,
      },
      status: {
        type: "string",
        description:
          'Initial status: proposed, planned, active, blocked, waiting, done. Default: proposed',
        required: false,
      },
      priority: {
        type: "string",
        description: 'Priority: low, medium, high, critical. Default: medium',
        required: false,
      },
      owner: {
        type: "string",
        description: "Person responsible for this item",
        required: false,
      },
      source: {
        type: "string",
        description:
          'Where this item originated: chat, jira, github, gitlab, jitbit, calendar, manual, roadmap. Default: chat',
        required: false,
      },
      sourceUrl: {
        type: "string",
        description: "URL to the source (e.g., Jira ticket, GitHub PR)",
        required: false,
      },
      dueAt: {
        type: "string",
        description: "Due date in ISO 8601 format",
        required: false,
      },
      tags: {
        type: "array",
        description: 'Array of tag strings, e.g. ["security","urgent"]',
        required: false,
      },
      dryRun: {
        type: "boolean",
        description: "Preview what would happen without executing",
        required: false,
      },
    },
    actionType: "work_items.create",
    riskLevel: "medium",
  },
  {
    name: "work_items.list",
    description:
      "List work items with optional filters. Returns items sorted by creation date (newest first). Excludes archived items by default.",
    params: {
      status: {
        type: "string",
        description: "Filter by status: proposed, planned, active, blocked, waiting, done, archived",
        required: false,
      },
      type: {
        type: "string",
        description: "Filter by type: task, decision, code_review, roadmap, etc.",
        required: false,
      },
      priority: {
        type: "string",
        description: "Filter by priority: low, medium, high, critical",
        required: false,
      },
      owner: {
        type: "string",
        description: "Filter by owner",
        required: false,
      },
      search: {
        type: "string",
        description: "Search title and description for this text",
        required: false,
      },
      includeArchived: {
        type: "boolean",
        description: "Include archived items. Default: false",
        required: false,
      },
    },
    actionType: "work_items.list",
    riskLevel: "low",
  },
  {
    name: "work_items.update",
    description:
      "Update a work item's fields (title, description, status, priority, owner, due date, tags). Only provided fields are changed.",
    params: {
      id: {
        type: "string",
        description: "Work item ID",
        required: true,
      },
      title: {
        type: "string",
        description: "New title",
        required: false,
      },
      description: {
        type: "string",
        description: "New description",
        required: false,
      },
      status: {
        type: "string",
        description: "New status",
        required: false,
      },
      priority: {
        type: "string",
        description: "New priority",
        required: false,
      },
      owner: {
        type: "string",
        description: "New owner",
        required: false,
      },
      dueAt: {
        type: "string",
        description: "New due date (ISO 8601), or empty string to clear",
        required: false,
      },
      tags: {
        type: "array",
        description: 'New set of tags, e.g. ["security","urgent"]',
        required: false,
      },
      dryRun: {
        type: "boolean",
        description: "Preview what would happen without executing",
        required: false,
      },
    },
    actionType: "work_items.update",
    riskLevel: "medium",
  },
  {
    name: "work_items.add_note",
    description:
      "Add a note to a work item. Notes track progress, context, and decisions over time.",
    params: {
      id: {
        type: "string",
        description: "Work item ID",
        required: true,
      },
      content: {
        type: "string",
        description: "Note text",
        required: true,
      },
    },
    actionType: "work_items.add_note",
    riskLevel: "low",
  },
  {
    name: "work_items.complete",
    description: "Mark a work item as done and set its completedAt timestamp.",
    params: {
      id: {
        type: "string",
        description: "Work item ID",
        required: true,
      },
    },
    actionType: "work_items.complete",
    riskLevel: "low",
  },

  // ==================== LSP Tools ====================
  {
    name: "lsp.diagnostics",
    description:
      "Get code diagnostics (errors, warnings) for a file using Language Server Protocol. Returns a list of diagnostic items with severity, message, line, and column.",
    params: {
      filePath: {
        type: "string",
        description: "Path to the file to get diagnostics for",
        required: true,
      },
      severity: {
        type: "string",
        description:
          'Filter by severity: "error", "warning", "information", or "hint". Omit for all.',
        required: false,
      },
    },
    actionType: "lsp.diagnostics",
    riskLevel: "low",
  },
  {
    name: "lsp.hover",
    description:
      "Get hover information for a symbol at a position in a file using Language Server Protocol.",
    params: {
      filePath: {
        type: "string",
        description: "Path to the file",
        required: true,
      },
      line: {
        type: "number",
        description: "Line number (1-based)",
        required: true,
      },
      character: {
        type: "number",
        description: "Column number (1-based)",
        required: true,
      },
    },
    actionType: "lsp.hover",
    riskLevel: "low",
  },
  {
    name: "lsp.definition",
    description:
      "Go to definition of a symbol at a position in a file using Language Server Protocol.",
    params: {
      filePath: {
        type: "string",
        description: "Path to the file",
        required: true,
      },
      line: {
        type: "number",
        description: "Line number (1-based)",
        required: true,
      },
      character: {
        type: "number",
        description: "Column number (1-based)",
        required: true,
      },
    },
    actionType: "lsp.definition",
    riskLevel: "low",
  },
  {
    name: "lsp.references",
    description:
      "Find all references to a symbol at a position in a file using Language Server Protocol.",
    params: {
      filePath: {
        type: "string",
        description: "Path to the file",
        required: true,
      },
      line: {
        type: "number",
        description: "Line number (1-based)",
        required: true,
      },
      character: {
        type: "number",
        description: "Column number (1-based)",
        required: true,
      },
    },
    actionType: "lsp.references",
    riskLevel: "low",
  },
  {
    name: "lsp.symbols",
    description:
      "Search for workspace symbols matching a query using Language Server Protocol.",
    params: {
      query: {
        type: "string",
        description: "Search query for symbol names",
        required: true,
      },
    },
    actionType: "lsp.symbols",
    riskLevel: "low",
  },
];

/**
 * Agent run tools — query and inspect agent run history
 */
const AGENT_RUN_TOOLS: Tool[] = [
  {
    name: "agent.list_runs",
    description:
      "List your own recent agent runs with optional filters. Returns run IDs, status, mode, timestamps, and tool loop counts. Only returns runs belonging to the requesting user.",
    params: {
      status: {
        type: "string",
        description:
          "Filter by status: running, completed, failed",
        required: false,
      },
      limit: {
        type: "number",
        description: "Max results to return (default 25, max 100)",
        required: false,
      },
      offset: {
        type: "number",
        description: "Pagination offset (default 0)",
        required: false,
      },
    },
    actionType: "agent.runs.read",
    riskLevel: "low",
  },
  {
    name: "agent.get_run",
    description:
      "Get details of a specific agent run by ID, including all steps (tool calls, model responses, etc.)",
    params: {
      runId: {
        type: "string",
        description: "Agent run ID",
        required: true,
      },
    },
    actionType: "agent.runs.read",
    riskLevel: "low",
  },
  {
    name: "agent.get_run_stats",
    description:
      "Get aggregate statistics for agent runs: total, completed, failed, running counts, average tool loops, and recent activity",
    params: {},
    actionType: "agent.runs.read",
    riskLevel: "low",
  },
  {
    name: "agent.get_aicoder_status",
    description:
      "Get the latest aicoder agent run status — current running run or most recent completed run with steps",
    params: {},
    actionType: "agent.runs.read",
    riskLevel: "low",
  },
];

/**
 * Tools available in Engineering Strategy Mode
 */
const ENGINEERING_TOOLS: Tool[] = [
  {
    name: "engineering.workflow_brief",
    description:
      "Generate a comprehensive workflow brief from a project idea. Covers users, jobs-to-be-done, friction points, states, transitions, edge cases, automation opportunities, and guardrails.",
    params: {
      idea: {
        type: "string",
        description: "Project idea or problem description",
        required: true,
      },
    },
    actionType: "engineering.workflow.brief",
    riskLevel: "low",
  },
  {
    name: "engineering.architecture_proposal",
    description:
      "Generate an architecture proposal from a project idea. Includes recommended stack, system boundaries, data model, API design, auth, error handling, observability, and deployment model.",
    params: {
      idea: {
        type: "string",
        description: "Project idea or problem description",
        required: true,
      },
    },
    actionType: "engineering.architecture.proposal",
    riskLevel: "low",
  },
  {
    name: "engineering.scaffolding_plan",
    description:
      "Generate a scaffolding plan from a project idea. Includes repo structure, packages, env config, Docker setup, migrations, test setup, linting, CI pipeline, and docs structure.",
    params: {
      idea: {
        type: "string",
        description: "Project idea or problem description",
        required: true,
      },
    },
    actionType: "engineering.scaffolding.plan",
    riskLevel: "low",
  },
  {
    name: "engineering.jira_tickets",
    description:
      "Generate workflow brief, architecture, and Jira tickets from a project idea. Creates real Jira tickets in the specified project.",
    params: {
      idea: {
        type: "string",
        description: "Project idea or problem description",
        required: true,
      },
      projectKey: {
        type: "string",
        description: "Jira project key (e.g., 'PROJ')",
        required: true,
      },
    },
    actionType: "engineering.jira.tickets",
    riskLevel: "low",
  },
  {
    name: "engineering.ticket_to_task",
    description:
      "Convert a GitHub issue into a structured implementation prompt for coding agents. Fetches the issue, enriches with codebase context, roadmap context, and produces a ready-to-use prompt.",
    params: {
      owner: {
        type: "string",
        description: "Repository owner. Uses GITHUB_DEFAULT_OWNER if omitted.",
        required: false,
      },
      repo: {
        type: "string",
        description: "Repository name. Uses GITHUB_DEFAULT_REPO if omitted.",
        required: false,
      },
      issueNumber: {
        type: "number",
        description: "GitHub issue number",
        required: true,
      },
      agent: {
        type: "string",
        description: "Target agent: codex, cursor, claude, generic",
        required: false,
      },
      includeComments: {
        type: "boolean",
        description: "Include issue comments",
        required: false,
      },
      includeRoadmap: {
        type: "boolean",
        description: "Include roadmap context",
        required: false,
      },
      includeCodebase: {
        type: "boolean",
        description: "Include relevant file analysis",
        required: false,
      },
    },
    actionType: "engineering.ticket_to_task",
    riskLevel: "low",
  },
  {
    name: "ticket_bridge.generate_prompt",
    description:
      "Generate an agent-ready implementation prompt from a GitHub issue, Jira ticket, or roadmap item. Use when handing off a ticket to a coding agent or preparing a detailed implementation prompt.",
    params: {
      sourceType: {
        type: "string",
        description:
          "Ticket source type: 'github', 'jira', or 'roadmap'",
        required: true,
      },
      sourceId: {
        type: "string",
        description:
          "Ticket identifier: 'owner/repo#number' for GitHub, 'PROJECT-123' for Jira, or UUID for roadmap",
        required: true,
      },
      includeCodebaseIndex: {
        type: "boolean",
        description: "Include relevant file paths from codebase index",
        required: false,
      },
      includeArchitecture: {
        type: "boolean",
        description: "Include architecture constraints from docs",
        required: false,
      },
      maxFiles: {
        type: "number",
        description: "Max files to include as context (default: 10)",
        required: false,
      },
    },
    actionType: "ticket_bridge.generate",
    riskLevel: "low",
  },
];

/**
 * Core productivity tools — the most commonly used subset sent to the model.
 * Extended tools (full GitLab/GitHub/Jira) are available via discover_tools.
 */
const CORE_PRODUCTIVITY_TOOLS: Tool[] = [
  // Calendar
  PRODUCTIVITY_TOOLS.find((t) => t.name === "calendar.list_events")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "calendar.create_focus_block")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "calendar.create_health_block")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "calendar.create_event")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "calendar.get_event")!,

  // Jira core
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jira.list_projects")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jira.list_assigned")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jira.get_issue")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jira.search_issues")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jira.create_issue")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jira.update_issue")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jira.add_comment")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jira.transition_issue")!,

  // GitLab core
  PRODUCTIVITY_TOOLS.find((t) => t.name === "gitlab.list_projects")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "gitlab.get_project")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "gitlab.list_merge_requests")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "gitlab.get_merge_request")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "gitlab.get_file")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "gitlab.list_tree")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "gitlab.search_code")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "gitlab.list_commits")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "gitlab.list_branches")!,

  // GitHub core
  PRODUCTIVITY_TOOLS.find((t) => t.name === "github.list_repos")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "github.get_repo")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "github.get_file")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "github.search_code")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "github.list_tree")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "github.list_issues")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "github.get_issue")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "github.create_issue")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "github.update_issue")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "github.add_issue_comment")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "github.list_branches")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "github.create_branch")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "github.list_pull_requests")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "github.create_pull_request")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "github.add_pr_comment")!,

  // Planning
  PRODUCTIVITY_TOOLS.find(
    (t) => t.name === "productivity.generate_daily_plan",
  )!,
  PRODUCTIVITY_TOOLS.find(
    (t) => t.name === "productivity.generate_weekly_plan",
  )!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "cto.daily_command_center")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "cto.create_suggested_work_items")!,

  // Personal OS core
  PRODUCTIVITY_TOOLS.find((t) => t.name === "personal_os.brief")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "personal_os.open_loops")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "personal_os.detect_patterns")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "personal_os.suggest_focus")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "personal_os.create_work_items")!,

  // Product Chief of Staff
  PRODUCTIVITY_TOOLS.find((t) => t.name === "product.workflow_brief")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "product.roadmap_proposal")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "product.roadmap_drift")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "product.customer_signals")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "product.weekly_update")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "product.create_work_items")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "product.shipped_vs_planned")!,

  // Code Review
  PRODUCTIVITY_TOOLS.find((t) => t.name === "code_review.github_pr")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "code_review.gitlab_mr")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "code_review.release_readiness")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "code_review.generate_comment")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "code_review.create_work_item")!,

  // HAWK IR core
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_cases")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_case")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_case_summary")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_risky_open_cases")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_escalated_cases")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.search_logs")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_available_indexes")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_fields")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_assets")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_asset_summary")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_identities")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_identity_summary")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.list_nodes")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_active_nodes")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.list_dashboards")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_case_count")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_recent_cases")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_log_histogram")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_saved_searches")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_artefacts")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_case_categories")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "hawk_ir.get_case_labels")!,

  // Jitbit extended
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.update_ticket")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.list_users")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.search_users")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.list_companies")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.search_companies")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.list_categories")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.list_priorities")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.list_custom_fields")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.get_custom_field_values")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.list_tags")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.list_sections")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.get_time_entries")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.get_automation_rule")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.search_assets")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.summarize_ticket")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.get_attachment")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.list_attachments")!,

  // Roadmap core
  PRODUCTIVITY_TOOLS.find((t) => t.name === "roadmap.list")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "roadmap.get")!,

  // LSP core
  PRODUCTIVITY_TOOLS.find((t) => t.name === "lsp.diagnostics")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "lsp.hover")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "lsp.definition")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "lsp.references")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "lsp.symbols")!,

  // System health
  PRODUCTIVITY_TOOLS.find((t) => t.name === "system.check_health")!,

  // Jitbit support/customer intelligence core
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.search_tickets")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.get_ticket")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.list_recent_tickets")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.get_customer_snapshot")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.find_followups")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.create_ticket")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.close_ticket")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.assign_ticket")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "jitbit.list_assets")!,

  // Work items
  PRODUCTIVITY_TOOLS.find((t) => t.name === "work_items.create")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "work_items.list")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "work_items.update")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "work_items.add_note")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "work_items.complete")!,
];

const APPROVAL_TOOLS: Tool[] = [
  {
    name: "system.approve_action",
    description:
      "Approve a pending action by its approval ID. Use this when the user verbally approves an action (e.g., 'approve', 'yes', 'do it').",
    params: {
      approvalId: {
        type: "string",
        description: "The approval ID to approve",
        required: true,
      },
    },
    actionType: "system.approve",
    riskLevel: "low",
  },
  {
    name: "system.reject_action",
    description:
      "Reject a pending action by its approval ID. Use this when the user verbally rejects an action.",
    params: {
      approvalId: {
        type: "string",
        description: "The approval ID to reject",
        required: true,
      },
    },
    actionType: "system.reject",
    riskLevel: "low",
  },
  {
    name: "system.list_approvals",
    description:
      "List pending approval requests. Use this to check if there are actions awaiting user approval.",
    params: {
      status: {
        type: "string",
        description:
          "Filter by status: pending, approved, rejected, executed, failed",
        required: false,
      },
    },
    actionType: "system.list_approvals",
    riskLevel: "low",
  },
];

/**
 * Meta-tool that lets the model discover and load more tools by category.
 * When called, it returns available categories and the model can request
 * specific ones to be added to its tool set.
 */
const DISCOVER_TOOL_META: Tool = {
  name: "discover_tools",
  description:
    "List available tool categories or load additional tools. Use this when you need capabilities beyond your current tools (e.g., pipeline operations, file writes, issue management, PR reviews). Call with no category to see what's available, or with a category name to load those tools.",
  params: {
    category: {
      type: "string",
      description:
        "Category to load (e.g., 'gitlab', 'github', 'jira', 'calendar'). Omit to list available categories.",
      required: false,
    },
  },
  actionType: "system.discover_tools",
  riskLevel: "low",
};

/**
 * Get tools by mode — returns core set for API calls.
 * Use getToolByName() to look up any tool by name (including extended tools).
 */
export function getTools(mode: string): Tool[] {
  switch (mode) {
    case AGENT_MODES.PRODUCTIVITY:
      return [
        ...AGENT_RUN_TOOLS,
        ...APPROVAL_TOOLS,
        ...CORE_PRODUCTIVITY_TOOLS,
        DISCOVER_TOOL_META,
      ];
    case AGENT_MODES.ENGINEERING:
      return [
        ...AGENT_RUN_TOOLS,
        ...ENGINEERING_TOOLS,
        ...APPROVAL_TOOLS,
        ...CORE_PRODUCTIVITY_TOOLS,
        DISCOVER_TOOL_META,
      ];
    default:
      return [];
  }
}

/**
 * Minimal tool reference for the system prompt.
 * The full tool definitions are sent via the API `tools` parameter —
 * listing them again as text would duplicate ~3K tokens per request.
 */
export function getToolInventorySummary(mode: string): string {
  const tools = getTools(mode);
  const categories = getToolCategories(mode);
  const catNames = Object.keys(categories).sort();

  // Build platform quick reference based on what's loaded vs what needs discovery
  const loadedNames = new Set(tools.map((t) => t.name));
  const platformRef: string[] = [];

  const platformCategories = [
    { name: "Calendar", prefix: "calendar", writeActions: ["event management"] },
    { name: "GitHub", prefix: "github", writeActions: ["create issue", "create PR", "create branch"] },
    { name: "GitLab", prefix: "gitlab", writeActions: ["pipeline/merge actions"] },
    { name: "HAWK IR", prefix: "hawk_ir", writeActions: ["case de-escalation", "case escalation", "case assignment", "host quarantine", "host unquarantine"] },
    { name: "Jira", prefix: "jira", writeActions: ["advanced fields"] },
    { name: "Jitbit", prefix: "jitbit", writeActions: ["ticket comments", "ticket lifecycle", "asset management", "tags", "time tracking", "custom fields", "automation"] },
    { name: "Code Review", prefix: "code_review", writeActions: ["create work item from review"] },
  ];

  for (const platform of platformCategories) {
    const catTools = categories[platform.prefix] || [];
    const loaded = catTools.filter((name) => loadedNames.has(name)).length;
    if (loaded > 0) {
      if (loaded === catTools.length) {
        platformRef.push(`- ${platform.name}: All tools loaded (${loaded}).`);
      } else {
        platformRef.push(
          `- ${platform.name}: ${loaded}/${catTools.length} tools loaded. For ${platform.writeActions.join(", ")}, call discover_tools("${platform.prefix}").`,
        );
      }
    }
  }

  const platformSection =
    platformRef.length > 0
      ? `\nPLATFORM QUICK REFERENCE:\n${platformRef.join("\n")}\n`
      : "";

  return `TOOLS: ${tools.length} loaded, expandable via discover_tools. Categories: ${catNames.join(", ")}.
${platformSection}IMPORTANT: You MUST use these tools to take actions. Do NOT say "I don't have access" or "I cannot do that" — if a tool exists for the action, USE IT. If you need a tool not in your current set, call discover_tools to load it.`;
}

/**
 * Full tool inventory with descriptions — kept for debugging and the /chat/tools endpoint.
 * Do NOT embed this in the system prompt; it duplicates the structured `tools` API parameter.
 */
export function getToolInventory(mode: string): string {
  const tools = getTools(mode);
  const lines = tools.map((t) => `- ${t.name}: ${t.description}`);
  const categories = getToolCategories(mode);
  const catNames = Object.keys(categories).sort().join(", ");

  // Build platform quick reference based on what's loaded vs what needs discovery
  const loadedNames = new Set(tools.map((t) => t.name));
  const platformRef: string[] = [];

  const platformCategories = [
    { name: "Calendar", prefix: "calendar", writeActions: ["event management"] },
    { name: "GitHub", prefix: "github", writeActions: ["create issue", "create PR", "create branch"] },
    { name: "GitLab", prefix: "gitlab", writeActions: ["pipeline/merge actions"] },
    { name: "HAWK IR", prefix: "hawk_ir", writeActions: ["case de-escalation", "case escalation", "case assignment", "host quarantine", "host unquarantine"] },
    { name: "Jira", prefix: "jira", writeActions: ["advanced fields"] },
    { name: "Jitbit", prefix: "jitbit", writeActions: ["ticket comments", "ticket lifecycle", "asset management", "tags", "time tracking", "custom fields", "automation"] },
    { name: "Code Review", prefix: "code_review", writeActions: ["create work item from review"] },
  ];

  for (const platform of platformCategories) {
    const catTools = categories[platform.prefix] || [];
    const loaded = catTools.filter((name) => loadedNames.has(name)).length;
    if (loaded > 0) {
      if (loaded === catTools.length) {
        platformRef.push(`- ${platform.name}: All tools loaded (${loaded}).`);
      } else {
        platformRef.push(
          `- ${platform.name}: ${loaded}/${catTools.length} tools loaded. For ${platform.writeActions.join(", ")}, call discover_tools("${platform.prefix}").`,
        );
      }
    }
  }

  const platformSection =
    platformRef.length > 0
      ? `\n\nPLATFORM QUICK REFERENCE:\n${platformRef.join("\n")}`
      : "";

  return `AVAILABLE TOOLS (${tools.length} loaded, expandable via discover_tools):
${lines.join("\n")}
${platformSection}

EXPANDABLE CATEGORIES (use discover_tools to load): ${catNames}

IMPORTANT: You MUST use these tools to take actions. Do NOT say "I don't have access" or "I cannot do that" — if a tool exists for the action, USE IT. If you need a tool not listed above, call discover_tools to load it.`;
}

export function getAllToolsForMode(mode: string): Tool[] {
  switch (mode) {
    case AGENT_MODES.PRODUCTIVITY:
      return [...AGENT_RUN_TOOLS, ...PRODUCTIVITY_TOOLS];
    case AGENT_MODES.ENGINEERING:
      return [...AGENT_RUN_TOOLS, ...ENGINEERING_TOOLS, ...PRODUCTIVITY_TOOLS];
    default:
      return [];
  }
}

/**
 * Get tool categories for a mode, used by discover_tools.
 */
export function getToolCategories(mode: string): Record<string, string[]> {
  const tools = getAllToolsForMode(mode);
  const categories: Record<string, string[]> = {};

  for (const tool of tools) {
    const dotIndex = tool.name.indexOf(".");
    const category = dotIndex > 0 ? tool.name.substring(0, dotIndex) : "other";
    if (!categories[category]) {
      categories[category] = [];
    }
    categories[category].push(tool.name);
  }

  return categories;
}

/**
 * Get tools by category for a mode.
 */
export function getToolsByCategory(mode: string, category: string): Tool[] {
  return getAllToolsForMode(mode).filter(
    (t) =>
      t.name.startsWith(category + ".") ||
      (category === "other" && !t.name.includes(".")),
  );
}

/**
 * Get tool by name — searches ALL tools for the mode, not just core.
 */
export function getToolByName(name: string, mode: string): Tool | undefined {
  const tools = getAllToolsForMode(mode);
  return tools.find((t) => t.name === name);
}
