import { codexClient } from "../integrations/codex/codex-client";
import { webSearchClient } from "../integrations/web/search-client";
import { fileCalendarService } from "../integrations/file/calendar-service";
import { jiraService } from "../integrations/jira/jira-service";
import { jiraClient } from "../integrations/jira/jira-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { githubClient } from "../integrations/github/github-client";
import { jitbitService } from "../integrations/jitbit/jitbit-service";
import { dailyPlanner } from "../productivity/daily-planner";
import { weeklyPlanner } from "../productivity/weekly-planner";
import { ctoDailyCommandCenter } from "../cto/daily-command-center";
import { personalOsBriefGenerator } from "../personal-os/brief-generator";
import { productChiefOfStaff } from "../product/product-chief-of-staff";
import { hawkIrService } from "../integrations/hawk-ir/hawk-ir-service";
import { roadmapDatabase } from "../roadmap/database";
import { auditLogger } from "../audit/logger";
import { env } from "../config/env";
import {
  getToolCategories,
  getToolsByCategory,
  getToolByName,
} from "./tool-registry";
import { detectPlatformIntent } from "../policy/platform-intent";
import { validatePlatformAlignment } from "../policy/platform-alignment";
import { workflowBriefGenerator } from "../engineering/workflow-brief";
import { architecturePlanner } from "../engineering/architecture-planner";
import { scaffoldPlanner } from "../engineering/scaffold-planner";
import { jiraTicketGenerator } from "../engineering/jira-ticket-generator";
import { policyEngine } from "../policy/engine";
import { approvalQueue } from "../approvals/queue";
import * as fs from "fs";
import * as path from "path";
import { todoManager } from "./todo-manager";
import { knowledgeStore } from "./knowledge-store";
import { aiClient } from "./opencode-client";
import { workItemDatabase } from "../work-items/database";
import { workflowExecutor } from "./workflow-executor";
import { mcpClient } from "../integrations/mcp";
import { codebaseIndexer } from "./codebase-indexer";
import { knowledgeGraph } from "./knowledge-graph";
import { entityMemory } from "../memory/entity-memory";
import type { EntityType, FindEntitiesQuery } from "../memory/entity-types";
import { lspManager } from "../integrations/lsp/index.js";
import type { DiagnosticItem } from "../integrations/lsp/lsp-client.js";

export interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
  requiresApproval?: boolean;
  approvalId?: string;
}

const recentDiagnostics = new Map<string, DiagnosticItem[]>();
const MAX_DIAGNOSTIC_FILES = 50;

lspManager.on("diagnostics", ({ filePath, diagnostics }: { filePath: string; diagnostics: DiagnosticItem[] }) => {
  const errors = diagnostics.filter((d: DiagnosticItem) => d.severity === "error");
  if (errors.length > 0) {
    recentDiagnostics.set(filePath, errors);
    if (recentDiagnostics.size > MAX_DIAGNOSTIC_FILES) {
      const oldestKey = recentDiagnostics.keys().next().value;
      if (oldestKey !== undefined) recentDiagnostics.delete(oldestKey);
    }
  } else {
    recentDiagnostics.delete(filePath);
  }
});

