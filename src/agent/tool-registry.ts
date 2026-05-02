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
    description: "List commits for a branch in a GitLab project",
    params: {
      projectId: {
        type: "string",
        description:
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
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
          "Project ID or path. Uses GITLAB_DEFAULT_PROJECT if not specified.",
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
 * Core productivity tools — the most commonly used subset sent to the model.
 * Extended tools (full GitLab/GitHub/Jira) are available via discover_tools.
 */
const CORE_PRODUCTIVITY_TOOLS: Tool[] = [
  // Calendar
  PRODUCTIVITY_TOOLS.find((t) => t.name === "calendar.list_events")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "calendar.create_focus_block")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "calendar.create_health_block")!,

  // Jira core
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

  // Planning
  PRODUCTIVITY_TOOLS.find(
    (t) => t.name === "productivity.generate_daily_plan",
  )!,

  // Roadmap core
  PRODUCTIVITY_TOOLS.find((t) => t.name === "roadmap.list")!,
  PRODUCTIVITY_TOOLS.find((t) => t.name === "roadmap.get")!,
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
      return [...CORE_PRODUCTIVITY_TOOLS, DISCOVER_TOOL_META];
    case AGENT_MODES.ENGINEERING:
      return [...ENGINEERING_TOOLS, DISCOVER_TOOL_META];
    default:
      return [];
  }
}

/**
 * Get full tool set by mode (all tools, not just core).
 * Used when the model requests more tools via discover_tools.
 */
export function getAllToolsForMode(mode: string): Tool[] {
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
