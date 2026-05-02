import { fileCalendarService } from "../integrations/file/calendar-service";
import { jiraService } from "../integrations/jira/jira-service";
import { jiraClient } from "../integrations/jira/jira-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { githubClient } from "../integrations/github/github-client";
import { dailyPlanner } from "../productivity/daily-planner";
import { roadmapDatabase } from "../roadmap/database";
import { auditLogger } from "../audit/logger";
import { env } from "../config/env";
import {
  getToolCategories,
  getToolsByCategory,
} from "./tool-registry";

export interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
  requiresApproval?: boolean;
  approvalId?: string;
}

async function handleCalendarListEvents(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const startDate = params.startDate
    ? new Date(params.startDate as string)
    : undefined;
  const endDate = params.endDate
    ? new Date(params.endDate as string)
    : undefined;
  const events = fileCalendarService.listEvents(startDate, endDate);
  return { success: true, data: events };
}

async function handleCalendarCreateFocusBlock(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!env.ENABLE_CALENDAR_WRITE) {
    return { success: false, error: "Calendar write operations are disabled" };
  }
  const event = await fileCalendarService.createFocusBlock({
    title: params.title as string,
    startTime: new Date(params.startTime as string),
    duration: params.duration as number,
    description: params.description as string | undefined,
  });
  return { success: true, data: event };
}

async function handleCalendarCreateHealthBlock(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!env.ENABLE_CALENDAR_WRITE) {
    return { success: false, error: "Calendar write operations are disabled" };
  }
  const event = await fileCalendarService.createHealthBlock({
    title: params.title as string,
    startTime: new Date(params.startTime as string),
    duration: params.duration as number,
    type: params.type as "fitness" | "meal" | "mental_health",
  });
  return { success: true, data: event };
}

async function handleJiraListAssigned(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  const status = params.status as string | undefined;
  const issues = await jiraService.getAssignedIssues(userId, status);
  return { success: true, data: issues };
}

async function handleJiraGetIssue(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  const issue = await jiraService.getIssue(params.key as string, userId);
  return { success: true, data: issue };
}

async function handleJiraAddComment(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  if (!env.ENABLE_JIRA_TRANSITIONS) {
    return { success: false, error: "Jira write operations are disabled" };
  }
  const result = await jiraService.addComment(
    params.key as string,
    params.body as string,
    userId,
  );
  return { success: true, data: result };
}

async function handleJiraTransitionIssue(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  if (!env.ENABLE_JIRA_TRANSITIONS) {
    return { success: false, error: "Jira transition operations are disabled" };
  }
  const result = await jiraService.transitionIssue(
    params.key as string,
    params.transition as string,
    userId,
    params.comment as string | undefined,
  );
  return { success: true, data: result };
}

async function handleJiraCreateProject(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  if (!env.ENABLE_JIRA_TRANSITIONS) {
    return { success: false, error: "Jira project creation is disabled" };
  }
  const result = await jiraService.createProject(
    {
      key: params.key as string,
      name: params.name as string,
      projectType: params.projectType as string | undefined,
      description: params.description as string | undefined,
    },
    userId,
  );
  return { success: true, data: result };
}

async function handleJiraCreateIssue(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  if (!jiraClient.isConfigured()) {
    return { success: false, error: "Jira client not configured" };
  }

  const project = params.project as string;
  const summary = params.summary as string;
  if (!project || !summary) {
    return {
      success: false,
      error: "project and summary are required to create an issue",
    };
  }

  const issueType = (params.issueType as string) || "Task";

  const labels = params.labels
    ? (params.labels as string)
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean)
    : undefined;

  const result = await jiraClient.createIssue({
    project,
    summary,
    description: params.description as string | undefined,
    issueType,
    assignee: params.assignee as string | undefined,
  });

  if (labels && labels.length > 0) {
    try {
      await jiraClient.updateIssue(result.key, { labels });
    } catch {
      // labels are best-effort
    }
  }

  if (params.priority) {
    try {
      await jiraClient.updateIssue(result.key, {
        priority: { name: params.priority as string },
      });
    } catch {
      // priority is best-effort
    }
  }

  return {
    success: true,
    data: {
      key: result.key,
      summary,
      project,
      issueType,
      url: `${jiraClient.getBaseUrl()}/browse/${result.key}`,
    },
  };
}