export function getRecentDiagnosticAlerts(): { filePath: string; errorCount: number }[] {
  const alerts: { filePath: string; errorCount: number }[] = [];
  for (const [filePath, errors] of recentDiagnostics) {
    alerts.push({ filePath, errorCount: errors.length });
  }
  return alerts;
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

  const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
  if (!JIRA_KEY_PATTERN.test(project)) {
    return {
      success: false,
      error: `Invalid Jira project key "${project}". Jira keys are 2-10 uppercase letters (e.g., "SIEM", "IR", "MDR"). Use jira.list_projects to see valid keys.`,
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
      return {
        success: false,
        error: "issues parameter must be a valid JSON array",
      };
    }
  }

  if (!Array.isArray(issues) || issues.length === 0) {
    return {
      success: false,
      error: "issues must be a non-empty array of issue objects",
    };
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
      const firstLine = file.content.split("\n")[0]?.toLowerCase() ?? "";
      if (
        firstLine.includes("archived") ||
        firstLine.includes("deprecated") ||
        firstLine.includes("outdated")
      ) {
        return {
          success: false,
          error: `File appears to be archived/deprecated: ${filePath}. First line: "${firstLine.trim()}". Skipping.`,
        };
      }
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
  if (file && file.content) {
    let decoded: string | undefined;
    try {
      decoded = Buffer.from(file.content, "base64").toString("utf-8");
    } catch {
      // Leave as-is if decoding fails
    }
    if (decoded) {
      const firstLine = decoded.split("\n")[0]?.toLowerCase() ?? "";
      if (
        firstLine.includes("archived") ||
        firstLine.includes("deprecated") ||
        firstLine.includes("outdated")
      ) {
        return {
          success: false,
          error: `File appears to be archived/deprecated: ${filePath}. First line: "${firstLine.trim()}". Skipping.`,
        };
      }
    }
  }
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

async function handleWeeklyPlan(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  const startDateParam = params.startDate as string | undefined;
  const weeks = (params.weeks as number) || 1;
  const validatedWeeks: 1 | 2 = weeks === 2 ? 2 : 1;

  let startDate: Date;
  if (startDateParam) {
    startDate = new Date(startDateParam);
  } else {
    startDate = new Date();
    const day = startDate.getDay();
    const daysUntilMonday = day === 0 ? 1 : day === 1 ? 0 : 8 - day;
    startDate.setDate(startDate.getDate() + daysUntilMonday);
  }
  startDate.setHours(0, 0, 0, 0);

  const plan = await weeklyPlanner.generateWeeklyPlan(startDate, validatedWeeks, userId);
  return { success: true, data: plan };
}

async function handleMemoryFindEntities(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const query: FindEntitiesQuery = {
      query: params.query as string | undefined,
      type: params.type as EntityType | undefined,
      source: params.source as string | undefined,
      minConfidence: params.minConfidence as number | undefined,
      limit: Math.min(Number(params.limit ?? 10), 50),
    };
    const entities = query.query || query.type || query.source || query.minConfidence !== undefined
      ? entityMemory.findEntities(query)
      : entityMemory.listRecentEntities(query.limit);
    return {
      success: true,
      data: { entities, total: entities.length },
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function handleMemoryGetEntityContext(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const type = params.type as EntityType;
    const name = params.name as string;
    if (!type || !name) {
      return { success: false, error: "type and name are required" };
    }
    const context = entityMemory.getEntityContext(type, name);
    if (!context) {
      return {
        success: true,
        data: { found: false, message: `No entity of type '${type}' named '${name}' found in memory.` },
      };
    }
    return { success: true, data: { found: true, ...context } };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function handleMemoryAddEntityFact(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const type = params.type as EntityType;
    const name = params.name as string;
    const fact = params.fact as string;
    if (!type || !name || !fact) {
      return { success: false, error: "type, name, and fact are required" };
    }
    const entity = entityMemory.upsertEntity({ type, name, source: (params.source as string) ?? "conversation" });
    const stored = entityMemory.addFact(entity.id, fact, {
      source: (params.source as string) ?? "conversation",
      confidence: 0.9,
    });
    return { success: true, data: { entity, fact: stored } };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function handleCtoDailyCommandCenter(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  const brief = await ctoDailyCommandCenter.generateDailyCommandCenter({
    userId,
    date: params.date as string | undefined,
    includeCalendar: params.includeCalendar as boolean | undefined,
    includeJira: params.includeJira as boolean | undefined,
    includeGitLab: params.includeGitLab as boolean | undefined,
    includeGitHub: params.includeGitHub as boolean | undefined,
    includeRoadmap: params.includeRoadmap as boolean | undefined,
    includeWorkItems: params.includeWorkItems as boolean | undefined,
    includeJitbit: params.includeJitbit as boolean | undefined,
    daysBack: params.daysBack as number | undefined,
  });
  return { success: true, data: brief };
}

async function handlePersonalOsBrief(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  const brief = await personalOsBriefGenerator.generatePersonalBrief({
    userId,
    date: params.date as string | undefined,
    daysBack: params.daysBack as number | undefined,
    includeCalendar: params.includeCalendar as boolean | undefined,
    includeJira: params.includeJira as boolean | undefined,
    includeGitLab: params.includeGitLab as boolean | undefined,
    includeGitHub: params.includeGitHub as boolean | undefined,
    includeWorkItems: params.includeWorkItems as boolean | undefined,
    includeJitbit: params.includeJitbit as boolean | undefined,
    includeRoadmap: params.includeRoadmap as boolean | undefined,
    includeMemory: params.includeMemory as boolean | undefined,
  });
  return { success: true, data: brief };
}

async function handlePersonalOsOpenLoops(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  const brief = await personalOsBriefGenerator.generatePersonalBrief({
    userId: (params.userId as string) || userId,
    includeMemory: false,
  });
  return {
    success: true,
    data: {
      openLoops: brief.openLoops,
      decisionsWaiting: brief.decisionsWaiting,
    },
  };
}

async function handlePersonalOsDetectPatterns(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  const brief = await personalOsBriefGenerator.generatePersonalBrief({
    userId,
    daysBack: params.daysBack as number | undefined,
    includeMemory: false,
  });
  return {
    success: true,
    data: { recurringPatterns: brief.recurringPatterns },
  };
}

async function handlePersonalOsSuggestFocus(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  const brief = await personalOsBriefGenerator.generatePersonalBrief({
    userId,
    date: params.date as string | undefined,
    includeMemory: false,
  });
  return {
    success: true,
    data: { suggestedFocusBlocks: brief.suggestedFocusBlocks },
  };
}

async function handlePersonalOsCreateWorkItems(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  let items = params.items;
  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch {
      return { success: false, error: "items must be a valid JSON array" };
    }
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { success: false, error: "items must be a non-empty array" };
  }
  const created = personalOsBriefGenerator.createSuggestedWorkItems(items as any[]);
  return { success: true, data: { created } };
}

// ── Product Chief of Staff Handlers ──────────────────────────────────

async function handleProductWorkflowBrief(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  const idea = params.idea as string;
  if (!idea) {
    return { success: false, error: "idea is required" };
  }
  const brief = await productChiefOfStaff.turnIdeaIntoWorkflowBrief({
    idea,
    context: params.context as string | undefined,
  });
  return { success: true, data: { brief } };
}

async function handleProductRoadmapProposal(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  const theme = params.theme as string;
  if (!theme) {
    return { success: false, error: "theme is required" };
  }
  const proposal = await productChiefOfStaff.buildRoadmapProposal({
    theme,
    customerEvidence: params.customerEvidence as string | undefined,
    engineeringConstraints: params.engineeringConstraints as string | undefined,
    timeHorizon: params.timeHorizon as string | undefined,
  });
  return { success: true, data: { proposal } };
}

async function handleProductRoadmapDrift(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  const drift = await productChiefOfStaff.analyzeRoadmapDrift({
    roadmapId: params.roadmapId as string | undefined,
  });
  return { success: true, data: { drift } };
}

async function handleProductCustomerSignals(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  const signals = await productChiefOfStaff.extractCustomerSignalsFromJitbit({
    daysBack: params.daysBack as number | undefined,
    limit: params.limit as number | undefined,
  });
  return { success: true, data: { signals } };
}

async function handleProductWeeklyUpdate(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  const update = await productChiefOfStaff.generateWeeklyProductUpdate({
    weekStart: params.weekStart as string | undefined,
    daysBack: params.daysBack as number | undefined,
  });
  return { success: true, data: { update } };
}

async function handleProductCreateWorkItems(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  let items = params.items;
  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch {
      return { success: false, error: "items must be a valid JSON array" };
    }
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { success: false, error: "items must be a non-empty array" };
  }
  const created = productChiefOfStaff.createRoadmapWorkItems({
    items: items as any[],
    source: params.source as string | undefined,
  });
  return { success: true, data: { created } };
}

async function handleDiscoverTools(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  const category = params.category as string | undefined;
  const mode = (params._mode as string) || "productivity";
  const loadedNames = new Set(
    (params._loadedTools as string[] | undefined) || [],
  );

  if (!category) {
    const categories = getToolCategories(mode);
    const summary: Record<string, string> = {};
    for (const [cat, tools] of Object.entries(categories)) {
      const newCount = tools.filter((n) => !loadedNames.has(n)).length;
      const label =
        newCount < tools.length
          ? `${newCount} new / ${tools.length} total`
          : `${tools.length} tools`;
      summary[cat] = `${label}: ${tools.join(", ")}`;
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

  const newTools = tools.filter((t) => !loadedNames.has(t.name));
  const alreadyLoaded = tools.length - newTools.length;

  const message =
    alreadyLoaded > 0
      ? `Loaded ${newTools.length} new '${category}' tools (${alreadyLoaded} already loaded). You can now use them.`
      : `Loaded ${tools.length} '${category}' tools. You can now use them.`;

  return {
    success: true,
    data: {
      message,
      tools: newTools.map((t) => ({
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
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
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
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
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
    const duplicate = existing.find(
      (r: any) => r.name.toLowerCase() === name.toLowerCase(),
    );
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
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleRoadmapUpdate(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const id = params.id as string;
    if (!id) return { success: false, error: "id is required" };
    const updates: Record<string, unknown> = {};
    for (const key of [
      "name",
      "status",
      "startDate",
      "endDate",
      "description",
    ]) {
      if (params[key] !== undefined) updates[key] = params[key];
    }
    const roadmap = roadmapDatabase.updateRoadmap(id, updates as any);
    if (!roadmap) return { success: false, error: `Roadmap ${id} not found` };
    return { success: true, data: roadmap };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleRoadmapAddMilestone(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const roadmapId = params.roadmapId as string;
    if (!roadmapId) return { success: false, error: "roadmapId is required" };
    const roadmap = roadmapDatabase.getRoadmap(roadmapId);
    if (!roadmap)
      return { success: false, error: `Roadmap ${roadmapId} not found` };
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
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleRoadmapAddItem(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const milestoneId = params.milestoneId as string;
    if (!milestoneId)
      return { success: false, error: "milestoneId is required" };
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
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleRoadmapUpdateMilestone(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const id = params.id as string;
    if (!id) return { success: false, error: "id is required" };
    const updates: Record<string, unknown> = {};
    for (const key of ["name", "targetDate", "status", "description"]) {
      if (params[key] !== undefined) updates[key] = params[key];
    }
    const milestone = roadmapDatabase.updateMilestone(id, updates as any);
    if (!milestone)
      return { success: false, error: `Milestone ${id} not found` };
    return { success: true, data: milestone };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleRoadmapUpdateItem(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const id = params.id as string;
    if (!id) return { success: false, error: "id is required" };
    const updates: Record<string, unknown> = {};
    for (const key of [
      "title",
      "status",
      "priority",
      "type",
      "description",
      "jiraKey",
    ]) {
      if (params[key] !== undefined) updates[key] = params[key];
    }
    const item = roadmapDatabase.updateItem(id, updates as any);
    if (!item) return { success: false, error: `Item ${id} not found` };
    return { success: true, data: item };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleRoadmapDelete(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const id = params.id as string;
    if (!id) return { success: false, error: "id is required" };
    const deleted = roadmapDatabase.deleteRoadmap(id);
    if (!deleted) return { success: false, error: `Roadmap ${id} not found` };
    return { success: true, data: { id, deleted: true } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleRoadmapDeleteMilestone(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const id = params.id as string;
    if (!id) return { success: false, error: "id is required" };
    const deleted = roadmapDatabase.deleteMilestone(id);
    if (!deleted) return { success: false, error: `Milestone ${id} not found` };
    return { success: true, data: { id, deleted: true } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleApproveAction(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  const approvalId = params.approvalId as string;
  if (!approvalId) return { success: false, error: "approvalId is required" };

  try {
    const result = await approvalQueue.approve(approvalId, userId);
    if (result.success) {
      return {
        success: true,
        data: {
          approvalId,
          status: result.approval.status,
          executionResult: result.approval.executionResult,
        },
      };
    }
    return { success: false, error: result.message };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleRejectAction(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  const approvalId = params.approvalId as string;
  if (!approvalId) return { success: false, error: "approvalId is required" };

  try {
    const result = await approvalQueue.reject(approvalId, userId);
    if (result.success) {
      return { success: true, data: { approvalId, status: "rejected" } };
    }
    return { success: false, error: result.message };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleListApprovals(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const status = params.status as string | undefined;
    const result = await approvalQueue.list({
      status: status as any,
      limit: 10,
    });
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleSystemCheckHealth(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const includeDetails = params.includeDetails === true;

  try {
    const providerConfigured = aiClient.isConfigured();
    const providerValid = providerConfigured
      ? await aiClient.validateConfig().catch(() => false)
      : false;

    const [githubConfigured, gitlabConfigured, jiraConfigured] =
      await Promise.all([
        githubClient.isConfigured(),
        gitlabClient.isConfigured(),
        jiraClient.isConfigured(),
      ]);

    const [githubValid, gitlabValid, jiraValid] = await Promise.all([
      githubConfigured
        ? githubClient.validateConfig().catch(() => false)
        : false,
      gitlabConfigured
        ? gitlabClient.validateConfig().catch(() => false)
        : false,
      jiraConfigured
        ? jiraClient.validateConfig().catch(() => false)
        : false,
    ]);

    const result: Record<string, unknown> = {
      provider: {
        active: env.AI_PROVIDER,
        configured: providerConfigured,
        valid: providerValid,
      },
      integrations: {
        github: { configured: githubConfigured, valid: githubValid },
        gitlab: { configured: gitlabConfigured, valid: gitlabValid },
        jira: { configured: jiraConfigured, valid: jiraValid },
      },
    };

    if (includeDetails) {
      const providerKeyMap: Record<string, { key: string; url: string }> = {
        opencode: {
          key: env.OPENCODE_API_KEY,
          url: env.OPENCODE_API_URL,
        },
        zai: { key: env.ZAI_API_KEY, url: env.ZAI_API_URL },
        ollama: {
          key: env.OLLAMA_API_KEY || "local",
          url: env.OLLAMA_API_URL,
        },
      };
      const info = providerKeyMap[env.AI_PROVIDER] || providerKeyMap.opencode;
      const providerObj = result.provider as Record<string, unknown>;
      result.provider = {
        ...providerObj,
        baseUrl: info.url,
        hasApiKey: !!info.key,
      };
    }

    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: `Health check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function handleRoadmapDeleteItem(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const id = params.id as string;
    if (!id) return { success: false, error: "id is required" };
    const deleted = roadmapDatabase.deleteItem(id);
    if (!deleted) return { success: false, error: `Item ${id} not found` };
    return { success: true, data: { id, deleted: true } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleEngineeringWorkflowBrief(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const idea = params.idea as string;
    if (!idea) return { success: false, error: "idea is required" };
    const brief = await workflowBriefGenerator.generate(idea);
    return { success: true, data: brief };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleEngineeringArchitectureProposal(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const idea = params.idea as string;
    if (!idea) return { success: false, error: "idea is required" };
    const brief = await workflowBriefGenerator.generate(idea);
    const proposal = await architecturePlanner.generate(brief);
    return { success: true, data: proposal };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleEngineeringScaffoldingPlan(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const idea = params.idea as string;
    if (!idea) return { success: false, error: "idea is required" };
    const brief = await workflowBriefGenerator.generate(idea);
    const proposal = await architecturePlanner.generate(brief);
    const scaffold = await scaffoldPlanner.generate(proposal);
    return { success: true, data: scaffold };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleEngineeringJiraTickets(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  try {
    const idea = params.idea as string;
    const projectKey = params.projectKey as string;
    if (!idea) return { success: false, error: "idea is required" };
    if (!projectKey) return { success: false, error: "projectKey is required" };

    const brief = await workflowBriefGenerator.generate(idea);
    const proposal = await architecturePlanner.generate(brief);

    const plan = {
      milestones: proposal.systemBoundaries,
      firstVerticalSlice: proposal.systemBoundaries[0] || "MVP",
      tickets: [
        {
          summary: `Implement ${proposal.systemBoundaries[0] || "core service"}`,
          description: `Build the ${proposal.systemBoundaries[0] || "core"} service as part of ${idea}`,
          issueType: "Story",
          acceptanceCriteria: [
            "Service is functional",
            "Tests pass",
            "Documentation updated",
          ],
          estimationPoints: 5,
        },
      ],
    };

    const results = await jiraTicketGenerator.createTickets(
      plan,
      projectKey,
      userId,
    );
    return { success: true, data: { brief, proposal, tickets: results } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleCodexRun(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const prompt = params.prompt as string;
  if (!prompt) return { success: false, error: "prompt is required" };

  if (!codexClient.isConfigured()) {
    return {
      success: false,
      error:
        "Codex CLI not configured. Set OPENAI_API_KEY, CODEX_API_KEY, or ensure OLLAMA_API_URL is available.",
    };
  }

  // Default to Ollama model when routing through Ollama (no API key set)
  const model =
    (params.model as string | undefined) ||
    (process.env.OLLAMA_API_URL && !process.env.OPENAI_API_KEY && !process.env.CODEX_API_KEY
      ? process.env.OLLAMA_MODEL || "glm-5.1:cloud"
      : undefined);

  const result = await codexClient.runPrompt(prompt, {
    cwd: params.cwd as string | undefined,
    model,
    approvalMode: params.approvalMode as
      | "suggest"
      | "auto-edit"
      | "full-auto"
      | undefined,
  });

  return {
    success: result.success,
    data: {
      exitCode: result.exitCode,
      output: result.stdout,
      errors: result.stderr || undefined,
      durationMs: result.duration,
    },
  };
}

async function handleWebSearch(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const query = params.query as string;
  if (!query) return { success: false, error: "query is required" };

  if (!webSearchClient.isConfigured()) {
    return {
      success: false,
      error:
        "Web search not configured. Set TAVILY_API_KEY (recommended) or GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_ENGINE_ID environment variables.",
    };
  }

  const maxResults = (params.maxResults as number) || 5;
  const results = await webSearchClient.search(query, maxResults, {
    searchDepth: params.searchDepth as "basic" | "advanced" | undefined,
    topic: params.topic as "general" | "news" | "finance" | undefined,
    includeAnswer: true,
  });

  if (results.results.length > 0) {
    try {
      knowledgeStore.store({
        source: "web_search",
        title: `Search: ${query}`,
        content: results.results
          .map((r) => `${r.title}: ${r.snippet}`)
          .join("\n"),
        tags: [query.split(" ").slice(0, 3).join(" "), "web-search"],
        createdAt: new Date(),
      });
    } catch {}
  }

  return { success: true, data: results };
}

async function handleWebFetchPage(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const url = params.url as string;
  if (!url) return { success: false, error: "url is required" };

  try {
    new URL(url);
  } catch {
    return { success: false, error: "Invalid URL" };
  }

  const result = await webSearchClient.fetchPage(url);

  if (result.content && result.content.length > 50) {
    try {
      knowledgeStore.store({
        source: "web_page",
        title: `Page: ${url}`,
        content: result.content.substring(0, 2000),
        url,
        tags: ["web-page", new URL(url).hostname],
        createdAt: new Date(),
      });
    } catch {}
  }

  return { success: true, data: result };
}

const PROJECT_ROOT = process.cwd();

async function handleLocalReadFile(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const filePath = params.path as string;
  if (!filePath) return { success: false, error: "path is required" };

  const resolved = path.resolve(PROJECT_ROOT, filePath);

  if (!resolved.startsWith(PROJECT_ROOT)) {
    return {
      success: false,
      error: "Access denied: path outside project root",
    };
  }

  if (!fs.existsSync(resolved)) {
    return { success: false, error: `File not found: ${filePath}` };
  }

  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return {
        success: false,
        error: `Path is a directory, not a file: ${filePath}`,
      };
    }

    if (stat.size > 1024 * 1024) {
      return {
        success: false,
        error: `File too large (${Math.round(stat.size / 1024)}KB). Use offset/limit to read portions.`,
      };
    }

    const content = fs.readFileSync(resolved, "utf-8");
    const firstLine = content.split("\n")[0]?.toLowerCase() ?? "";
    if (
      firstLine.includes("archived") ||
      firstLine.includes("deprecated") ||
      firstLine.includes("outdated")
    ) {
      return {
        success: false,
        error: `File appears to be archived/deprecated: ${filePath}. First line: "${firstLine.trim()}". Skipping.`,
      };
    }
    const lines = content.split("\n");
    const offset = (params.offset as number) || 1;
    const limit = (params.limit as number) || 500;
    const start = Math.max(0, offset - 1);
    const end = Math.min(lines.length, start + limit);
    const selected = lines.slice(start, end);

    return {
      success: true,
      data: {
        path: filePath,
        totalLines: lines.length,
        showingLines: `${start + 1}-${end}`,
        content: selected.map((l, i) => `${start + i + 1}: ${l}`).join("\n"),
      },
    };

    try {
      knowledgeStore.store({
        source: "file_read",
        title: `File: ${filePath}`,
        content: content.substring(0, 2000),
        filePath,
        tags: ["local-file", path.extname(filePath).replace(".", "") || "txt"],
        createdAt: new Date(),
      });
    } catch {}
  } catch (error) {
    return {
      success: false,
      error: `Failed to read file: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

async function handleLocalListTree(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const dirPath = (params.path as string) || ".";
  const maxDepth = (params.maxDepth as number) || 3;
  const resolved = path.resolve(PROJECT_ROOT, dirPath);

  if (!resolved.startsWith(PROJECT_ROOT)) {
    return {
      success: false,
      error: "Access denied: path outside project root",
    };
  }

  if (!fs.existsSync(resolved)) {
    return { success: false, error: `Directory not found: ${dirPath}` };
  }

  const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    ".next",
    "coverage",
    ".turbo",
    "__pycache__",
    ".venv",
    "target",
    "build",
  ]);

  function walkTree(dir: string, depth: number, prefix: string): string[] {
    if (depth > maxDepth) return [];
    const entries: string[] = [];

    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const sorted = items.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const item of sorted) {
      if (SKIP_DIRS.has(item.name)) continue;
      if (item.name.startsWith(".") && item.name !== ".env.example") continue;

      const fullPath = path.join(dir, item.name);
      const suffix = item.isDirectory() ? "/" : "";

      entries.push(`${prefix}${item.name}${suffix}`);

      if (item.isDirectory()) {
        entries.push(...walkTree(fullPath, depth + 1, prefix + "  "));
      }
    }
    return entries;
  }

  const tree = walkTree(resolved, 0, "");
  return {
    success: true,
    data: {
      path: dirPath,
      maxDepth,
      entries: tree,
      count: tree.length,
    },
  };
}

async function handleLocalSearchCode(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const pattern = params.pattern as string;
  if (!pattern) return { success: false, error: "pattern is required" };

  const searchDir = path.resolve(PROJECT_ROOT, (params.path as string) || ".");
  if (!searchDir.startsWith(PROJECT_ROOT)) {
    return {
      success: false,
      error: "Access denied: path outside project root",
    };
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    return { success: false, error: `Invalid regex pattern: ${pattern}` };
  }

  const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    ".next",
    "coverage",
    ".turbo",
    "__pycache__",
    ".venv",
    "target",
    "build",
    "data",
  ]);

  const include = params.include as string | undefined;
  let includePatterns: string[] | undefined;
  if (include) {
    includePatterns = include.split(",").map((p) => p.trim());
  }

  function shouldInclude(filePath: string): boolean {
    if (!includePatterns) return true;
    return includePatterns.some((p) => {
      if (p.startsWith("*.")) {
        return filePath.endsWith(p.substring(1));
      }
      return filePath.includes(p);
    });
  }

  const results: Array<{
    file: string;
    line: number;
    content: string;
  }> = [];

  function searchDirRecursive(dir: string) {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (SKIP_DIRS.has(item.name)) continue;
      if (item.name.startsWith(".")) continue;

      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        searchDirRecursive(fullPath);
      } else if (item.isFile() && shouldInclude(item.name)) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > 1024 * 512) continue;

          const content = fs.readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push({
                file: path.relative(PROJECT_ROOT, fullPath).replace(/\\/g, "/"),
                line: i + 1,
                content: lines[i].trim().substring(0, 200),
              });
              if (results.length >= 50) return;
            }
          }
        } catch {}
      }
    }
  }

  searchDirRecursive(searchDir);

  return {
    success: true,
    data: {
      pattern,
      path: params.path || ".",
      matches: results.length,
      results,
    },
  };
}

async function handleTodoCreateList(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const title = params.title as string;
  if (!title) return { success: false, error: "title is required" };

  const list = todoManager.createList(title);
  const items = params.items as
    | Array<{ content: string; priority?: string }>
    | undefined;
  if (items && items.length > 0) {
    todoManager.addItems(
      list.id,
      items.map((i) => ({
        content: i.content,
        priority: (i.priority as "high" | "medium" | "low") || undefined,
      })),
    );
  }

  const updated = todoManager.getList(list.id);
  return { success: true, data: updated };
}

async function handleTodoAddItem(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const listId = params.listId as string;
  const items = params.items as Array<{ content: string; priority?: string }>;
  if (!listId) return { success: false, error: "listId is required" };
  if (!items || items.length === 0)
    return { success: false, error: "items array is required" };

  const list = todoManager.addItems(
    listId,
    items.map((i) => ({
      content: i.content,
      priority: (i.priority as "high" | "medium" | "low") || undefined,
    })),
  );

  if (!list) return { success: false, error: `List ${listId} not found` };
  return { success: true, data: list };
}

async function handleTodoUpdateItem(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const listId = params.listId as string;
  const itemId = params.itemId as string;
  if (!listId) return { success: false, error: "listId is required" };
  if (!itemId) return { success: false, error: "itemId is required" };

  const updates: Partial<
    Pick<
      import("./todo-manager").TodoItem,
      "status" | "priority" | "content" | "result"
    >
  > = {};
  if (params.status) updates.status = params.status as any;
  if (params.priority) updates.priority = params.priority as any;
  if (params.result) updates.result = params.result as string;

  const item = todoManager.updateItem(listId, itemId, updates);
  if (!item)
    return {
      success: false,
      error: `Item ${itemId} not found in list ${listId}`,
    };
  return {
    success: true,
    data: { item, progress: todoManager.getProgress(listId) },
  };
}

async function handleTodoGetList(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const listId = params.listId as string;
  if (!listId) return { success: false, error: "listId is required" };

  const list = todoManager.getList(listId);
  if (!list) return { success: false, error: `List ${listId} not found` };
  return {
    success: true,
    data: { ...list, progress: todoManager.getProgress(listId) },
  };
}

async function handleTodoListLists(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const sessionId = params.sessionId as string | undefined;
  const lists = todoManager.getLists(sessionId);
  return {
    success: true,
    data: lists.map((l) => ({
      id: l.id,
      title: l.title,
      itemCount: l.items.length,
      progress: todoManager.getProgress(l.id),
      createdAt: l.createdAt,
    })),
  };
}

async function handleKnowledgeStore(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const title = params.title as string;
  const content = params.content as string;
  if (!title) return { success: false, error: "title is required" };
  if (!content) return { success: false, error: "content is required" };

  const id = knowledgeStore.store({
    source: (params.source as any) || "manual",
    title,
    content,
    url: params.url as string | undefined,
    tags: (params.tags as string[]) || [],
    createdAt: new Date(),
  });

  return { success: true, data: { id, stored: true } };
}

async function handleKnowledgeSearch(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const query = params.query as string;
  if (!query) return { success: false, error: "query is required" };

  const results = knowledgeStore.search(query, {
    limit: (params.limit as number) || 5,
    source: params.source as any,
    tags: params.tags as string[] | undefined,
  });

  return {
    success: true,
    data: {
      query,
      count: results.length,
      results: results.map((r) => ({
        id: r.entry.id,
        title: r.entry.title,
        content: r.entry.content.substring(0, 500),
        source: r.entry.source,
        tags: r.entry.tags,
        score: r.score,
        matchType: r.matchType,
        createdAt: r.entry.createdAt,
      })),
    },
  };
}

async function handleKnowledgeRecent(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const entries = knowledgeStore.getRecent({
    limit: (params.limit as number) || 10,
    source: params.source as any,
  });

  return {
    success: true,
    data: {
      count: entries.length,
      entries: entries.map((e) => ({
        id: e.id,
        title: e.title,
        content: e.content.substring(0, 300),
        source: e.source,
        tags: e.tags,
        createdAt: e.createdAt,
        accessCount: e.accessCount,
      })),
    },
  };
}

async function handleAgentSpawn(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const task = params.task as string;
  if (!task) return { success: false, error: "task is required" };

  if (!aiClient.isConfigured()) {
    return { success: false, error: "AI provider not configured" };
  }

  const systemPrompt =
    (params.systemPrompt as string) ||
    "You are a focused sub-agent. Complete the assigned task and return the result. Be concise and thorough.";

  try {
    const response = await aiClient.chat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: task },
      ],
      temperature: 0.7,
    });

    return {
      success: true,
      data: {
        content: response.content,
        usage: response.usage,
        model: response.model,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Sub-agent failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

async function handleTodoDeleteList(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const listId = params.listId as string;
  if (!listId) return { success: false, error: "listId is required" };

  const deleted = todoManager.deleteList(listId);
  if (!deleted) return { success: false, error: `List ${listId} not found` };
  return { success: true, data: { listId, deleted: true } };
}

async function handleTodoClearCompleted(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const listId = params.listId as string;
  if (!listId) return { success: false, error: "listId is required" };

  const cleared = todoManager.clearCompleted(listId);
  if (!cleared) return { success: false, error: `List ${listId} not found` };
  return { success: true, data: { listId, cleared: true } };
}

async function handleKnowledgeGet(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const id = params.id as string;
  if (!id) return { success: false, error: "id is required" };

  const results = knowledgeStore.search(id, { limit: 100 });
  const entry = results.find((r) => r.entry.id === id);
  if (!entry) {
    const recent = knowledgeStore.getRecent({ limit: 100 });
    const found = recent.find((e) => e.id === id);
    if (!found) return { success: false, error: `Entry ${id} not found` };
    return { success: true, data: found };
  }
  return { success: true, data: entry.entry };
}

async function handleKnowledgeDelete(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const id = params.id as string;
  if (!id) return { success: false, error: "id is required" };

  const deleted = knowledgeStore.deleteEntry(id);
  if (!deleted) return { success: false, error: `Entry ${id} not found` };
  return { success: true, data: { id, deleted: true } };
}

async function handleKnowledgeStats(): Promise<ToolCallResult> {
  const stats = knowledgeStore.getStats();
  return { success: true, data: stats };
}

async function handleMcpCallTool(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const toolName = params.toolName as string;
  const args = (params.args as Record<string, unknown>) || {};

  if (!toolName) return { success: false, error: "toolName is required" };

  return mcpClient.callTool(toolName, args);
}

async function handleMcpListTools(): Promise<ToolCallResult> {
  const tools = mcpClient.getAvailableTools();
  const status = mcpClient.getServerStatus();

  return {
    success: true,
    data: {
      servers: status,
      totalTools: tools.length,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        requiredParams: t.inputSchema.required || [],
      })),
    },
  };
}

async function handleCodebaseSearch(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const query = params.query as string;
  if (!query) return { success: false, error: "query is required" };

  if (!codebaseIndexer.isIndexed()) {
    return {
      success: false,
      error:
        "Codebase not indexed yet. Indexing runs on startup. Use local.search_code as a fallback.",
    };
  }

  const results = await codebaseIndexer.searchWithEmbeddings(query, {
    limit: (params.limit as number) || 10,
    language: params.language as string | undefined,
    filePath: params.filePath as string | undefined,
  });

  return {
    success: true,
    data: {
      query,
      count: results.length,
      results: results.map((r) => ({
        filePath: r.filePath,
        lines: `${r.startLine}-${r.endLine}`,
        language: r.language,
        content: r.content,
        score: Math.round(r.score * 100) / 100,
        matchType: r.matchType,
      })),
    },
  };
}

async function handleCodebaseStats(): Promise<ToolCallResult> {
  const stats = codebaseIndexer.getStats();
  return { success: true, data: stats };
}

async function handleGraphAddNode(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const type = params.type as string;
  const title = params.title as string;
  const content = params.content as string;
  if (!type || !title || !content) {
    return { success: false, error: "type, title, and content are required" };
  }

  const id = knowledgeGraph.addNode({
    type: type as any,
    title,
    content,
    status: (params.status as any) || "proposed",
    context: params.context as string | undefined,
    tags: (params.tags as string[]) || [],
    metadata: {},
  });

  return { success: true, data: { id, type, title } };
}

async function handleGraphAddEdge(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const sourceId = params.sourceId as string;
  const targetId = params.targetId as string;
  const type = params.type as string;
  if (!sourceId || !targetId || !type) {
    return {
      success: false,
      error: "sourceId, targetId, and type are required",
    };
  }

  const id = knowledgeGraph.addEdge(
    sourceId,
    targetId,
    type as any,
    params.description as string | undefined,
  );

  if (!id) {
    return { success: false, error: "Source or target node not found" };
  }

  return { success: true, data: { id, sourceId, targetId, type } };
}

async function handleGraphGetNode(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const id = params.id as string;
  if (!id) return { success: false, error: "id is required" };

  const node = knowledgeGraph.getNode(id);
  if (!node) return { success: false, error: `Node ${id} not found` };

  const edges = knowledgeGraph.getEdgesForNode(id);
  return {
    success: true,
    data: {
      ...node,
      edges: edges.map((e) => ({
        id: e.id,
        type: e.type,
        direction: e.sourceId === id ? "outgoing" : "incoming",
        otherNodeId: e.sourceId === id ? e.targetId : e.sourceId,
        description: e.description,
      })),
    },
  };
}

async function handleGraphQuery(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const nodes = knowledgeGraph.queryNodes({
    type: params.type as any,
    status: params.status as any,
    tags: params.tags as string[] | undefined,
    search: params.search as string | undefined,
    limit: (params.limit as number) || 20,
  });

  return {
    success: true,
    data: {
      count: nodes.length,
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        status: n.status,
        tags: n.tags,
        createdAt: n.createdAt,
      })),
    },
  };
}

async function handleGraphNeighbors(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const nodeId = params.nodeId as string;
  if (!nodeId) return { success: false, error: "nodeId is required" };

  const depth = (params.depth as number) || 2;
  const { nodes, edges } = knowledgeGraph.getNeighbors(nodeId, depth);

  return {
    success: true,
    data: {
      centerNode: nodeId,
      depth,
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        status: n.status,
      })),
      edges: edges.map((e) => ({
        id: e.id,
        sourceId: e.sourceId,
        targetId: e.targetId,
        type: e.type,
        description: e.description,
      })),
    },
  };
}

async function handleGraphUpdateNode(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const id = params.id as string;
  if (!id) return { success: false, error: "id is required" };

  const updates: Record<string, unknown> = {};
  if (params.title !== undefined) updates.title = params.title;
  if (params.content !== undefined) updates.content = params.content;
  if (params.status !== undefined) updates.status = params.status;
  if (params.tags !== undefined) updates.tags = params.tags;

  const node = knowledgeGraph.updateNode(id, updates as any);
  if (!node) return { success: false, error: `Node ${id} not found` };

  return {
    success: true,
    data: { id, title: node.title, status: node.status },
  };
}

async function handleGraphDeleteNode(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const id = params.id as string;
  if (!id) return { success: false, error: "id is required" };

  const deleted = knowledgeGraph.deleteNode(id);
  if (!deleted) return { success: false, error: `Node ${id} not found` };
  return { success: true, data: { id, deleted: true } };
}

async function handleGraphSummary(): Promise<ToolCallResult> {
  return { success: true, data: knowledgeGraph.getGraphSummary() };
}

async function handleWorkflowCreate(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const title = params.title as string;
  if (!title) return { success: false, error: "title is required" };

  const workflow = workflowExecutor.createWorkflow(title, {
    jiraKey: params.jiraKey as string | undefined,
    roadmapItemId: params.roadmapItemId as string | undefined,
    skipPhases: params.skipPhases as any[] | undefined,
  });

  return { success: true, data: workflow };
}

async function handleWorkflowAdvance(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const workflowId = params.workflowId as string;
  const result = params.result as string;
  if (!workflowId) return { success: false, error: "workflowId is required" };
  if (!result) return { success: false, error: "result is required" };

  const workflow = workflowExecutor.advancePhase(workflowId, result);
  if (!workflow)
    return {
      success: false,
      error: `Workflow ${workflowId} not found or already completed`,
    };
  return { success: true, data: workflow };
}

async function handleWorkflowGet(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const workflowId = params.workflowId as string;
  if (!workflowId) return { success: false, error: "workflowId is required" };

  const workflow = workflowExecutor.getWorkflow(workflowId);
  if (!workflow)
    return { success: false, error: `Workflow ${workflowId} not found` };
  return { success: true, data: workflow };
}

async function handleWorkflowList(): Promise<ToolCallResult> {
  const workflows = workflowExecutor.listWorkflows();
  return {
    success: true,
    data: workflows.map((w) => ({
      id: w.id,
      title: w.title,
      currentPhase: w.currentPhase,
      jiraKey: w.jiraKey,
      completedSteps: w.steps.filter((s) => s.status === "completed").length,
      totalSteps: w.steps.filter((s) => s.status !== "skipped").length,
      createdAt: w.createdAt,
      completedAt: w.completedAt,
    })),
  };
}

async function handleWorkflowExecutePhase(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const workflowId = params.workflowId as string;
  if (!workflowId) return { success: false, error: "workflowId is required" };

  const workflow = workflowExecutor.getWorkflow(workflowId);
  if (!workflow)
    return { success: false, error: `Workflow ${workflowId} not found` };

  if (!aiClient.isConfigured()) {
    return { success: false, error: "AI provider not configured" };
  }

  const context = workflowExecutor.getWorkflowContext(workflowId);
  const phasePrompt = workflowExecutor.getPhasePrompt(
    workflow.currentPhase,
    context,
  );

  try {
    const response = await aiClient.chat({
      messages: [
        { role: "system", content: phasePrompt },
        {
          role: "user",
          content: `Execute the ${workflow.currentPhase} phase for: ${workflow.title}. ${context ? `Context from previous phases:\n${context}` : ""}`,
        },
      ],
      temperature: 0.7,
    });

    const result = response.content;
    workflowExecutor.advancePhase(workflowId, result);

    const updated = workflowExecutor.getWorkflow(workflowId);

    return {
      success: true,
      data: {
        phase: workflow.currentPhase,
        result,
        nextPhase: updated?.currentPhase || null,
        completed: !!updated?.completedAt,
        workflow: updated,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Workflow phase execution failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

// ── LSP Handlers ──────────────────────────────────────────────────

async function handleLspDiagnostics(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!lspManager.isReady()) {
    return {
      success: false,
      error: "LSP is not available. Ensure LSP_ENABLED=true and that the language server is installed.",
    };
  }
  const filePath = params.filePath as string;
  if (!filePath) {
    return { success: false, error: "filePath is required" };
  }
  const severity = params.severity as string | undefined;
  const diagnostics = lspManager.getDiagnostics(
    filePath,
    severity as "error" | "warning" | "information" | "hint" | undefined,
  );
  return {
    success: true,
    data: {
      filePath,
      severity: severity || "all",
      count: diagnostics.length,
      diagnostics: diagnostics.map((d) => ({
        severity: d.severity,
        message: d.message,
        line: d.line,
        col: d.col,
        endLine: d.endLine,
        endCol: d.endCol,
        source: d.source,
        code: d.code,
      })),
    },
  };
}

async function handleLspHover(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!lspManager.isReady()) {
    return {
      success: false,
      error: "LSP is not available. Ensure LSP_ENABLED=true and that the language server is installed.",
    };
  }
  const filePath = params.filePath as string;
  const line = params.line as number;
  const character = params.character as number;
  if (!filePath || line === undefined || character === undefined) {
    return {
      success: false,
      error: "filePath, line, and character are required",
    };
  }
  const client = lspManager.getClientForFile(filePath);
  if (!client) {
    return {
      success: false,
      error: `No LSP client available for file: ${filePath}`,
    };
  }
  const result = await client.hover(filePath, line, character);
  if (!result) {
    return { success: true, data: { filePath, line, character, hover: null } };
  }
  return {
    success: true,
    data: {
      filePath,
      line,
      character,
      contents: result.contents,
      range: result.range,
    },
  };
}

async function handleLspDefinition(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!lspManager.isReady()) {
    return {
      success: false,
      error: "LSP is not available. Ensure LSP_ENABLED=true and that the language server is installed.",
    };
  }
  const filePath = params.filePath as string;
  const line = params.line as number;
  const character = params.character as number;
  if (!filePath || line === undefined || character === undefined) {
    return {
      success: false,
      error: "filePath, line, and character are required",
    };
  }
  const client = lspManager.getClientForFile(filePath);
  if (!client) {
    return {
      success: false,
      error: `No LSP client available for file: ${filePath}`,
    };
  }
  const definitions = await client.gotoDefinition(filePath, line, character);
  return {
    success: true,
    data: {
      filePath,
      line,
      character,
      definitions: definitions.map((d) => ({
        filePath: d.filePath,
        uri: d.uri,
        range: d.range,
      })),
    },
  };
}

async function handleLspReferences(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!lspManager.isReady()) {
    return {
      success: false,
      error: "LSP is not available. Ensure LSP_ENABLED=true and that the language server is installed.",
    };
  }
  const filePath = params.filePath as string;
  const line = params.line as number;
  const character = params.character as number;
  if (!filePath || line === undefined || character === undefined) {
    return {
      success: false,
      error: "filePath, line, and character are required",
    };
  }
  const client = lspManager.getClientForFile(filePath);
  if (!client) {
    return {
      success: false,
      error: `No LSP client available for file: ${filePath}`,
    };
  }
  const references = await client.references(filePath, line, character);
  return {
    success: true,
    data: {
      filePath,
      line,
      character,
      references: references.map((r) => ({
        filePath: r.filePath,
        uri: r.uri,
        range: r.range,
      })),
    },
  };
}

async function handleLspSymbols(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!lspManager.isReady()) {
    return {
      success: false,
      error: "LSP is not available. Ensure LSP_ENABLED=true and that the language server is installed.",
    };
  }
  const query = params.query as string;
  if (!query) {
    return { success: false, error: "query is required" };
  }
  const symbols = await lspManager.getClient("typescript")?.workspaceSymbols(query) || [];
  return {
    success: true,
    data: {
      query,
      count: symbols.length,
      symbols: symbols.map((s) => ({
        name: s.name,
        kind: s.kind,
        filePath: s.filePath,
        range: s.range,
        containerName: s.containerName,
      })),
    },
  };
}

// ==================== Work Items Handlers ====================

async function handleWorkItemsCreate(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  try {
    const item = workItemDatabase.createWorkItem({
      type: params.type as any,
      title: params.title as string,
      description: params.description as string | undefined,
      status: params.status as any,
      priority: params.priority as any,
      owner: params.owner as string | undefined,
      source: params.source as any ?? "chat",
      sourceUrl: params.sourceUrl as string | undefined,
      sourceExternalId: params.sourceExternalId as string | undefined,
      dueAt: params.dueAt as string | undefined,
      tags: params.tags as string[] | undefined,
      linkedResources: params.linkedResources as any[] | undefined,
      metadata: params.metadata as Record<string, unknown> | undefined,
    });
    return { success: true, data: item };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleJitbitSearchTickets(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const query = params.query as string;
  if (!query) return { success: false, error: "query is required" };
  const data = await jitbitService.searchTickets(query, {
    assignedToUserId: params.assignedToUserId as number | undefined,
    fromUserId: params.fromUserId as number | undefined,
    dateFrom: params.dateFrom as string | undefined,
    dateTo: params.dateTo as string | undefined,
    categoryId: params.categoryId as number | undefined,
    statusId: params.statusId as number | undefined,
  });
  return { success: true, data };
}

async function handleJitbitGetTicket(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number | string;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  const data = await jitbitService.summarizeTicketForAssistant(ticketId);
  return { success: true, data };
}

async function handleJitbitListRecentTickets(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const data = await jitbitService.getRecentCustomerActivity({
    days: params.days ? Number(params.days) : undefined,
    limit: params.limit ? Number(params.limit) : undefined,
  });
  return { success: true, data };
}

async function handleJitbitGetCustomerSnapshot(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const companyIdOrName = (params.companyId as number | undefined) ?? (params.companyName as string | undefined);
  if (!companyIdOrName) {
    return { success: false, error: "companyId or companyName is required" };
  }
  const data = await jitbitService.getCustomerSnapshot(companyIdOrName);
  return { success: true, data };
}

async function handleJitbitFindFollowups(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const data = await jitbitService.findTicketsNeedingFollowup({
    daysSinceUpdate: params.daysSinceUpdate
      ? Number(params.daysSinceUpdate)
      : undefined,
    limit: params.limit ? Number(params.limit) : undefined,
  });
  return { success: true, data };
}

async function handleJitbitAddTicketComment(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number | string;
  const body = params.body as string;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  if (!body) return { success: false, error: "body is required" };
  const data = await jitbitService.addTicketComment(ticketId, body, {
    forTechsOnly: params.forTechsOnly === true,
  });
  return { success: true, data };
}

async function handleJitbitCreateTicket(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const categoryId = params.categoryId as number;
  const subject = params.subject as string;
  if (!categoryId) return { success: false, error: "categoryId is required" };
  if (!subject) return { success: false, error: "subject is required" };
  const data = await jitbitService.createTicket({
    categoryId,
    subject,
    body: params.body as string | undefined,
    priorityId: params.priorityId as number | undefined,
    assignedToUserId: params.assignedToUserId as number | undefined,
    tags: params.tags as string | undefined,
    companyId: params.companyId as number | undefined,
  });
  return { success: true, data };
}

async function handleJitbitCloseTicket(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  const data = await jitbitService.closeTicket(ticketId);
  return { success: true, data };
}

async function handleJitbitReopenTicket(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  const data = await jitbitService.reopenTicket(ticketId);
  return { success: true, data };
}

async function handleJitbitAssignTicket(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  const assignedUserId = params.assignedUserId as number;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  if (!assignedUserId) return { success: false, error: "assignedUserId is required" };
  const data = await jitbitService.assignTicket(ticketId, assignedUserId);
  return { success: true, data };
}

async function handleJitbitDeleteTicket(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  const data = await jitbitService.deleteTicket(ticketId);
  return { success: true, data };
}

async function handleJitbitMergeTickets(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const targetTicketId = params.targetTicketId as number;
  const sourceTicketIdsStr = params.sourceTicketIds as string;
  if (!targetTicketId) return { success: false, error: "targetTicketId is required" };
  if (!sourceTicketIdsStr) return { success: false, error: "sourceTicketIds is required" };
  const sourceTicketIds = sourceTicketIdsStr.split(",").map((id: string) => Number(id.trim()));
  const data = await jitbitService.mergeTickets({ targetTicketId, sourceTicketIds });
  return { success: true, data };
}

async function handleJitbitForwardTicket(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  const toEmail = params.toEmail as string;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  if (!toEmail) return { success: false, error: "toEmail is required" };
  const data = await jitbitService.forwardTicket(ticketId, {
    toEmail,
    ccEmails: typeof params.ccEmails === "string" ? params.ccEmails.split(",") : undefined,
    body: params.body as string | undefined,
  });
  return { success: true, data };
}

async function handleJitbitListAssets(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const data = await jitbitService.listAssets({
    search: params.search as string | undefined,
    assignedToCompanyId: params.companyId as number | undefined,
    page: params.page ? Number(params.page) : undefined,
  });
  return { success: true, data };
}

async function handleJitbitGetAsset(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const assetId = params.assetId as number;
  if (!assetId) return { success: false, error: "assetId is required" };
  const data = await jitbitService.getAsset(assetId);
  return { success: true, data };
}

async function handleJitbitCreateAsset(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const modelName = (params.modelName ?? params.name) as string;
  if (!modelName) return { success: false, error: "modelName is required" };
  const data = await jitbitService.createAsset({
    modelName,
    manufacturer: params.manufacturer as string | undefined,
    type: params.type as string | undefined,
    companyId: params.companyId as number | undefined,
    serialNumber: params.serialNumber as string | undefined,
    comments: (params.comments ?? params.notes) as string | undefined,
  });
  return { success: true, data };
}

async function handleJitbitUpdateAsset(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const assetId = params.assetId as number;
  if (!assetId) return { success: false, error: "assetId is required" };
  const data = await jitbitService.updateAsset(assetId, {
    modelName: (params.modelName ?? params.name) as string | undefined,
    serialNumber: params.serialNumber as string | undefined,
    companyId: params.companyId as number | undefined,
    comments: (params.comments ?? params.notes) as string | undefined,
  });
  return { success: true, data };
}

async function handleJitbitDisableAsset(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const assetId = params.assetId as number;
  if (!assetId) return { success: false, error: "assetId is required" };
  const data = await jitbitService.disableAsset(assetId);
  return { success: true, data };
}

async function handleJitbitAddTag(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  const tagName = params.tagName as string;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  if (!tagName) return { success: false, error: "tagName is required" };
  const data = await jitbitService.addTag(ticketId, tagName);
  return { success: true, data };
}

async function handleJitbitRemoveTag(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  const tagName = params.tagName as string;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  if (!tagName) return { success: false, error: "tagName is required" };
  const data = await jitbitService.removeTag(ticketId, tagName);
  return { success: true, data };
}

async function handleJitbitAddTimeEntry(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  const timeSpentInSeconds = params.timeSpentInSeconds
    ? Number(params.timeSpentInSeconds)
    : params.minutes ? Number(params.minutes) * 60 : 0;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  if (!timeSpentInSeconds) return { success: false, error: "timeSpentInSeconds is required" };
  const data = await jitbitService.addTimeEntry(ticketId, {
    timeSpentInSeconds,
    statusId: params.statusId as number | undefined,
  });
  return { success: true, data };
}

async function handleJitbitUpdateTicket(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  const fields = params.fields as Record<string, unknown>;
  if (!fields) return { success: false, error: "fields is required" };
  const data = await jitbitService.updateTicket(ticketId, fields);
  return { success: true, data };
}

async function handleJitbitListUsers(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const data = await jitbitService.listUsers({
    companyId: params.companyId as number | undefined,
    count: params.count as number | undefined,
  });
  return { success: true, data };
}

async function handleJitbitSearchUsers(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const query = params.query as string;
  if (!query) return { success: false, error: "query is required" };
  const data = await jitbitService.searchUsers(query);
  return { success: true, data };
}

async function handleJitbitListCompanies(
  _params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const data = await jitbitService.listCompanies();
  return { success: true, data };
}

async function handleJitbitSearchCompanies(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const query = params.query as string;
  if (!query) return { success: false, error: "query is required" };
  const data = await jitbitService.searchCompanies(query);
  return { success: true, data };
}

async function handleJitbitListCategories(
  _params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const data = await jitbitService.listCategories();
  return { success: true, data };
}

async function handleJitbitListPriorities(
  _params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const data = await jitbitService.listPriorities();
  return { success: true, data };
}

async function handleJitbitSubscribeToTicket(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  const data = await jitbitService.subscribeToTicket(ticketId, params.userId as number | undefined);
  return { success: true, data };
}

async function handleJitbitUnsubscribeFromTicket(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  const data = await jitbitService.unsubscribeFromTicket(ticketId, params.userId as number | undefined);
  return { success: true, data };
}

async function handleJitbitListAttachments(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  const data = await jitbitService.listAttachments(ticketId);
  return { success: true, data };
}

async function handleJitbitAddAttachment(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  const data = await jitbitService.addAttachment(ticketId, {
    fileName: params.fileName as string,
    data: params.data as string,
  });
  return { success: true, data };
}

async function handleJitbitListCustomFields(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const data = await jitbitService.listCustomFields(params.categoryId as number | undefined);
  return { success: true, data };
}

async function handleJitbitGetCustomFieldValues(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  const data = await jitbitService.getCustomFieldValues(ticketId);
  return { success: true, data };
}

async function handleJitbitSetCustomFieldValue(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  const fieldId = params.fieldId as number;
  const value = params.value as string;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  if (!fieldId) return { success: false, error: "fieldId is required" };
  if (!value) return { success: false, error: "value is required" };
  const data = await jitbitService.setCustomFieldValue(ticketId, fieldId, value);
  return { success: true, data };
}

async function handleJitbitListTags(
  _params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const data = await jitbitService.listTags();
  return { success: true, data };
}

async function handleJitbitListSections(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const data = await jitbitService.listSections(params.categoryId as number | undefined);
  return { success: true, data };
}

async function handleJitbitGetTimeEntries(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  const data = await jitbitService.getTimeEntries(ticketId);
  return { success: true, data };
}

async function handleJitbitListAutomationRules(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const data = await jitbitService.listAutomationRules(params.categoryId as number | undefined);
  return { success: true, data };
}

async function handleJitbitTriggerAutomation(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  const ruleId = params.ruleId as number;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  if (!ruleId) return { success: false, error: "ruleId is required" };
  const data = await jitbitService.triggerAutomation(ticketId, ruleId);
  return { success: true, data };
}

// ── HAWK IR Handlers ──────────────────────────────────────────────────

async function handleHawkIrGetCases(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const data = await hawkIrService.getCases({
    startDate: params.startDate as string | undefined,
    stopDate: params.stopDate as string | undefined,
    groupId: params.groupId as string | undefined,
    limit: params.limit as number | undefined,
  });
  return { success: true, data };
}

async function handleHawkIrGetCase(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const caseId = params.caseId as string;
  if (!caseId) return { success: false, error: "caseId is required" };
  const data = await hawkIrService.getCase(caseId);
  return { success: true, data };
}

async function handleHawkIrGetCaseSummary(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const caseId = params.caseId as string;
  if (!caseId) return { success: false, error: "caseId is required" };
  const data = await hawkIrService.getCaseSummary(caseId);
  return { success: true, data };
}

async function handleHawkIrGetRiskyOpenCases(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const data = await hawkIrService.getRiskyOpenCases({
    minRiskLevel: params.minRiskLevel as any,
    limit: params.limit as number | undefined,
  });
  return { success: true, data };
}

async function handleHawkIrDeescalateCase(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const caseId = params.caseId as string;
  const reason = params.reason as string;
  if (!caseId) return { success: false, error: "caseId is required" };
  if (!reason) return { success: false, error: "reason is required" };
  const data = await hawkIrService.deescalateCase(caseId, reason, params.note as string | undefined);
  return { success: true, data };
}

async function handleHawkIrSearchLogs(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const query = params.query as string;
  if (!query) return { success: false, error: "query is required" };
  const data = await hawkIrService.searchLogs({
    q: query,
    idx: params.index as string | undefined,
    from: params.from as string | undefined,
    to: params.to as string | undefined,
    size: params.size as number | undefined,
  });
  return { success: true, data };
}

async function handleHawkIrGetAvailableIndexes(
  _params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const data = await hawkIrService.getAvailableIndexes();
  return { success: true, data };
}

async function handleHawkIrGetAssets(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const data = await hawkIrService.getAssets({
    search: params.search as string | undefined,
    limit: params.limit as number | undefined,
  });
  return { success: true, data };
}

async function handleHawkIrGetAssetSummary(
  _params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const data = await hawkIrService.getAssetSummary();
  return { success: true, data };
}

async function handleHawkIrGetIdentities(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const data = await hawkIrService.getIdentities({
    search: params.search as string | undefined,
    limit: params.limit as number | undefined,
  });
  return { success: true, data };
}

async function handleHawkIrGetIdentitySummary(
  _params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const data = await hawkIrService.getIdentitySummary();
  return { success: true, data };
}

async function handleHawkIrListNodes(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const groupIds = params.groupIds
    ? String(params.groupIds).split(",").map((s: string) => s.trim())
    : undefined;
  const data = await hawkIrService.listNodes(groupIds);
  return { success: true, data };
}

async function handleHawkIrGetActiveNodes(
  _params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const data = await hawkIrService.getActiveNodes();
  return { success: true, data };
}

async function handleHawkIrListDashboards(
  _params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const data = await hawkIrService.listDashboards();
  return { success: true, data };
}

async function handleHawkIrRunDashboard(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const dashboardId = params.dashboardId as string;
  if (!dashboardId) return { success: false, error: "dashboardId is required" };
  const data = await hawkIrService.runDashboardWidget(dashboardId, params.body as Record<string, unknown> | undefined);
  return { success: true, data };
}

async function handleWorkItemsList(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  try {
    const result = workItemDatabase.listWorkItems({
      status: params.status as any,
      type: params.type as any,
      priority: params.priority as any,
      source: params.source as any,
      owner: params.owner as string | undefined,
      search: params.search as string | undefined,
      includeArchived: params.includeArchived === true,
      limit: params.limit ? Number(params.limit) : undefined,
      offset: params.offset ? Number(params.offset) : undefined,
    });
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleWorkItemsUpdate(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  try {
    const id = params.id as string;
    if (!id) return { success: false, error: "id is required" };
    const item = workItemDatabase.updateWorkItem(id, {
      type: params.type as any,
      title: params.title as string | undefined,
      description: params.description as string | undefined,
      status: params.status as any,
      priority: params.priority as any,
      owner: params.owner as string | undefined,
      source: params.source as any,
      sourceUrl: params.sourceUrl as string | null | undefined,
      sourceExternalId: params.sourceExternalId as string | null | undefined,
      dueAt: params.dueAt as string | null | undefined,
      tags: params.tags as string[] | undefined,
      linkedResources: params.linkedResources as any[] | undefined,
      metadata: params.metadata as Record<string, unknown> | undefined,
    });
    if (!item) return { success: false, error: "Work item not found" };
    return { success: true, data: item };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleWorkItemsAddNote(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  try {
    const id = params.id as string;
    const content = params.content as string;
    if (!id) return { success: false, error: "id is required" };
    if (!content) return { success: false, error: "content is required" };
    const item = workItemDatabase.addNote(id, userId, content);
    if (!item) return { success: false, error: "Work item not found" };
    return { success: true, data: item };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleWorkItemsComplete(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  try {
    const id = params.id as string;
    if (!id) return { success: false, error: "id is required" };
    const item = workItemDatabase.completeWorkItem(id);
    if (!item) return { success: false, error: "Work item not found" };
    return { success: true, data: item };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
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
  "jitbit.search_tickets": handleJitbitSearchTickets,
  "jitbit.get_ticket": handleJitbitGetTicket,
  "jitbit.list_recent_tickets": handleJitbitListRecentTickets,
  "jitbit.get_customer_snapshot": handleJitbitGetCustomerSnapshot,
  "jitbit.find_followups": handleJitbitFindFollowups,
  "jitbit.add_ticket_comment": handleJitbitAddTicketComment,
  "jitbit.create_ticket": handleJitbitCreateTicket,
  "jitbit.close_ticket": handleJitbitCloseTicket,
  "jitbit.reopen_ticket": handleJitbitReopenTicket,
  "jitbit.assign_ticket": handleJitbitAssignTicket,
  "jitbit.delete_ticket": handleJitbitDeleteTicket,
  "jitbit.merge_tickets": handleJitbitMergeTickets,
  "jitbit.forward_ticket": handleJitbitForwardTicket,
  "jitbit.list_assets": handleJitbitListAssets,
  "jitbit.get_asset": handleJitbitGetAsset,
  "jitbit.create_asset": handleJitbitCreateAsset,
  "jitbit.update_asset": handleJitbitUpdateAsset,
  "jitbit.disable_asset": handleJitbitDisableAsset,
  "jitbit.add_tag": handleJitbitAddTag,
  "jitbit.remove_tag": handleJitbitRemoveTag,
  "jitbit.add_time_entry": handleJitbitAddTimeEntry,
  "productivity.generate_daily_plan": handleDailyPlan,
  "productivity.generate_weekly_plan": handleWeeklyPlan,
  "cto.daily_command_center": handleCtoDailyCommandCenter,
  "personal_os.brief": handlePersonalOsBrief,
  "personal_os.open_loops": handlePersonalOsOpenLoops,
  "personal_os.detect_patterns": handlePersonalOsDetectPatterns,
  "personal_os.suggest_focus": handlePersonalOsSuggestFocus,
  "personal_os.create_work_items": handlePersonalOsCreateWorkItems,

  // Product Chief of Staff
  "product.workflow_brief": handleProductWorkflowBrief,
  "product.roadmap_proposal": handleProductRoadmapProposal,
  "product.roadmap_drift": handleProductRoadmapDrift,
  "product.customer_signals": handleProductCustomerSignals,
  "product.weekly_update": handleProductWeeklyUpdate,
  "product.create_work_items": handleProductCreateWorkItems,
  "web.search": handleWebSearch,
  "web.fetch_page": handleWebFetchPage,

  // ── Roadmap Handlers ────────────────────────────────────────
  "roadmap.list": handleRoadmapList,
  "roadmap.get": handleRoadmapGet,
  "roadmap.create": handleRoadmapCreate,
  "roadmap.update": handleRoadmapUpdate,
  "roadmap.add_milestone": handleRoadmapAddMilestone,
  "roadmap.add_item": handleRoadmapAddItem,
  "roadmap.update_milestone": handleRoadmapUpdateMilestone,
  "roadmap.update_item": handleRoadmapUpdateItem,
  "roadmap.delete": handleRoadmapDelete,
  "roadmap.delete_milestone": handleRoadmapDeleteMilestone,
  "roadmap.delete_item": handleRoadmapDeleteItem,

  "engineering.workflow_brief": handleEngineeringWorkflowBrief,
  "engineering.architecture_proposal": handleEngineeringArchitectureProposal,
  "engineering.scaffolding_plan": handleEngineeringScaffoldingPlan,
  "engineering.jira_tickets": handleEngineeringJiraTickets,

  "system.approve_action": handleApproveAction,
  "system.reject_action": handleRejectAction,
  "system.list_approvals": handleListApprovals,
  "system.check_health": handleSystemCheckHealth,

  // Work Items
  "work_items.create": handleWorkItemsCreate,
  "work_items.list": handleWorkItemsList,
  "work_items.update": handleWorkItemsUpdate,
  "work_items.add_note": handleWorkItemsAddNote,
  "work_items.complete": handleWorkItemsComplete,

  discover_tools: handleDiscoverTools,

  "codex.run": handleCodexRun,
  "todo.create_list": handleTodoCreateList,
  "todo.add_item": handleTodoAddItem,
  "todo.update_item": handleTodoUpdateItem,
  "todo.get_list": handleTodoGetList,
  "todo.list_lists": handleTodoListLists,
  "todo.delete_list": handleTodoDeleteList,
  "todo.clear_completed": handleTodoClearCompleted,
  "knowledge.store": handleKnowledgeStore,
  "knowledge.search": handleKnowledgeSearch,
  "knowledge.recent": handleKnowledgeRecent,
  "knowledge.get": handleKnowledgeGet,
  "knowledge.delete": handleKnowledgeDelete,
  "knowledge.stats": handleKnowledgeStats,
  "agent.spawn": handleAgentSpawn,

  "memory.find_entities": handleMemoryFindEntities,
  "memory.get_entity_context": handleMemoryGetEntityContext,
  "memory.add_entity_fact": handleMemoryAddEntityFact,

  "workflow.create": handleWorkflowCreate,
  "workflow.advance": handleWorkflowAdvance,
  "workflow.get": handleWorkflowGet,
  "workflow.list": handleWorkflowList,
  "workflow.execute_phase": handleWorkflowExecutePhase,

  "local.read_file": handleLocalReadFile,
  "local.list_tree": handleLocalListTree,
  "local.search_code": handleLocalSearchCode,

  "mcp.call_tool": handleMcpCallTool,
  "mcp.list_tools": handleMcpListTools,

  "codebase.search": handleCodebaseSearch,
  "codebase.stats": handleCodebaseStats,

  "graph.add_node": handleGraphAddNode,
  "graph.add_edge": handleGraphAddEdge,
  "graph.get_node": handleGraphGetNode,
  "graph.query": handleGraphQuery,
  "graph.neighbors": handleGraphNeighbors,
  "graph.update_node": handleGraphUpdateNode,
  "graph.delete_node": handleGraphDeleteNode,
  "graph.summary": handleGraphSummary,

  "lsp.diagnostics": handleLspDiagnostics,
  "lsp.hover": handleLspHover,
  "lsp.definition": handleLspDefinition,
  "lsp.references": handleLspReferences,
  "lsp.symbols": handleLspSymbols,
};

const SYSTEM_TOOLS = new Set([
  "discover_tools",
  "system.approve_action",
  "system.reject_action",
  "system.list_approvals",
  "system.check_health",
  "engineering.workflow_brief",
  "engineering.architecture_proposal",
  "engineering.scaffolding_plan",
  "productivity.generate_daily_plan",
  "productivity.generate_weekly_plan",
  "cto.daily_command_center",
  "personal_os.brief",
  "personal_os.open_loops",
  "personal_os.detect_patterns",
  "personal_os.suggest_focus",
  "product.workflow_brief",
  "product.roadmap_proposal",
  "product.roadmap_drift",
  "product.customer_signals",
  "product.weekly_update",
]);

export interface DispatchContext {
  /** Recent conversation messages for platform intent detection */
  messages?: import("../agent/providers/types").ChatMessage[];
  /** Agent mode (productivity, engineering) */
  mode?: string;
}

export async function dispatchToolCall(
  toolName: string,
  params: Record<string, unknown>,
  userId: string = "user",
  skipPolicyCheck: boolean = false,
  context?: DispatchContext,
): Promise<ToolCallResult> {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  if (!skipPolicyCheck && !SYSTEM_TOOLS.has(toolName)) {
    const toolDef = getToolByName(
      toolName,
      (params._mode as string) || "productivity",
    );
    const actionType = toolDef?.actionType || toolName;

    const action = {
      id: `action-${Date.now()}`,
      type: actionType,
      description: `Execute ${toolName}`,
      params: { ...params },
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (decision.result === "blocked") {
      await auditLogger.log({
        id: "",
        timestamp: new Date(),
        action: `policy.blocked`,
        actor: userId,
        details: { toolName, actionType, reason: decision.reason },
        severity: "warn",
      });
      return {
        success: false,
        error: `Action "${toolName}" is blocked by policy: ${decision.reason}. This action cannot be performed.`,
      };
    }

    if (decision.result === "approval_required") {
      const approvalRequest = await policyEngine.createApprovalRequest(
        action,
        decision,
      );
      await approvalQueue.enqueue(approvalRequest);

      await auditLogger.log({
        id: "",
        timestamp: new Date(),
        action: `policy.approval_required`,
        actor: userId,
        details: { toolName, actionType, approvalId: approvalRequest.id },
        severity: "info",
      });

      return {
        success: false,
        requiresApproval: true,
        approvalId: approvalRequest.id,
        error: `⚠️ This action requires your approval before proceeding.\n\n**Action:** ${toolName}\n**Approval ID:** ${approvalRequest.id}\n**Risk Level:** ${decision.riskLevel}\n**Reason:** ${decision.reason}\n\nSay "approve ${approvalRequest.id}" to allow this action, or "reject ${approvalRequest.id}" to deny it.`,
        data: {
          approvalId: approvalRequest.id,
          action: actionType,
          riskLevel: decision.riskLevel,
          reason: decision.reason,
        },
      };
    }
  }

  // Platform alignment check (after policy, before execution)
  if (context?.messages && !SYSTEM_TOOLS.has(toolName)) {
    const intent = detectPlatformIntent(context.messages);
    const alignment = validatePlatformAlignment(
      toolName,
      intent,
    );

    if (alignment.result === "warning") {
      await auditLogger.log({
        id: "",
        timestamp: new Date(),
        action: `platform.cross_contamination`,
        actor: userId,
        details: {
          toolName,
          toolPlatform: alignment.toolPlatform,
          intentPlatform: alignment.intentPlatform,
          reason: alignment.reason,
        },
        severity: "warn",
      });

      const toolDef = getToolByName(
        toolName,
        context.mode || (params._mode as string) || "productivity",
      );
      const actionType = toolDef?.actionType || toolName;

      const action = {
        id: `action-${Date.now()}`,
        type: actionType,
        description: `Execute ${toolName} (platform mismatch: ${alignment.reason})`,
        params: { ...params },
        userId,
        timestamp: new Date(),
        platformMismatch: {
          toolPlatform: alignment.toolPlatform,
          intentPlatform: alignment.intentPlatform,
          source: intent.source,
          evidence: intent.evidence,
          suggestedAlternatives: alignment.suggestedAlternatives,
        },
      };

      const decision = {
        action,
        result: "approval_required" as const,
        riskLevel: "medium" as const,
        reason: alignment.reason,
        applicablePolicy: "platform.cross_contamination",
      };

      const approvalRequest = await policyEngine.createApprovalRequest(
        action,
        decision,
      );
      await approvalQueue.enqueue(approvalRequest);

      const alternativesText = alignment.suggestedAlternatives?.length
        ? `\n\n**Suggested alternatives on ${alignment.intentPlatform}:**\n${alignment.suggestedAlternatives.map((a) => `- ${a}`).join("\n")}`
        : "";

      return {
        success: false,
        requiresApproval: true,
        approvalId: approvalRequest.id,
        error: `Platform mismatch detected: ${alignment.reason}.${alternativesText}\n\n**Approval ID:** ${approvalRequest.id}\n\nSay "approve ${approvalRequest.id}" to proceed, or "reject ${approvalRequest.id}" to cancel.`,
        data: {
          approvalId: approvalRequest.id,
          action: actionType,
          riskLevel: "medium",
          reason: alignment.reason,
          toolPlatform: alignment.toolPlatform,
          intentPlatform: alignment.intentPlatform,
          suggestedAlternatives: alignment.suggestedAlternatives,
        },
      };
    }
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