async function handleJiraCreateIssues(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  if (!jiraClient.isConfigured()) {
    return { success: false, error: "Jira client not configured" };
  }

  let issues = params.issues;
  // The AI model may pass issues as a JSON string instead of an array
  if (typeof issues === "string") {
    try {
      issues = JSON.parse(issues);
    } catch {
      return { success: false, error: "issues parameter must be a valid JSON array" };
    }
  }

  if (!Array.isArray(issues) || issues.length === 0) {
    return { success: false, error: "issues must be a non-empty array of issue objects" };
  }

  // Validate and normalize each issue
  const normalized = issues.map((issue: any, i: number) => {
    const project = issue.project || issue.projectKey;
    const summary = issue.summary || issue.title;
    if (!project || !summary) {
      return { error: `Issue ${i + 1}: project and summary are required` };
    }
    return {
      project,
      summary,
      description: issue.description || issue.body || undefined,
      issueType: issue.issueType || issue.type || "Task",
      assignee: issue.assignee || undefined,
    };
  });

  const invalid = normalized.find((i: any) => i.error);
  if (invalid) {
    return { success: false, error: invalid.error };
  }

  try {
    const results = await jiraClient.bulkCreateIssues(normalized as any);
    const created = results.filter((r) => r.status === "created");
    const failed = results.filter((r) => r.status === "failed");

    return {
      success: created.length > 0,
      data: {
        created: created.length,
        failed: failed.length,
        issues: results.map((r) => ({
          key: r.key || "",
          summary: r.summary,
          status: r.status,
          url: r.key ? `${jiraClient.getBaseUrl()}/browse/${r.key}` : undefined,
          error: r.error,
        })),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Bulk create failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

async function handleJiraUpdateIssue(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  if (!jiraClient.isConfigured()) {
    return { success: false, error: "Jira client not configured" };
  }

  const key = params.key as string;
  if (!key) {
    return { success: false, error: "key is required" };
  }

  const fields: Record<string, unknown> = {};
  if (params.summary) fields.summary = params.summary;
  if (params.description) {
    fields.description = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: params.description as string }],
        },
      ],
    };
  }
  if (params.assignee) fields.assignee = { name: params.assignee as string };
  if (params.priority) fields.priority = { name: params.priority as string };
  if (params.labels) {
    fields.labels = (params.labels as string)
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  if (Object.keys(fields).length === 0) {
    return { success: false, error: "No fields provided to update" };
  }

  await jiraClient.updateIssue(key, fields);
  return { success: true, data: { key, updatedFields: Object.keys(fields) } };
}

async function handleJiraCloseIssue(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  if (!jiraClient.isConfigured()) {
    return { success: false, error: "Jira client not configured" };
  }

  const key = params.key as string;
  if (!key) {
    return { success: false, error: "key is required" };
  }

  const transitions = await jiraClient.getTransitions(key);

  const closeNames = ["done", "closed", "resolved", "complete"];
  const transition = transitions.find((t) =>
    closeNames.some((n) => t.to.name.toLowerCase().includes(n)),
  );

  if (!transition) {
    return {
      success: false,
      error: `No close/complete transition found for ${key}. Available: ${transitions.map((t) => t.to.name).join(", ")}`,
    };
  }

  await jiraClient.transitionIssue(
    key,
    transition.id,
    params.comment as string | undefined,
  );
  return {
    success: true,
    data: { key, transitionedTo: transition.to.name },
  };
}

async function handleJiraSearchIssues(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  if (!jiraClient.isConfigured()) {
    return { success: false, error: "Jira client not configured" };
  }

  const jql = params.jql as string;
  if (!jql) {
    return { success: false, error: "jql query is required" };
  }

  const limit = (params.limit as number) || 20;
  const issues = await jiraClient.searchIssues(jql, limit);
  return {
    success: true,
    data: issues.map((i) => ({
      key: i.key,
      summary: i.fields.summary,
      status: i.fields.status.name,
      assignee: i.fields.assignee?.displayName || "Unassigned",
      priority: i.fields.priority?.name,
      type: i.fields.issuetype.name,
      project: i.fields.project.key,
      created: i.fields.created,
    })),
  };
}

async function handleJiraListTransitions(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  if (!jiraClient.isConfigured()) {
    return { success: false, error: "Jira client not configured" };
  }

  const key = params.key as string;
  if (!key) {
    return { success: false, error: "key is required" };
  }

  const transitions = await jiraClient.getTransitions(key);
  return {
    success: true,
    data: transitions.map((t) => ({ id: t.id, name: t.name, to: t.to.name })),
  };
}

async function handleJiraGetComments(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  if (!jiraClient.isConfigured()) {
    return { success: false, error: "Jira client not configured" };
  }

  const key = params.key as string;
  if (!key) {
    return { success: false, error: "key is required" };
  }

  const comments = await jiraClient.getComments(key);
  return { success: true, data: comments };
}

async function handleJiraGetProject(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  const result = await jiraService.getProject(params.key as string, userId);
  return { success: true, data: result };
}

async function handleJiraListProjects(
  _params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  if (!jiraClient.isConfigured()) {
    return { success: false, error: "Jira client not configured" };
  }
  const projects = await jiraClient.getProjects();
  return { success: true, data: projects };
}

async function handleGitlabListProjects(): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const projects = await gitlabClient.getProjects();
  return {
    success: true,
    data: projects.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path_with_namespace,
      url: p.web_url,
    })),
  };
}

async function handleGitlabGetProject(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const projectIdRaw = (params.projectId as string) || undefined;
  if (!projectIdRaw && !gitlabClient.getDefaultProject()) {
    return {
      success: false,
      error: "projectId is required when GITLAB_DEFAULT_PROJECT is not set",
    };
  }
  const project = await gitlabClient.getProject(
    projectIdRaw || gitlabClient.getDefaultProject(),
  );
  return {
    success: true,
    data: {
      id: project.id,
      name: project.name,
      path: project.path_with_namespace,
      url: project.web_url,
      defaultBranch: project.default_branch,
      topics: project.topics,
    },
  };
}

async function handleGitlabListMergeRequests(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const mrs = await gitlabClient.getMergeRequests(
    (params.projectId as string) || undefined,
    params.state as "opened" | "closed" | "merged" | "all" | undefined,
  );
  return {
    success: true,
    data: mrs.map((mr) => ({
      iid: mr.iid,
      title: mr.title,
      state: mr.state,
      author: mr.author?.username || mr.author?.name,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      createdAt: mr.created_at,
      updatedAt: mr.updated_at,
      url: mr.web_url,
    })),
  };
}

async function handleGitlabGetMergeRequest(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const mrIid = params.mrIid as number;
  if (!mrIid) {
    return { success: false, error: "mrIid is required" };
  }
  const mr = await gitlabClient.getMergeRequest(
    (params.projectId as string) || undefined,
    mrIid,
  );
  return {
    success: true,
    data: {
      iid: mr.iid,
      title: mr.title,
      description: mr.description,
      state: mr.state,
      author: mr.author?.username || mr.author?.name,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      createdAt: mr.created_at,
      updatedAt: mr.updated_at,
      mergedAt: mr.merged_at,
      url: mr.web_url,
    },
  };
}

async function handleGitlabCreateMergeRequest(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const sourceBranch = params.sourceBranch as string;
  const targetBranch = params.targetBranch as string;
  const title = params.title as string;
  if (!sourceBranch || !targetBranch || !title) {
    return {
      success: false,
      error: "sourceBranch, targetBranch, and title are required",
    };
  }
  const mr = await gitlabClient.createMergeRequest(
    (params.projectId as string) || undefined,
    {
      sourceBranch,
      targetBranch,
      title,
      description: params.description as string | undefined,
      labels: params.labels as string | undefined,
      removeSourceBranch: params.removeSourceBranch as boolean | undefined,
      squash: params.squash as boolean | undefined,
    },
  );
  return {
    success: true,
    data: {
      iid: mr.iid,
      title: mr.title,
      state: mr.state,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      url: mr.web_url,
    },
  };
}

async function handleGitlabMergeMergeRequest(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const mrIid = params.mrIid as number;
  if (!mrIid) {
    return { success: false, error: "mrIid is required" };
  }
  const mr = await gitlabClient.acceptMergeRequest(
    (params.projectId as string) || undefined,
    mrIid,
    {
      squashCommitMessage: params.squashCommitMessage as string | undefined,
      shouldRemoveSourceBranch: params.shouldRemoveSourceBranch as
        | boolean
        | undefined,
    },
  );
  return {
    success: true,
    data: {
      iid: mr.iid,
      title: mr.title,
      state: mr.state,
      mergedAt: mr.merged_at,
      url: mr.web_url,
    },
  };
}

async function handleGitlabAddMrComment(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const mrIid = params.mrIid as number;
  const body = params.body as string;
  if (!mrIid || !body) {
    return { success: false, error: "mrIid and body are required" };
  }
  const result = await gitlabClient.addMergeRequestComment(
    (params.projectId as string) || undefined,
    mrIid,
    body,
  );
  return { success: true, data: { id: result.id, body: result.body } };
}

async function handleGitlabListBranches(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const branches = await gitlabClient.getBranches(
    (params.projectId as string) || undefined,
  );
  return {
    success: true,
    data: branches.map((b) => ({
      name: b.name,
      default: b.default,
      merged: b.merged,
      lastCommit: b.commit?.short_id,
    })),
  };
}

async function handleGitlabListCommits(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const commits = await gitlabClient.getCommits(
    (params.projectId as string) || undefined,
    (params.ref as string) || "main",
    params.since as string | undefined,
  );
  return {
    success: true,
    data: commits.slice(0, 20).map((c) => ({
      id: c.short_id || c.id?.substring(0, 8),
      title: c.title,
      author: c.author_name,
      date: c.created_at,
    })),
  };
}

async function handleGitlabGetCommit(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const sha = params.sha as string;
  if (!sha) {
    return { success: false, error: "sha is required" };
  }
  const commit = await gitlabClient.getCommit(
    (params.projectId as string) || undefined,
    sha,
  );
  return { success: true, data: commit };
}

async function handleGitlabListPipelines(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const pipelines = await gitlabClient.listPipelines(
    (params.projectId as string) || undefined,
    params.ref as string | undefined,
  );
  return {
    success: true,
    data: pipelines.map((p) => ({
      id: p.id,
      ref: p.ref,
      status: p.status,
      source: p.source,
      createdAt: p.created_at,
      webUrl: p.web_url,
    })),
  };
}

async function handleGitlabGetFile(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const filePath = params.filePath as string;
  if (!filePath) {
    return { success: false, error: "filePath is required" };
  }
  const file = await gitlabClient.getFile(
    (params.projectId as string) || undefined,
    filePath,
    params.ref as string | undefined,
  );
  // Decode base64 content so the AI can read the file
  if (file && file.content) {
    try {
      file.content = Buffer.from(file.content, "base64").toString("utf-8");
      file.encoding = "decoded";
    } catch {
      // Leave as-is if decoding fails
    }
  }
  return { success: true, data: file };
}

async function handleGitlabListTree(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const tree = await gitlabClient.getRepositoryTree(
    (params.projectId as string) || undefined,
    params.path as string | undefined,
    params.ref as string | undefined,
    params.recursive as boolean | undefined,
  );
  return { success: true, data: tree };
}

async function handleGitlabSearchCode(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const query = params.query as string;
  if (!query) {
    return { success: false, error: "query is required" };
  }
  const results = await gitlabClient.searchCode(
    (params.projectId as string) || undefined,
    query,
    params.ref as string | undefined,
  );
  return { success: true, data: results };
}

async function handleGitlabCreateBranch(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const branchName = params.branchName as string;
  const ref = params.ref as string;
  if (!branchName || !ref) {
    return { success: false, error: "branchName and ref are required" };
  }
  const branch = await gitlabClient.createBranch(
    (params.projectId as string) || undefined,
    branchName,
    ref,
  );
  return {
    success: true,
    data: {
      name: branch.name,
      ref: branch.ref,
      commit: branch.commit?.id,
    },
  };
}

async function handleGitlabGetMrChanges(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const mrIid = params.mrIid as number;
  if (!mrIid) {
    return { success: false, error: "mrIid is required" };
  }
  const changes = await gitlabClient.getMergeRequestChanges(
    (params.projectId as string) || undefined,
    mrIid,
  );
  return { success: true, data: changes };
}

async function handleGitlabListMrComments(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const mrIid = params.mrIid as number;
  if (!mrIid) {
    return { success: false, error: "mrIid is required" };
  }
  const notes = await gitlabClient.listMergeRequestNotes(
    (params.projectId as string) || undefined,
    mrIid,
  );
  return { success: true, data: notes };
}

async function handleGitlabCreateFile(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const filePath = params.filePath as string;
  const content = params.content as string;
  const commitMessage = params.commitMessage as string;
  const branch = params.branch as string;
  if (!filePath || !content || !commitMessage || !branch) {
    return {
      success: false,
      error: "filePath, content, commitMessage, and branch are required",
    };
  }
  const result = await gitlabClient.createFile(
    (params.projectId as string) || undefined,
    filePath,
    content,
    commitMessage,
    branch,
  );
  return { success: true, data: result };
}

async function handleGitlabUpdateFile(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const filePath = params.filePath as string;
  const content = params.content as string;
  const commitMessage = params.commitMessage as string;
  const branch = params.branch as string;
  if (!filePath || !content || !commitMessage || !branch) {
    return {
      success: false,
      error: "filePath, content, commitMessage, and branch are required",
    };
  }
  const result = await gitlabClient.updateFile(
    (params.projectId as string) || undefined,
    filePath,
    content,
    commitMessage,
    branch,
  );
  return { success: true, data: result };
}

async function handleGitlabListIssues(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const issues = await gitlabClient.listIssues(
    (params.projectId as string) || undefined,
    params.state as "opened" | "closed" | "all" | undefined,
    params.labels as string | undefined,
  );
  return { success: true, data: issues };
}

async function handleGitlabGetIssue(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const issueIid = params.issueIid as number;
  if (!issueIid) {
    return { success: false, error: "issueIid is required" };
  }
  const issue = await gitlabClient.getIssue(
    (params.projectId as string) || undefined,
    issueIid,
  );
  return { success: true, data: issue };
}

async function handleGitlabCreateIssue(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const title = params.title as string;
  if (!title) {
    return { success: false, error: "title is required" };
  }
  const issue = await gitlabClient.createIssue(
    (params.projectId as string) || undefined,
    {
      title,
      description: params.description as string | undefined,
      labels: params.labels as string | undefined,
      dueDate: params.dueDate as string | undefined,
    },
  );
  return {
    success: true,
    data: {
      iid: issue.iid,
      title: issue.title,
      state: issue.state,
      url: issue.web_url,
    },
  };
}

async function handleGitlabListMembers(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const members = await gitlabClient.listProjectMembers(
    (params.projectId as string) || undefined,
  );
  return { success: true, data: members };
}

async function handleGitlabListTags(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const tags = await gitlabClient.listTags(
    (params.projectId as string) || undefined,
  );
  return { success: true, data: tags };
}

async function handleGitlabGetPipeline(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const pipelineId = params.pipelineId as number;
  if (!pipelineId) {
    return { success: false, error: "pipelineId is required" };
  }
  const pipeline = await gitlabClient.getPipeline(
    (params.projectId as string) || undefined,
    pipelineId,
  );
  return { success: true, data: pipeline };
}

async function handleGitlabListPipelineJobs(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const pipelineId = params.pipelineId as number;
  if (!pipelineId) {
    return { success: false, error: "pipelineId is required" };
  }
  const jobs = await gitlabClient.listPipelineJobs(
    (params.projectId as string) || undefined,
    pipelineId,
  );
  return { success: true, data: jobs };
}

async function handleGitlabRetryPipeline(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const pipelineId = params.pipelineId as number;
  if (!pipelineId) {
    return { success: false, error: "pipelineId is required" };
  }
  const pipeline = await gitlabClient.retryPipeline(
    (params.projectId as string) || undefined,
    pipelineId,
  );
  return { success: true, data: pipeline };
}

async function handleGitlabCompareRefs(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const from = params.from as string;
  const to = params.to as string;
  if (!from || !to) {
    return { success: false, error: "from and to are required" };
  }
  const comparison = await gitlabClient.compareRefs(
    (params.projectId as string) || undefined,
    from,
    to,
  );
  return { success: true, data: comparison };
}

async function handleGitlabGetFileBlame(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const filePath = params.filePath as string;
  if (!filePath) {
    return { success: false, error: "filePath is required" };
  }
  const blame = await gitlabClient.getFileBlame(
    (params.projectId as string) || undefined,
    filePath,
    params.ref as string | undefined,
  );
  return { success: true, data: blame };
}

// ==================== GitHub Handlers ====================

async function handleGithubListRepos(): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const repos = await githubClient.listRepositories();
  return {
    success: true,
    data: repos.map((r: any) => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      url: r.html_url,
      defaultBranch: r.default_branch,
      private: r.private,
      description: r.description,
    })),
  };
}

async function handleGithubGetRepo(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const repo = await githubClient.getRepository(
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return {
    success: true,
    data: {
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      url: repo.html_url,
      defaultBranch: repo.default_branch,
      private: repo.private,
      description: repo.description,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      language: repo.language,
      topics: repo.topics,
    },
  };
}

async function handleGithubListTree(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const tree = await githubClient.getTree(
    params.path as string | undefined,
    params.ref as string | undefined,
    params.owner as string | undefined,
    params.repo as string | undefined,
    params.recursive as boolean | undefined,
  );
  return { success: true, data: tree };
}

async function handleGithubSearchCode(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const query = params.query as string;
  if (!query) {
    return { success: false, error: "query is required" };
  }
  const results = await githubClient.searchCode(
    query,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: results };
}

async function handleGithubGetFile(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const filePath = params.filePath as string;
  if (!filePath) {
    return { success: false, error: "filePath is required" };
  }
  const file = await githubClient.getFile(
    filePath,
    params.ref as string | undefined,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: file };
}

async function handleGithubCreateFile(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const { filePath, content, commitMessage, branch } = params as Record<
    string,
    string
  >;
  if (!filePath || !content || !commitMessage || !branch) {
    return {
      success: false,
      error: "filePath, content, commitMessage, and branch are required",
    };
  }
  const result = await githubClient.createFile(
    filePath,
    content,
    commitMessage,
    branch,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: result };
}

async function handleGithubUpdateFile(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const { filePath, content, commitMessage, branch, sha } = params as Record<
    string,
    string
  >;
  if (!filePath || !content || !commitMessage || !branch || !sha) {
    return {
      success: false,
      error: "filePath, content, commitMessage, branch, and sha are required",
    };
  }
  const result = await githubClient.updateFile(
    filePath,
    content,
    commitMessage,
    branch,
    sha,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: result };
}

async function handleGithubGetFileBlame(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const filePath = params.filePath as string;
  if (!filePath) {
    return { success: false, error: "filePath is required" };
  }
  const blame = await githubClient.getFileBlame(
    filePath,
    params.ref as string | undefined,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: blame };
}

async function handleGithubListBranches(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const branches = await githubClient.listBranches(
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return {
    success: true,
    data: branches.map((b: any) => ({ name: b.name, protected: b.protected })),
  };
}

async function handleGithubCreateBranch(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const branchName = params.branchName as string;
  const ref = params.ref as string;
  if (!branchName || !ref) {
    return { success: false, error: "branchName and ref are required" };
  }
  const branch = await githubClient.createBranch(
    branchName,
    ref,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: { ref: branch.ref, sha: branch.object?.sha } };
}

async function handleGithubListTags(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const tags = await githubClient.listTags(
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: tags };
}

async function handleGithubListCommits(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const commits = await githubClient.listCommits(
    params.ref as string | undefined,
    params.path as string | undefined,
    undefined,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return {
    success: true,
    data: commits.slice(0, 20).map((c: any) => ({
      sha: c.sha,
      message: c.commit?.message,
      author: c.commit?.author?.name,
      date: c.commit?.author?.date,
    })),
  };
}

async function handleGithubGetCommit(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const ref = params.ref as string;
  if (!ref) {
    return { success: false, error: "ref (commit SHA) is required" };
  }
  const commit = await githubClient.getCommit(
    ref,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: commit };
}

async function handleGithubCompareRefs(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const base = params.base as string;
  const head = params.head as string;
  if (!base || !head) {
    return { success: false, error: "base and head are required" };
  }
  const comparison = await githubClient.compareRefs(
    base,
    head,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: comparison };
}

async function handleGithubListPullRequests(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const prs = await githubClient.listPullRequests(
    params.state as "open" | "closed" | "all" | undefined,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return {
    success: true,
    data: prs.map((p: any) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      user: p.user?.login,
      head: p.head?.ref,
      base: p.base?.ref,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      url: p.html_url,
      draft: p.draft,
    })),
  };
}

async function handleGithubGetPullRequest(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const prNumber = params.prNumber as number;
  if (!prNumber) {
    return { success: false, error: "prNumber is required" };
  }
  const pr = await githubClient.getPullRequest(
    prNumber,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: pr };
}

async function handleGithubCreatePullRequest(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const { title, head, base } = params as Record<string, string>;
  if (!title || !head || !base) {
    return { success: false, error: "title, head, and base are required" };
  }
  const pr = await githubClient.createPullRequest(
    {
      title,
      body: params.body as string | undefined,
      head,
      base,
      draft: params.draft as boolean | undefined,
    },
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return {
    success: true,
    data: {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      url: pr.html_url,
    },
  };
}

async function handleGithubMergePullRequest(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const prNumber = params.prNumber as number;
  if (!prNumber) {
    return { success: false, error: "prNumber is required" };
  }
  const result = await githubClient.mergePullRequest(
    prNumber,
    {
      commitTitle: params.commitTitle as string | undefined,
      mergeMethod: params.mergeMethod as
        | "merge"
        | "squash"
        | "rebase"
        | undefined,
    },
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: result };
}

async function handleGithubListPrComments(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const prNumber = params.prNumber as number;
  if (!prNumber) {
    return { success: false, error: "prNumber is required" };
  }
  const comments = await githubClient.listPullRequestComments(
    prNumber,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: comments };
}

async function handleGithubAddPrComment(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const prNumber = params.prNumber as number;
  const body = params.body as string;
  if (!prNumber || !body) {
    return { success: false, error: "prNumber and body are required" };
  }
  const result = await githubClient.addPullRequestComment(
    prNumber,
    body,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: { id: result.id, url: result.html_url } };
}

async function handleGithubGetPrFiles(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const prNumber = params.prNumber as number;
  if (!prNumber) {
    return { success: false, error: "prNumber is required" };
  }
  const files = await githubClient.getPullRequestFiles(
    prNumber,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: files };
}

async function handleGithubListIssues(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const issues = await githubClient.listIssues(
    params.state as "open" | "closed" | "all" | undefined,
    params.labels as string | undefined,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return {
    success: true,
    data: issues.map((i: any) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      user: i.user?.login,
      labels: i.labels?.map((l: any) => l.name),
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      url: i.html_url,
    })),
  };
}

async function handleGithubGetIssue(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const issueNumber = params.issueNumber as number;
  if (!issueNumber) {
    return { success: false, error: "issueNumber is required" };
  }
  const issue = await githubClient.getIssue(
    issueNumber,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: issue };
}

async function handleGithubCreateIssue(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const title = params.title as string;
  if (!title) {
    return { success: false, error: "title is required" };
  }
  const issue = await githubClient.createIssue(
    {
      title,
      body: params.body as string | undefined,
      labels: params.labels
        ? (params.labels as string).split(",").map((l) => l.trim())
        : undefined,
      assignees: params.assignees
        ? (params.assignees as string).split(",").map((a) => a.trim())
        : undefined,
    },
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return {
    success: true,
    data: {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.html_url,
    },
  };
}

async function handleGithubUpdateIssue(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const issueNumber = params.issueNumber as number;
  if (!issueNumber) {
    return { success: false, error: "issueNumber is required" };
  }
  const issue = await githubClient.updateIssue(
    issueNumber,
    {
      title: params.title as string | undefined,
      body: params.body as string | undefined,
      state: params.state as "open" | "closed" | undefined,
      labels: params.labels
        ? (params.labels as string).split(",").map((l) => l.trim())
        : undefined,
    },
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return {
    success: true,
    data: { number: issue.number, title: issue.title, state: issue.state },
  };
}

async function handleGithubListIssueComments(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const issueNumber = params.issueNumber as number;
  if (!issueNumber) {
    return { success: false, error: "issueNumber is required" };
  }
  const comments = await githubClient.listIssueComments(
    issueNumber,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: comments };
}

async function handleGithubAddIssueComment(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const issueNumber = params.issueNumber as number;
  const body = params.body as string;
  if (!issueNumber || !body) {
    return { success: false, error: "issueNumber and body are required" };
  }
  const result = await githubClient.addIssueComment(
    issueNumber,
    body,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: { id: result.id, url: result.html_url } };
}

async function handleGithubListCollaborators(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const collabs = await githubClient.listCollaborators(
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: collabs };
}

async function handleGithubListWorkflows(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const workflows = await githubClient.listWorkflows(
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: workflows };
}

async function handleGithubListWorkflowRuns(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const runs = await githubClient.listWorkflowRuns(
    params.workflowId as string | undefined,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return {
    success: true,
    data: runs.map((r: any) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      createdAt: r.created_at,
      url: r.html_url,
    })),
  };
}

async function handleGithubGetWorkflowRun(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const runId = params.runId as number;
  if (!runId) {
    return { success: false, error: "runId is required" };
  }
  const run = await githubClient.getWorkflowRun(
    runId,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: run };
}

async function handleGithubListWorkflowRunJobs(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const runId = params.runId as number;
  if (!runId) {
    return { success: false, error: "runId is required" };
  }
  const jobs = await githubClient.listWorkflowRunJobs(
    runId,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: jobs };
}

async function handleGithubRerunWorkflow(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const runId = params.runId as number;
  if (!runId) {
    return { success: false, error: "runId is required" };
  }
  await githubClient.reRunWorkflow(
    runId,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return {
    success: true,
    data: { message: `Workflow run ${runId} re-run requested` },
  };
}

async function handleGithubListReleases(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const releases = await githubClient.listReleases(
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: releases };
}

async function handleGithubCreateRelease(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const tagName = params.tagName as string;
  if (!tagName) {
    return { success: false, error: "tagName is required" };
  }
  const release = await githubClient.createRelease(
    {
      tagName,
      name: params.name as string | undefined,
      body: params.body as string | undefined,
      targetCommitish: params.targetCommitish as string | undefined,
      draft: params.draft as boolean | undefined,
      prerelease: params.prerelease as boolean | undefined,
    },
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return {
    success: true,
    data: { id: release.id, tagName: release.tag_name, url: release.html_url },
  };
}

async function handleDailyPlan(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  const date = params.date ? new Date(params.date as string) : new Date();
  const plan = await dailyPlanner.generatePlan(date, userId);
  return { success: true, data: plan };
}

async function handleDiscoverTools(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  const category = params.category as string | undefined;
  const mode = (params._mode as string) || "productivity";

  if (!category) {
    const categories = getToolCategories(mode);
    const summary: Record<string, string> = {};
    for (const [cat, tools] of Object.entries(categories)) {
      summary[cat] = `${tools.length} tools: ${tools.join(", ")}`;
    }
    return {
      success: true,
      data: {
        message:
          "Specify a category to load those tools. Available categories:",
        categories: summary,
      },
    };
  }

  const tools = getToolsByCategory(mode, category);
  if (tools.length === 0) {
    return {
      success: false,
      error: `Unknown category '${category}'. Use discover_tools without a category to see available options.`,
    };
  }

  return {
    success: true,
    data: {
      message: `Loaded ${tools.length} '${category}' tools. You can now use them.`,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        params: Object.keys(t.params),
      })),
    },
  };
}

type ToolHandler = (
  params: Record<string, unknown>,
  userId: string,
) => Promise<ToolCallResult>;

// ── Roadmap Handlers ──────────────────────────────────────────────

async function handleRoadmapList(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const filters: { type?: "client" | "internal"; status?: string } = {};
    if (params.type) filters.type = params.type as "client" | "internal";
    if (params.status) filters.status = params.status as string;
    const roadmaps = roadmapDatabase.listRoadmaps(filters);
    return { success: true, data: roadmaps };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

async function handleRoadmapGet(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const id = params.id as string;
    if (!id) return { success: false, error: "id is required" };
    const roadmap = roadmapDatabase.getRoadmap(id);
    if (!roadmap) return { success: false, error: `Roadmap ${id} not found` };
    const milestones = roadmapDatabase.getMilestones(id);
    const items = milestones.flatMap((m) => roadmapDatabase.getItems(m.id));
    return { success: true, data: { ...roadmap, milestones, items } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

async function handleRoadmapCreate(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const name = params.name as string;
    const type = (params.type as "client" | "internal") || "internal";

    // Prevent duplicates: return existing roadmap with same name+type
    const existing = roadmapDatabase.listRoadmaps({ type });
    const duplicate = existing.find((r: any) => r.name.toLowerCase() === name.toLowerCase());
    if (duplicate) {
      return { success: true, data: duplicate };
    }

    const roadmap = roadmapDatabase.createRoadmap({
      name,
      type,
      startDate: params.startDate as string,
      endDate: (params.endDate as string) || null,
      status: (params.status as any) || "draft",
      description: (params.description as string) || null,
      jiraProjectKey: (params.jiraProjectKey as string) || null,
      jiraProjectId: null,
      metadata: null,
    });
    return { success: true, data: roadmap };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

async function handleRoadmapUpdate(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const id = params.id as string;
    if (!id) return { success: false, error: "id is required" };
    const updates: Record<string, unknown> = {};
    for (const key of ["name", "status", "startDate", "endDate", "description"]) {
      if (params[key] !== undefined) updates[key] = params[key];
    }
    const roadmap = roadmapDatabase.updateRoadmap(id, updates as any);
    if (!roadmap) return { success: false, error: `Roadmap ${id} not found` };
    return { success: true, data: roadmap };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

async function handleRoadmapAddMilestone(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const roadmapId = params.roadmapId as string;
    if (!roadmapId) return { success: false, error: "roadmapId is required" };
    const roadmap = roadmapDatabase.getRoadmap(roadmapId);
    if (!roadmap) return { success: false, error: `Roadmap ${roadmapId} not found` };
    const milestones = roadmapDatabase.getMilestones(roadmapId);
    const milestone = roadmapDatabase.createMilestone({
      roadmapId,
      name: params.name as string,
      targetDate: params.targetDate as string,
      description: (params.description as string) || null,
      status: "pending",
      order: milestones.length,
      jiraEpicKey: (params.jiraEpicKey as string) || null,
    });
    return { success: true, data: milestone };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

async function handleRoadmapAddItem(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const milestoneId = params.milestoneId as string;
    if (!milestoneId) return { success: false, error: "milestoneId is required" };
    const items = roadmapDatabase.getItems(milestoneId);
    const item = roadmapDatabase.createItem({
      milestoneId,
      title: params.title as string,
      type: (params.type as any) || "task",
      status: "todo",
      priority: (params.priority as any) || "medium",
      estimatedHours: null,
      actualHours: null,
      assignee: null,
      jiraKey: (params.jiraKey as string) || null,
      description: (params.description as string) || null,
      order: items.length,
    });
    return { success: true, data: item };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  "calendar.list_events": handleCalendarListEvents,
  "calendar.create_focus_block": handleCalendarCreateFocusBlock,
  "calendar.create_health_block": handleCalendarCreateHealthBlock,
  "jira.list_assigned": handleJiraListAssigned,
  "jira.get_issue": handleJiraGetIssue,
  "jira.add_comment": handleJiraAddComment,
  "jira.transition_issue": handleJiraTransitionIssue,
  "jira.create_project": handleJiraCreateProject,
  "jira.create_issue": handleJiraCreateIssue,
  "jira.create_issues": handleJiraCreateIssues,
  "jira.update_issue": handleJiraUpdateIssue,
  "jira.close_issue": handleJiraCloseIssue,
  "jira.search_issues": handleJiraSearchIssues,
  "jira.list_transitions": handleJiraListTransitions,
  "jira.get_comments": handleJiraGetComments,
  "jira.get_project": handleJiraGetProject,
  "jira.list_projects": handleJiraListProjects,
  "gitlab.list_projects": handleGitlabListProjects,
  "gitlab.get_project": handleGitlabGetProject,
  "gitlab.list_merge_requests": handleGitlabListMergeRequests,
  "gitlab.get_merge_request": handleGitlabGetMergeRequest,
  "gitlab.create_merge_request": handleGitlabCreateMergeRequest,
  "gitlab.merge_merge_request": handleGitlabMergeMergeRequest,
  "gitlab.add_mr_comment": handleGitlabAddMrComment,
  "gitlab.list_branches": handleGitlabListBranches,
  "gitlab.list_commits": handleGitlabListCommits,
  "gitlab.get_commit": handleGitlabGetCommit,
  "gitlab.list_pipelines": handleGitlabListPipelines,
  "gitlab.get_file": handleGitlabGetFile,
  "gitlab.list_tree": handleGitlabListTree,
  "gitlab.search_code": handleGitlabSearchCode,
  "gitlab.create_branch": handleGitlabCreateBranch,
  "gitlab.get_mr_changes": handleGitlabGetMrChanges,
  "gitlab.list_mr_comments": handleGitlabListMrComments,
  "gitlab.create_file": handleGitlabCreateFile,
  "gitlab.update_file": handleGitlabUpdateFile,
  "gitlab.list_issues": handleGitlabListIssues,
  "gitlab.get_issue": handleGitlabGetIssue,
  "gitlab.create_issue": handleGitlabCreateIssue,
  "gitlab.list_members": handleGitlabListMembers,
  "gitlab.list_tags": handleGitlabListTags,
  "gitlab.get_pipeline": handleGitlabGetPipeline,
  "gitlab.list_pipeline_jobs": handleGitlabListPipelineJobs,
  "gitlab.retry_pipeline": handleGitlabRetryPipeline,
  "gitlab.compare_refs": handleGitlabCompareRefs,
  "gitlab.get_file_blame": handleGitlabGetFileBlame,
  "github.list_repos": handleGithubListRepos,
  "github.get_repo": handleGithubGetRepo,
  "github.list_tree": handleGithubListTree,
  "github.search_code": handleGithubSearchCode,
  "github.get_file": handleGithubGetFile,
  "github.create_file": handleGithubCreateFile,
  "github.update_file": handleGithubUpdateFile,
  "github.get_file_blame": handleGithubGetFileBlame,
  "github.list_branches": handleGithubListBranches,
  "github.create_branch": handleGithubCreateBranch,
  "github.list_tags": handleGithubListTags,
  "github.list_commits": handleGithubListCommits,
  "github.get_commit": handleGithubGetCommit,
  "github.compare_refs": handleGithubCompareRefs,
  "github.list_pull_requests": handleGithubListPullRequests,
  "github.get_pull_request": handleGithubGetPullRequest,
  "github.create_pull_request": handleGithubCreatePullRequest,
  "github.merge_pull_request": handleGithubMergePullRequest,
  "github.list_pr_comments": handleGithubListPrComments,
  "github.add_pr_comment": handleGithubAddPrComment,
  "github.get_pr_files": handleGithubGetPrFiles,
  "github.list_issues": handleGithubListIssues,
  "github.get_issue": handleGithubGetIssue,
  "github.create_issue": handleGithubCreateIssue,
  "github.update_issue": handleGithubUpdateIssue,
  "github.list_issue_comments": handleGithubListIssueComments,
  "github.add_issue_comment": handleGithubAddIssueComment,
  "github.list_collaborators": handleGithubListCollaborators,
  "github.list_workflows": handleGithubListWorkflows,
  "github.list_workflow_runs": handleGithubListWorkflowRuns,
  "github.get_workflow_run": handleGithubGetWorkflowRun,
  "github.list_workflow_run_jobs": handleGithubListWorkflowRunJobs,
  "github.rerun_workflow": handleGithubRerunWorkflow,
  "github.list_releases": handleGithubListReleases,
  "github.create_release": handleGithubCreateRelease,
  "productivity.generate_daily_plan": handleDailyPlan,

  // ── Roadmap Handlers ────────────────────────────────────────
  "roadmap.list": handleRoadmapList,
  "roadmap.get": handleRoadmapGet,
  "roadmap.create": handleRoadmapCreate,
  "roadmap.update": handleRoadmapUpdate,
  "roadmap.add_milestone": handleRoadmapAddMilestone,
  "roadmap.add_item": handleRoadmapAddItem,

  discover_tools: handleDiscoverTools,
};

export async function dispatchToolCall(
  toolName: string,
  params: Record<string, unknown>,
  userId: string = "user",
): Promise<ToolCallResult> {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  try {
    const result = await handler(params, userId);
    await auditLogger.log({
      id: "",
      timestamp: new Date(),
      action: `tool.${toolName}`,
      actor: userId,
      details: { params, result: result.success ? "success" : "failed" },
      severity: result.success ? "info" : "warn",
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await auditLogger.log({
      id: "",
      timestamp: new Date(),
      action: `tool.${toolName}`,
      actor: userId,
      details: { params, error: message },
      severity: "error",
    });
    return { success: false, error: message };
  }
}

export function getAvailableTools(): string[] {
  return Object.keys(TOOL_HANDLERS);
}
