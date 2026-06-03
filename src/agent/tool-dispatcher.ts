import { codexClient } from "../integrations/codex/codex-client";
import { webSearchClient } from "../integrations/web/search-client";
import { fileCalendarService } from "../integrations/file/calendar-service";
import type { CalendarEvent } from "../integrations/file/calendar-service";
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
import { tenableCloudService } from "../integrations/tenable-cloud/tenable-cloud-service";
import type { TenableExportStatus } from "../integrations/tenable-cloud/types";
import { roadmapDatabase } from "../roadmap/database";
import { auditLogger } from "../audit/logger";
import { env } from "../config/env";
import { providerSettings } from "./provider-settings";
import { reviewGate, formatGateBlockComment } from "../autonomous-loop/review-gate";
import { loadReviewGateState } from "../autonomous-loop/review-gate-state";
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
import {
  ticketToTaskGenerator,
  TicketToTaskAgent,
} from "../engineering/ticket-to-task";
import { policyEngine } from "../policy/engine";
import { approvalQueue } from "../approvals/queue";
import * as fs from "fs";
import * as path from "path";
import { todoManager } from "./todo-manager";
import { knowledgeStore } from "./knowledge-store";
import { aiClient } from "./opencode-client";
import { workItemDatabase } from "../work-items/database";
import { dryRunResult } from "./dry-run";
import { workflowExecutor } from "./workflow-executor";
import { mcpClient } from "../integrations/mcp";
import { codebaseIndexer } from "./codebase-indexer";
import { knowledgeGraph } from "./knowledge-graph";
import { entityMemory } from "../memory/entity-memory";
import { agentMemory } from "../memory/agent-memory";
import { createMemoryManageHandler } from "./handlers/memory-manage";
import { skillManager } from "../skills/skill-manager";
import { createSkillManageHandler } from "./handlers/skill-manage";
import type { EntityType, FindEntitiesQuery } from "../memory/entity-types";
import { lspManager } from "../integrations/lsp/index.js";
import type { DiagnosticItem } from "../integrations/lsp/lsp-client.js";
import { reviewAssistant } from "../code-review/review-assistant";
import { ticketBridge } from "../integrations/ticket-bridge/ticket-bridge";
import { musicianService } from "../musician/service";
import { agentRunDatabase } from "../agent-runs/database";
import type { AgentRun } from "../agent-runs/types";
import {
  getFileSummary,
  readFileSection,
  getFileChunks,
} from "./file-symbol-parser";

export interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
  requiresApproval?: boolean;
  approvalId?: string;
  dryRun?: boolean;
  message?: string;
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
  if (params.dryRun === true) {
    return { success: true, dryRun: true, data: dryRunResult({
      toolName: "calendar.create_focus_block",
      summary: `Would create focus block "${params.title}" at ${params.startTime}`,
      targetSystem: "calendar",
      changes: [
        { field: "event", description: `Create focus block "${params.title}"` },
        { field: "startTime", to: params.startTime as string, description: "Set start time" },
        { field: "duration", to: String(params.duration), description: "Set duration in minutes" },
        ...(params.description ? [{ field: "description" as const, to: params.description as string, description: "Set description" }] : []),
      ],
      riskLevel: "low",
      paramsPreview: { title: params.title, startTime: params.startTime, duration: params.duration, description: params.description },
    }) };
  }
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
  if (params.dryRun === true) {
    return { success: true, dryRun: true, data: dryRunResult({
      toolName: "calendar.create_health_block",
      summary: `Would create health block "${params.title}" at ${params.startTime}`,
      targetSystem: "calendar",
      changes: [
        { field: "event", description: `Create ${params.type || "health"} block "${params.title}"` },
        { field: "startTime", to: params.startTime as string, description: "Set start time" },
        { field: "duration", to: String(params.duration), description: "Set duration in minutes" },
        { field: "type", to: params.type as string, description: "Set block type" },
      ],
      riskLevel: "low",
      paramsPreview: { title: params.title, startTime: params.startTime, duration: params.duration, type: params.type },
    }) };
  }
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

async function handleCalendarCreateEvent(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!env.ENABLE_CALENDAR_WRITE) {
    return { success: false, error: "Calendar write operations are disabled" };
  }
  const event = await fileCalendarService.createEvent({
    summary: params.summary as string,
    startTime: new Date(params.startTime as string),
    endTime: new Date(params.endTime as string),
    description: params.description as string | undefined,
    location: params.location as string | undefined,
    type: (params.type as CalendarEvent["type"]) || "other",
  });
  return { success: true, data: event };
}

async function handleCalendarUpdateEvent(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!env.ENABLE_CALENDAR_WRITE) {
    return { success: false, error: "Calendar write operations are disabled" };
  }
  const eventId = params.eventId as string;
  if (!eventId) return { success: false, error: "eventId is required" };
  const event = await fileCalendarService.updateEvent(eventId, {
    summary: params.summary as string | undefined,
    startTime: params.startTime ? new Date(params.startTime as string) : undefined,
    endTime: params.endTime ? new Date(params.endTime as string) : undefined,
    description: params.description as string | undefined,
    location: params.location as string | undefined,
    type: params.type as CalendarEvent["type"] | undefined,
  });
  return { success: true, data: event };
}

async function handleCalendarDeleteEvent(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!env.ENABLE_CALENDAR_WRITE) {
    return { success: false, error: "Calendar write operations are disabled" };
  }
  if (!env.POLICY_CALENDAR_ALLOW_DELETE) {
    return { success: false, error: "Calendar delete operations are disabled by policy" };
  }
  const eventId = params.eventId as string;
  if (!eventId) return { success: false, error: "eventId is required" };
  const deleted = await fileCalendarService.deleteEvent(eventId);
  return { success: true, data: { deleted } };
}

async function handleCalendarGetEvent(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const eventId = params.eventId as string;
  if (!eventId) return { success: false, error: "eventId is required" };
  const event = fileCalendarService.getEvent(eventId);
  if (!event) return { success: false, error: "Event not found" };
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
  if (params.dryRun === true) {
    return { success: true, dryRun: true, data: dryRunResult({
      toolName: "jira.add_comment",
      summary: `Would add comment to Jira issue ${params.key}`,
      targetSystem: "jira",
      changes: [
        { field: "comment", to: params.body as string, description: "Add comment to issue" },
      ],
      riskLevel: "low",
      paramsPreview: { key: params.key, body: params.body },
    }) };
  }
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
  if (params.dryRun === true) {
    return { success: true, dryRun: true, data: dryRunResult({
      toolName: "jira.create_issue",
      summary: `Would create Jira issue "${params.summary}" in project ${params.project}`,
      targetSystem: "jira",
      changes: [
        { field: "issue", description: `Create new ${params.issueType || "Task"} "${params.summary}"` },
        { field: "description", to: params.description as string, description: "Set issue description" },
        { field: "priority", to: params.priority as string, description: "Set priority" },
        { field: "labels", to: params.labels as string, description: "Set labels" },
      ],
      riskLevel: "medium",
      paramsPreview: { project: params.project, summary: params.summary, issueType: params.issueType, priority: params.priority },
    }) };
  }
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
  if (params.dryRun === true) {
    const key = params.key as string;
    const changes: Array<{ field: string; from?: string; to?: string; description: string }> = [];
    if (params.summary) changes.push({ field: "summary", to: params.summary as string, description: "Update summary" });
    if (params.description) changes.push({ field: "description", to: params.description as string, description: "Update description" });
    if (params.assignee) changes.push({ field: "assignee", to: params.assignee as string, description: "Reassign issue" });
    if (params.priority) changes.push({ field: "priority", to: params.priority as string, description: "Update priority" });
    if (params.labels) changes.push({ field: "labels", to: params.labels as string, description: "Update labels" });
    return { success: true, dryRun: true, data: dryRunResult({
      toolName: "jira.update_issue",
      summary: `Would update Jira issue ${key}`,
      targetSystem: "jira",
      changes,
      riskLevel: "medium",
      paramsPreview: { key, summary: params.summary, description: params.description, assignee: params.assignee, priority: params.priority, labels: params.labels },
    }) };
  }
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
  if (params.dryRun === true) {
    return { success: true, dryRun: true, data: dryRunResult({
      toolName: "jira.close_issue",
      summary: `Would close Jira issue ${params.key}`,
      targetSystem: "jira",
      changes: [
        { field: "status", description: `Transition ${params.key} to Done/Closed` },
        ...(params.comment ? [{ field: "comment" as const, to: params.comment as string, description: "Add closing comment" }] : []),
      ],
      riskLevel: "high",
      paramsPreview: { key: params.key, comment: params.comment },
    }) };
  }
  if (!jiraClient.isConfigured()) {
    return { success: false, error: "Jira client not configured" };
  }

  const key = params.key as string;
  if (!key) {
    return { success: false, error: "key is required" };
  }

  // Review gate: check whether unresolved critical/high findings block "Done" transition
  const gateState = loadReviewGateState(key);
  const forceDone = params.force_done === true || params.forceDone === true;
  const gate = reviewGate(gateState.lastFindings, forceDone, gateState.reviewOccurred);

  if (!gate.canMarkDone) {
    const blockComment = formatGateBlockComment(gate);

    // Post a comment on the Jira ticket explaining why it can't be closed
    try {
      await jiraClient.addComment(key, blockComment);
    } catch {
      // Comment posting is best-effort
    }

    // Transition to "In Progress" instead of "Done" if possible
    const transitions = await jiraClient.getTransitions(key);
    const inProgressNames = ["in progress", "start progress", "in progress"];
    const inProgressTransition = transitions.find((t) =>
      inProgressNames.some((n) => t.to.name.toLowerCase().includes(n)),
    );

    if (inProgressTransition) {
      await jiraClient.transitionIssue(
        key,
        inProgressTransition.id,
        `Review gate blocked Done transition: ${gate.criticalCount} critical and ${gate.highCount} high findings unresolved.`,
      );
    }

    return {
      success: false,
      error: `Review gate blocked: ${gate.criticalCount} critical and ${gate.highCount} high findings unresolved. Ticket transitioned to In Progress instead. Use force_done=true to override.`,
      data: { key, blockedBy: gate.blockedBy, criticalCount: gate.criticalCount, highCount: gate.highCount },
    };
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

async function handleJiraDeleteComment(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  if (params.dryRun === true) {
    return { success: true, dryRun: true, data: dryRunResult({
      toolName: "jira.delete_comment",
      summary: `Would delete comment ${params.commentId} from Jira issue ${params.key}`,
      targetSystem: "jira",
      changes: [
        { field: "comment", description: `Delete comment ${params.commentId} from ${params.key}` },
      ],
      riskLevel: "high",
      paramsPreview: { key: params.key, commentId: params.commentId },
    }) };
  }
  if (!env.ENABLE_JIRA_TRANSITIONS) {
    return { success: false, error: "Jira delete operations are disabled" };
  }
  if (!jiraClient.isConfigured()) {
    return { success: false, error: "Jira client not configured" };
  }

  const key = params.key as string;
  const commentId = params.commentId as string;
  if (!key || !commentId) {
    return { success: false, error: "key and commentId are required" };
  }

  await jiraClient.deleteComment(key, commentId);
  return {
    success: true,
    data: { key, commentId, deleted: true },
  };
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
  if (params.dryRun === true) {
    return { success: true, dryRun: true, data: dryRunResult({
      toolName: "gitlab.create_merge_request",
      summary: `Would create MR "${params.title}" in ${params.projectId || "default project"}`,
      targetSystem: "gitlab",
      changes: [
        { field: "merge_request", description: `Create MR "${params.title}"` },
        { field: "sourceBranch", to: params.sourceBranch as string, description: "Set source branch" },
        { field: "targetBranch", to: params.targetBranch as string, description: "Set target branch" },
        ...(params.description ? [{ field: "description" as const, to: params.description as string, description: "Set MR description" }] : []),
        ...(params.labels ? [{ field: "labels" as const, to: params.labels as string, description: "Set labels" }] : []),
      ],
      riskLevel: "medium",
      paramsPreview: { projectId: params.projectId, sourceBranch: params.sourceBranch, targetBranch: params.targetBranch, title: params.title },
    }) };
  }
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
  if (params.dryRun === true) {
    return { success: true, dryRun: true, data: dryRunResult({
      toolName: "gitlab.add_mr_comment",
      summary: `Would add comment to MR !${params.mrIid}`,
      targetSystem: "gitlab",
      changes: [
        { field: "comment", to: params.body as string, description: "Add comment to merge request" },
      ],
      riskLevel: "low",
      paramsPreview: { projectId: params.projectId, mrIid: params.mrIid, body: params.body },
    }) };
  }
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
  if (params.dryRun === true) {
    return { success: true, dryRun: true, data: dryRunResult({
      toolName: "github.add_pr_comment",
      summary: `Would add comment to PR #${params.prNumber}`,
      targetSystem: "github",
      changes: [
        { field: "comment", to: params.body as string, description: "Add comment to pull request" },
      ],
      riskLevel: "low",
      paramsPreview: { owner: params.owner, repo: params.repo, prNumber: params.prNumber, body: params.body },
    }) };
  }
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
  if (params.dryRun === true) {
    const owner = params.owner as string | undefined;
    const repo = params.repo as string | undefined;
    return { success: true, dryRun: true, data: dryRunResult({
      toolName: "github.create_issue",
      summary: `Would create GitHub issue "${params.title}" in ${owner || "default"}/${repo || "default"}`,
      targetSystem: "github",
      changes: [
        { field: "issue", description: `Create new issue "${params.title}"` },
        ...(params.body ? [{ field: "body" as const, to: params.body as string, description: "Set issue body" }] : []),
        ...(params.labels ? [{ field: "labels" as const, to: params.labels as string, description: "Set labels" }] : []),
        ...(params.assignees ? [{ field: "assignees" as const, to: params.assignees as string, description: "Set assignees" }] : []),
      ],
      riskLevel: "medium",
      paramsPreview: { owner, repo, title: params.title, labels: params.labels, assignees: params.assignees },
    }) };
  }
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

const handleMemoryManage = createMemoryManageHandler(agentMemory);
const handleSkillManage = createSkillManageHandler(skillManager);

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

async function handleProductShippedVsPlanned(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const data = await productChiefOfStaff.summarizeShippedVsPlanned({
    roadmapId: params.roadmapId as string | undefined,
  });
  return { success: true, data };
}

async function handleCtoCreateSuggestedWorkItems(
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
  const created = ctoDailyCommandCenter.createSuggestedWorkItems(items as any[]);
  return { success: true, data: { created } };
}

async function handleDiscoverTools(
  params: Record<string, unknown>,
  _userId: string,
): Promise<ToolCallResult> {
  const singleCategory = params.category as string | undefined;
  const categoriesArray = params.categories as string[] | undefined;
  const mode = (params._mode as string) || "productivity";
  const loadedNames = new Set(
    (params._loadedTools as string[] | undefined) || [],
  );

  const requestedCategories: string[] = categoriesArray
    ? Array.isArray(categoriesArray)
      ? categoriesArray
      : [categoriesArray]
    : singleCategory
      ? [singleCategory]
      : [];

  if (requestedCategories.length === 0) {
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
          "Specify a category or categories to load those tools. Available categories:",
        categories: summary,
      },
    };
  }

  let totalNew = 0;
  let totalAlready = 0;
  const allNewTools: Array<{ name: string; description: string; params: string[] }> = [];
  const unknownCategories: string[] = [];

  for (const category of requestedCategories) {
    const tools = getToolsByCategory(mode, category);
    if (tools.length === 0) {
      unknownCategories.push(category);
      continue;
    }

    const newTools = tools.filter((t) => !loadedNames.has(t.name));
    totalAlready += tools.length - newTools.length;
    totalNew += newTools.length;

    for (const t of newTools) {
      allNewTools.push({
        name: t.name,
        description: t.description,
        params: Object.keys(t.params),
      });
    }
  }

  if (unknownCategories.length > 0 && allNewTools.length === 0) {
    return {
      success: false,
      error: `Unknown categories: ${unknownCategories.join(", ")}. Use discover_tools without arguments to see available options.`,
    };
  }

  if (allNewTools.length === 0) {
    return {
      success: true,
      data: {
        message: `All requested tools are already loaded. No need to call discover_tools again.`,
        tools: [],
      },
    };
  }

  const catLabel = requestedCategories.join(", ");
  const message = totalAlready > 0
    ? `Loaded ${totalNew} new tools from ${catLabel} (${totalAlready} already loaded). You can now use them.`
    : `Loaded ${totalNew} tools from ${catLabel}. You can now use them.`;

  return {
    success: true,
    data: {
      message,
      tools: allNewTools,
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

async function handleSystemGetTime(
  _params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const now = new Date();
    return {
      success: true,
      data: {
        iso: now.toISOString(),
        local: now.toLocaleString(),
        date: now.toLocaleDateString(),
        time: now.toLocaleTimeString(),
        timestamp: now.getTime(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offset: now.getTimezoneOffset(),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleSystemExec(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const { exec } = await import("child_process");
  const util = await import("util");
  const execPromise = util.promisify(exec);

  const command = String(params.command || "");
  const cwd = String(params.cwd || process.cwd());
  const timeout = Number(params.timeout) || 30000;

  // Block dangerous patterns
  const dangerousPatterns = [
    "rm -rf",
    "rmdir /s",
    "del /f",
    "format",
    "mkfs",
    "dd if=",
    "shutdown",
    "reboot",
    "sudo rm",
    "chmod -R 777",
  ];

  for (const pattern of dangerousPatterns) {
    if (command.includes(pattern)) {
      return {
        success: false,
        error: `Blocked dangerous command pattern: "${pattern}". Use with explicit user approval via approvals system.`,
      };
    }
  }

  try {
    const { stdout, stderr } = await execPromise(command, {
      cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: process.env,
    });

    return {
      success: true,
      data: {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        command,
        cwd,
      },
      message: stderr ? `Command completed with warnings` : "Command completed successfully",
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Command execution failed",
      data: {
        stdout: error.stdout?.trim(),
        stderr: error.stderr?.trim(),
        code: error.code,
        signal: error.signal,
      },
    };
  }
}

async function handleSystemReadEnv(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const namesStr = String(params.names || "");
    const names = namesStr ? namesStr.split(",").map((n) => n.trim()).filter(Boolean) : [];
    const secrets = ["password", "secret", "key", "token", "auth", "credential", "private"];

    const maskValue = (name: string, value: string): string => {
      const lowerName = name.toLowerCase();
      if (secrets.some(s => lowerName.includes(s))) {
        return value ? `${value.substring(0, 3)}***REDACTED***` : "(empty)";
      }
      return value || "(empty)";
    };

    if (names.length > 0) {
      const result: Record<string, string> = {};
      const maskedNames: string[] = [];
      for (const name of names) {
        const masked = maskValue(name, process.env[name] || "");
        result[name] = masked;
        if (masked.includes("***REDACTED***")) maskedNames.push(name);
      }
      return {
        success: true,
        data: maskedNames.length > 0
          ? {
              values: result,
              _warning: `Values for [${maskedNames.join(", ")}] are masked for security. The returned strings are NOT the real values and CANNOT be used as API credentials. Do not pass them to any tool. Use the server's built-in configuration instead (omit the credential params from tool calls).`,
            }
          : result,
      };
    }

    // Return all env vars (secrets masked)
    const result: Record<string, string> = {};
    const maskedNames: string[] = [];
    for (const [key, value] of Object.entries(process.env)) {
      const masked = maskValue(key, value || "");
      result[key] = masked;
      if (masked.includes("***REDACTED***")) maskedNames.push(key);
    }

    return {
      success: true,
      data: {
        values: result,
        _warning: `${maskedNames.length} secret variable(s) are masked and cannot be used as credentials. Use the server's built-in configuration instead.`,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleSystemDiskUsage(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const pathMod = await import("path");

  try {
    const checkPath = String(params.path || process.cwd());

    // Windows-specific: use powershell for disk info
    if (process.platform === "win32") {
      const { exec } = await import("child_process");
      const util = await import("util");
      const execPromise = util.promisify(exec);

      const drive = pathMod.parse(checkPath).root || "C:";
      const { stdout } = await execPromise(
        `powershell -c "Get-PSDrive -Name '${drive.replace(":", "")}' | Select-Object Used,Free,Name | ConvertTo-Json"`
      );

      const driveInfo = JSON.parse(stdout.trim());
      const GB = 1024 * 1024 * 1024;
      const usedGB = Math.round((driveInfo.Used / GB) * 100) / 100;
      const freeGB = Math.round((driveInfo.Free / GB) * 100) / 100;
      const totalGB = usedGB + freeGB;

      return {
        success: true,
        data: {
          path: checkPath,
          drive: driveInfo.Name,
          usedGB,
          freeGB,
          totalGB,
          percentUsed: Math.round((usedGB / totalGB) * 100),
        },
      };
    }

    // Unix-like: use df
    const { exec } = await import("child_process");
    const util = await import("util");
    const execPromise = util.promisify(exec);

    const { stdout } = await execPromise(`df -h "${checkPath}" | tail -1`);
    const parts = stdout.trim().split(/\s+/);

    return {
      success: true,
      data: {
        path: checkPath,
        filesystem: parts[0],
        size: parts[1],
        used: parts[2],
        available: parts[3],
        percentUsed: parts[4],
        mount: parts[5],
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleSystemProcessInfo(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const { exec } = await import("child_process");
    const util = await import("util");
    const execPromise = util.promisify(exec);

    const filter = String(params.filter || "");

    if (process.platform === "win32") {
      const whereClause = filter ? `WHERE Name LIKE '%${filter}%'` : "";
      const { stdout } = await execPromise(
        `powershell -c "Get-CimInstance Win32_Process ${whereClause} | Select-Object ProcessId,ProcessName,CPU,WorkingSet | ConvertTo-Json"`
      );

      const processes = JSON.parse(stdout.trim());
      return {
        success: true,
        data: {
          platform: "windows",
          count: Array.isArray(processes) ? processes.length : 0,
          processes: (Array.isArray(processes) ? processes : [processes]).map((p: any) => ({
            pid: p.ProcessId,
            name: p.ProcessName,
            cpu: p.CPU,
            memoryKB: p.WorkingSet,
          })),
        },
      };
    }

    // Unix-like: use ps
    const cmd = filter ? `ps aux | grep -i "${filter}" | grep -v grep` : "ps aux";
    const { stdout } = await execPromise(cmd);

    const lines = stdout.trim().split("\n").filter(Boolean);
    const processes = lines.slice(1).map(line => {
      const parts = line.split(/\s+/);
      return {
        pid: parts[1],
        user: parts[0],
        cpu: parts[2],
        memory: parts[3],
        command: parts.slice(10).join(" "),
      };
    });

    return {
      success: true,
      data: {
        platform: "unix",
        count: processes.length,
        processes,
      },
    };
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

    const currentProvider = providerSettings.getCurrent();
    const result: Record<string, unknown> = {
      provider: {
        active: currentProvider.provider,
        model: currentProvider.model,
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
        openai: {
          key: env.OPENAI_API_KEY,
          url: env.OPENAI_API_URL,
        },
      };
      const info = providerKeyMap[currentProvider.provider] || providerKeyMap.opencode;
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

async function handleEngineeringTicketToTask(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const issueNumber = Number(params.issueNumber);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return { success: false, error: "issueNumber is required" };
    }

    const result = await ticketToTaskGenerator.generate({
      owner: (params.owner as string | undefined) || "",
      repo: (params.repo as string | undefined) || "",
      issueNumber,
      agent: params.agent as TicketToTaskAgent | undefined,
      includeComments: params.includeComments as boolean | undefined,
      includeRoadmap: params.includeRoadmap as boolean | undefined,
      includeCodebase: params.includeCodebase as boolean | undefined,
      maxCodebaseFiles: params.maxCodebaseFiles as number | undefined,
    });

    return {
      success: true,
      data: {
        prompt: result.body,
        metadata: result.metadata,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleTicketBridgeGeneratePrompt(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const sourceType = params.sourceType as string;
  const sourceId = params.sourceId as string;

  if (!sourceType || !sourceId) {
    return { success: false, error: "sourceType and sourceId are required" };
  }

  const validTypes = ["github", "jira", "roadmap"];
  if (!validTypes.includes(sourceType)) {
    return {
      success: false,
      error: `sourceType must be one of: ${validTypes.join(", ")}`,
    };
  }

  try {
    const generated = await ticketBridge.generatePrompt(
      { type: sourceType as "github" | "jira" | "roadmap", id: sourceId },
      {
        includeCodebaseIndex:
          (params.includeCodebaseIndex as boolean | undefined) ?? true,
        includeArchitecture:
          (params.includeArchitecture as boolean | undefined) ?? true,
        maxFiles: (params.maxFiles as number | undefined) ?? 10,
      },
    );
    return { success: true, data: generated };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Musician Tool Handlers
// ─────────────────────────────────────────────────────────────

async function handleMusicianExplainTheory(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const topic = params.topic as string;
    if (!topic) return { success: false, error: "topic is required" };

    const request = {
      topic,
      skillLevel: params.skillLevel as "beginner" | "intermediate" | "advanced" | "pro",
      instrument: params.instrument as string | undefined,
      style: params.style as string | undefined,
      includeExercises: params.includeExercises as boolean | undefined,
      includeExamples: params.includeExamples as boolean | undefined,
    };

    const result = await musicianService.explainTheory(request);
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleMusicianCompose(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const goal = params.goal as string;
    if (!goal) return { success: false, error: "goal is required" };

    const request = {
      goal,
      genre: params.genre as string | undefined,
      mood: params.mood as string | undefined,
      instrumentation: (params.instrumentation as string[] | undefined)?.map(
        (inst) => inst as string
      ),
      structure: params.structure as string | undefined,
      reference: params.reference as string | undefined,
      outputFormat: params.outputFormat as "markdown" | "lead_sheet" | "chord_chart" | "arrangement_plan" | "midi_plan",
    };

    const result = await musicianService.compose(request);
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleMusicianGenerateSample(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const prompt = params.prompt as string;
    if (!prompt) return { success: false, error: "prompt is required" };

    // Check if generation is enabled
    const isGenerationEnabled =
      process.env.MUSICIAN_GENERATION_ENABLED === "true";
    const dryRun =
      (params.dryRun as boolean | undefined) ??
      (!isGenerationEnabled ? true : undefined);

    const request = {
      prompt,
      durationSeconds: (params.durationSeconds as number | undefined) ?? 15,
      dryRun,
      genre: params.genre as string | undefined,
      mood: params.mood as string | undefined,
    };

    const result = await musicianService.generateSample(request);
    return { success: true, data: result, dryRun };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleMusicianAnalyzeAudio(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const filePath = params.fileId as string;
    if (!filePath) return { success: false, error: "fileId is required" };

    // Convert fileId to actual path (in production, this would look up the actual path)
    const actualPath = filePath.startsWith("/")
      ? filePath
      : `./audio-files/${filePath}`;

    const request = {
      filePath: actualPath,
      analysisType: params.analysisType as "mixdown" | "mastering" | "composition" | "arrangement" | "performance" | "transcription" | "all",
    };

    const result = await musicianService.analyzeAudio(request);
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleMusicianTranscribeAudio(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const fileId = params.fileId as string;
    if (!fileId) return { success: false, error: "fileId is required" };

    const filePath = fileId.startsWith("/")
      ? fileId
      : `./audio-files/${fileId}`;

    const outputDir = process.env.BASIC_PITCH_OUTPUT_DIR || "./transcriptions";
    const result = await musicianService.transcribeAudio(filePath, outputDir);
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleMusicianPracticePlan(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const instrument = params.instrument as string;
    if (!instrument) return { success: false, error: "instrument is required" };
    const goal = params.goal as string;
    if (!goal) return { success: false, error: "goal is required" };
    const skillLevel = params.skillLevel as
      | "beginner"
      | "intermediate"
      | "advanced"
      | "pro";
    if (!skillLevel) {
      return {
        success: false,
        error:
          "skillLevel is required (beginner, intermediate, advanced, pro)",
      };
    }
    const minutesPerDay = params.minutesPerDay as number;
    if (!minutesPerDay || minutesPerDay <= 0) {
      return { success: false, error: "minutesPerDay must be a positive number" };
    }
    const days = params.days as number;
    if (!days || days <= 0) {
      return { success: false, error: "days must be a positive number" };
    }

    const result = await musicianService.createPracticePlan({
      instrument,
      goal,
      skillLevel,
      minutesPerDay,
      days,
    });
    return { success: true, data: result };
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
        error: `File too large (${Math.round(stat.size / 1024)}KB). Use local.file_summary to see the file structure, local.read_section to read specific symbols, or local.file_chunks to read in sections.`,
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

async function handleLocalFileSummary(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const filePath = params.path as string;
  if (!filePath) return { success: false, error: "path is required" };

  const result = getFileSummary(filePath, PROJECT_ROOT);
  if ("error" in result) {
    return { success: false, error: result.error };
  }

  return { success: true, data: result };
}

async function handleLocalReadSection(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const filePath = params.path as string;
  if (!filePath) return { success: false, error: "path is required" };

  const result = readFileSection(filePath, PROJECT_ROOT, {
    symbol: params.symbol as string | undefined,
    startLine: params.startLine as number | undefined,
    endLine: params.endLine as number | undefined,
  });

  if ("error" in result) {
    return { success: false, error: result.error };
  }

  return { success: true, data: result };
}

async function handleLocalFileChunks(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const filePath = params.path as string;
  if (!filePath) return { success: false, error: "path is required" };

  const chunkSize = Math.min(Math.max((params.chunkSize as number) || 200, 50), 500);
  const chunkId = params.chunkId as number | undefined;

  const result = getFileChunks(filePath, PROJECT_ROOT, chunkSize, chunkId);
  if ("error" in result) {
    return { success: false, error: result.error };
  }

  return { success: true, data: result };
}

// Local file write/edit handlers
async function handleLocalWriteFile(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const fs = await import("fs");
  const pathMod = await import("path");

  const filePath = String(params.path || "");
  const content = String(params.content || "");

  if (!filePath) return { success: false, error: "path is required" };
  if (!content) return { success: false, error: "content is required" };

  try {
    const absolutePath = pathMod.isAbsolute(filePath)
      ? filePath
      : pathMod.join(PROJECT_ROOT, filePath);

    const dir = pathMod.dirname(absolutePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(absolutePath, content, "utf8");

    return {
      success: true,
      data: { path: absolutePath, bytesWritten: content.length },
      message: `Successfully wrote ${content.length} bytes`,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleLocalEditFile(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const fs = await import("fs");
  const pathMod = await import("path");

  const filePath = String(params.path || "");
  const oldString = String(params.old_string || "");
  const newString = String(params.new_string || "");
  const replaceAll = Boolean(params.replace_all);

  if (!filePath) return { success: false, error: "path is required" };
  if (!oldString) return { success: false, error: "old_string is required" };
  if (newString === undefined) return { success: false, error: "new_string is required" };

  try {
    const absolutePath = pathMod.isAbsolute(filePath)
      ? filePath
      : pathMod.join(PROJECT_ROOT, filePath);

    if (!fs.existsSync(absolutePath)) {
      return { success: false, error: `File not found: ${absolutePath}` };
    }

    const content = fs.readFileSync(absolutePath, "utf8");
    const occurrences = content.split(oldString).length - 1;

    if (occurrences === 0) {
      return { success: false, error: "old_string not found in file" };
    }

    if (occurrences > 1 && !replaceAll) {
      return {
        success: false,
        error: `Found ${occurrences} occurrences. Use replace_all: true to replace all, or make old_string more specific.`,
      };
    }

    const newContent = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    fs.writeFileSync(absolutePath, newContent, "utf8");

    return {
      success: true,
      data: { path: absolutePath, occurrences: replaceAll ? occurrences : 1 },
      message: `Successfully replaced ${replaceAll ? occurrences : 1} occurrence(s)`,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleLocalDeleteFile(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const fs = await import("fs");
  const pathMod = await import("path");

  const filePath = String(params.path || "");

  if (!filePath) return { success: false, error: "path is required" };

  try {
    const absolutePath = pathMod.isAbsolute(filePath)
      ? filePath
      : pathMod.join(PROJECT_ROOT, filePath);

    if (!fs.existsSync(absolutePath)) {
      return { success: false, error: `File not found: ${absolutePath}` };
    }

    fs.unlinkSync(absolutePath);

    return {
      success: true,
      data: { path: absolutePath },
      message: `Successfully deleted`,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleLocalListDir(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const fs = await import("fs");
  const pathMod = await import("path");

  const dirPath = String(params.path || PROJECT_ROOT);

  try {
    const absolutePath = pathMod.isAbsolute(dirPath)
      ? dirPath
      : pathMod.join(PROJECT_ROOT, dirPath);

    if (!fs.existsSync(absolutePath)) {
      return { success: false, error: `Directory not found: ${absolutePath}` };
    }

    const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
    const items = entries.map((entry) => {
      const fullPath = pathMod.join(absolutePath, entry.name);
      const stats = fs.statSync(fullPath);
      return {
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        size: stats.size,
        modified: stats.mtime.toISOString(),
      };
    });

    return {
      success: true,
      data: { path: absolutePath, items },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Git handlers
async function handleGitStatus(
  _params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const { exec } = await import("child_process");
  const util = await import("util");
  const execPromise = util.promisify(exec);

  try {
    const [statusResult, branchResult] = await Promise.all([
      execPromise("git status --porcelain"),
      execPromise("git branch --show-current"),
    ]);

    const statusLines = statusResult.stdout.trim().split("\n").filter(Boolean);
    const untracked: string[] = [];
    const staged: string[] = [];
    const unstaged: string[] = [];

    for (const line of statusLines) {
      const status = line.slice(0, 2);
      const file = line.slice(3);
      if (status.startsWith("??")) {
        untracked.push(file);
      } else if (status.startsWith("M ") || status.startsWith("A ") || status.startsWith("D ")) {
        staged.push(file);
      } else {
        unstaged.push(file);
      }
    }

    return {
      success: true,
      data: {
        branch: branchResult.stdout.trim(),
        untracked,
        staged,
        unstaged,
        hasChanges: untracked.length > 0 || staged.length > 0 || unstaged.length > 0,
      },
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Git status failed",
    };
  }
}

async function handleGitDiff(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const { exec } = await import("child_process");
  const util = await import("util");
  const execPromise = util.promisify(exec);

  const staged = Boolean(params.staged);
  const filePath = String(params.path || "");

  try {
    let cmd = staged ? "git diff --staged" : "git diff";
    if (filePath) cmd += ` -- "${filePath}"`;

    const { stdout } = await execPromise(cmd);

    return {
      success: true,
      data: {
        staged,
        path: filePath || null,
        diff: stdout.trim() || "(no changes)",
      },
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Git diff failed",
    };
  }
}

async function handleGitLog(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const { exec } = await import("child_process");
  const util = await import("util");
  const execPromise = util.promisify(exec);

  const limit = Number(params.limit) || 10;
  const branch = String(params.branch || "");

  try {
    const cmd = `git log -n ${limit} --oneline${branch ? ` ${branch}` : ""}`;
    const { stdout } = await execPromise(cmd);

    const commits = stdout.trim().split("\n").map((line) => {
      const [hash, ...message] = line.split(" ");
      return { hash, message: message.join(" ") };
    });

    return {
      success: true,
      data: { branch: branch || "current", commits },
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Git log failed",
    };
  }
}

async function handleGitAdd(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const { exec } = await import("child_process");
  const util = await import("util");
  const execPromise = util.promisify(exec);

  const files = params.files as string[];
  if (!files || files.length === 0) {
    return { success: false, error: "files array is required" };
  }

  try {
    const cmd = `git add ${files.map((f) => `"${f}"`).join(" ")}`;
    await execPromise(cmd);

    return {
      success: true,
      data: { files },
      message: `Successfully staged ${files.length} file(s)`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Git add failed",
    };
  }
}

async function handleGitCommit(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const { exec } = await import("child_process");
  const util = await import("util");
  const execPromise = util.promisify(exec);

  const message = String(params.message || "");
  const amend = Boolean(params.amend);

  if (!message) return { success: false, error: "message is required" };

  try {
    const cmd = `git commit${amend ? " --amend" : ""} -m ${JSON.stringify(message)}`;
    const { stdout } = await execPromise(cmd);

    const hashMatch = stdout.match(/\[([^\]]+)\s([a-f0-9]+)\]/);
    const branch = hashMatch ? hashMatch[1] : null;
    const hash = hashMatch ? hashMatch[2] : null;

    return {
      success: true,
      data: { branch, hash, message, amended: amend },
      message: amend ? "Successfully amended commit" : "Successfully committed",
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Git commit failed",
    };
  }
}

async function handleGitPush(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const { exec } = await import("child_process");
  const util = await import("util");
  const execPromise = util.promisify(exec);

  const remote = String(params.remote || "origin");
  const branch = String(params.branch || "");
  const force = Boolean(params.force);

  if (force) {
    return {
      success: false,
      error: "Force push requires approval via system.approve_action",
    };
  }

  try {
    let cmd = `git push ${remote}`;
    if (branch) cmd += ` ${branch}`;

    const { stdout } = await execPromise(cmd);

    return {
      success: true,
      data: { remote, branch, force },
      message: stdout.trim() || "Successfully pushed",
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Git push failed",
    };
  }
}

async function handleGitBranch(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const { exec } = await import("child_process");
  const util = await import("util");
  const execPromise = util.promisify(exec);

  const action = String(params.action || "");
  const name = String(params.name || "");

  if (!action) return { success: false, error: "action is required (list/create/checkout/delete)" };

  try {
    let cmd: string;
    let message: string;

    switch (action) {
      case "list":
        cmd = "git branch -a";
        const { stdout } = await execPromise(cmd);
        const branches = stdout.trim().split("\n").map((l) => l.trim());
        return { success: true, data: { branches } };
      case "create":
        if (!name) return { success: false, error: "name is required for create" };
        cmd = `git branch "${name}"`;
        await execPromise(cmd);
        message = `Created branch ${name}`;
        break;
      case "checkout":
        if (!name) return { success: false, error: "name is required for checkout" };
        cmd = `git checkout "${name}"`;
        await execPromise(cmd);
        message = `Switched to branch ${name}`;
        break;
      case "delete":
        if (!name) return { success: false, error: "name is required for delete" };
        cmd = `git branch -d "${name}"`;
        await execPromise(cmd);
        message = `Deleted branch ${name}`;
        break;
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }

    return {
      success: true,
      data: { action, name },
      message,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || `Git branch ${action} failed`,
    };
  }
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

async function handleAgentListRuns(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  try {
    const limitRaw = params.limit ? Number(params.limit) : undefined;
    const offsetRaw = params.offset ? Number(params.offset) : undefined;
    const limit = limitRaw != null && Number.isFinite(limitRaw) ? Math.min(Math.max(Math.round(limitRaw), 1), 100) : undefined;
    const offset = offsetRaw != null && Number.isFinite(offsetRaw) ? Math.max(Math.round(offsetRaw), 0) : undefined;

    const ALLOWED_STATUSES = ["running", "completed", "failed"] as const;
    const status = typeof params.status === "string" && ALLOWED_STATUSES.includes(params.status as typeof ALLOWED_STATUSES[number])
      ? params.status
      : undefined;

    // Always restrict to the requesting user's own runs (IDOR fix: no userId override)
    const result = agentRunDatabase.listRuns({
      status,
      userId,
      limit,
      offset,
    });
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: `Failed to list agent runs: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

async function handleAgentGetRun(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  try {
    const runId = params.runId;
    if (typeof runId !== "string" || !runId) return { success: false, error: "runId is required" };

    const run = agentRunDatabase.getRunWithSteps(runId);
    if (!run) return { success: false, error: `Run ${runId} not found` };

    // Only allow viewing your own runs — return generic "not found" to avoid
    // leaking existence of runs belonging to other users (IDOR protection)
    if (run.userId !== userId) {
      return { success: false, error: `Run ${runId} not found` };
    }

    return { success: true, data: run };
  } catch (error) {
    return {
      success: false,
      error: `Failed to get agent run: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

async function handleAgentGetRunStats(
  _params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  try {
    // Return user-scoped stats, not global aggregates.
    // Global stats leak information about other users' activity volumes.
    const userRuns = agentRunDatabase.listRuns({ userId, limit: 1000 });
    const runsList = userRuns.runs;
    const completed = runsList.filter((r) => r.status === "completed");
    const totalToolLoops = completed.reduce((sum, r) => sum + r.toolLoopCount, 0);

    return {
      success: true,
      data: {
        totalRuns: userRuns.total,
        completedRuns: completed.length,
        failedRuns: runsList.filter((r) => r.status === "failed").length,
        runningRuns: runsList.filter((r) => r.status === "running").length,
        avgToolLoopCount: completed.length > 0 ? totalToolLoops / completed.length : 0,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to get agent run stats: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

function stripSensitiveFields(obj: AgentRun): Omit<AgentRun, "sessionId" | "promptTokens" | "completionTokens" | "totalTokens"> {
  const { sessionId, promptTokens, completionTokens, totalTokens, ...rest } = obj;
  return rest;
}

async function handleAgentGetAicoderStatus(
  _params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  try {
    // Only return summary data for aicoder runs (no step content to avoid exposing prompts/responses)
    const runs = agentRunDatabase.listRuns({ userId: "aicoder", limit: 5 });
    if (!runs.runs.length) {
      return { success: true, data: { runs: [], current: null } };
    }
    const current = runs.runs.find((r) => r.status === "running");
    const latest = runs.runs[0];
    const targetRun = current || latest;

    if (!targetRun) {
      return { success: true, data: { runs: runs.runs.map(stripSensitiveFields), current: null } };
    }

    // Return run metadata only — exclude step content AND sensitive fields for security.
    // Use data already available from listRuns rather than fetching step details.
    // Use agent.get_run for step-level details.
    const safeCurrent = stripSensitiveFields(targetRun);

    return {
      success: true,
      data: {
        runs: runs.runs.map(stripSensitiveFields),
        current: safeCurrent,
        requestingUser: userId,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to get aicoder status: ${error instanceof Error ? error.message : "Unknown error"}`,
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
  if (params.dryRun === true) {
    return { success: true, dryRun: true, data: dryRunResult({
      toolName: "work_items.create",
      summary: `Would create work item "${params.title}" of type ${params.type}`,
      targetSystem: "work_items",
      changes: [
        { field: "work_item", description: `Create new ${params.type || "task"} "${params.title}"` },
        ...(params.description ? [{ field: "description" as const, to: params.description as string, description: "Set description" }] : []),
        ...(params.priority ? [{ field: "priority" as const, to: params.priority as string, description: "Set priority" }] : []),
        ...(params.owner ? [{ field: "owner" as const, to: params.owner as string, description: "Set owner" }] : []),
      ],
      riskLevel: "low",
      paramsPreview: { type: params.type, title: params.title, priority: params.priority, owner: params.owner },
    }) };
  }
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
  if (params.dryRun === true) {
    return { success: true, dryRun: true, data: dryRunResult({
      toolName: "jitbit.add_ticket_comment",
      summary: `Would add comment to Jitbit ticket #${params.ticketId}`,
      targetSystem: "jitbit",
      changes: [
        { field: "comment", to: params.body as string, description: "Add comment to ticket" },
        ...(params.forTechsOnly ? [{ field: "forTechsOnly" as const, to: String(params.forTechsOnly), description: "Set as technician-only" }] : []),
      ],
      riskLevel: "low",
      paramsPreview: { ticketId: params.ticketId, body: params.body, forTechsOnly: params.forTechsOnly },
    }) };
  }
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

async function handleJitbitSearchAssets(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const query = params.query as string;
  if (!query) return { success: false, error: "query is required" };
  const data = await jitbitService.searchAssets(query);
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
    data: Buffer.from(params.data as string, "base64"),
  });
  return { success: true, data };
}

async function handleJitbitGetAttachment(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const attachmentId = params.attachmentId as number;
  if (!attachmentId) return { success: false, error: "attachmentId is required" };
  const data = await jitbitService.getAttachment(attachmentId);
  return { success: true, data };
}

async function handleJitbitDeleteAttachment(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const attachmentId = params.attachmentId as number;
  if (!attachmentId) return { success: false, error: "attachmentId is required" };
  const data = await jitbitService.deleteAttachment(attachmentId);
  return { success: true, data };
}

async function handleJitbitSummarizeTicket(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ticketId = params.ticketId as number;
  if (!ticketId) return { success: false, error: "ticketId is required" };
  const data = await jitbitService.summarizeTicketForAssistant(ticketId);
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

async function handleJitbitGetAutomationRule(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ruleId = params.ruleId as number;
  if (!ruleId) return { success: false, error: "ruleId is required" };
  const data = await jitbitService.getAutomationRule(ruleId);
  return { success: true, data };
}

async function handleJitbitEnableAutomationRule(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ruleId = params.ruleId as number;
  if (!ruleId) return { success: false, error: "ruleId is required" };
  const data = await jitbitService.enableAutomationRule(ruleId);
  return { success: true, data };
}

async function handleJitbitDisableAutomationRule(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jitbitService.isConfigured()) {
    return { success: false, error: "Jitbit client not configured" };
  }
  const ruleId = params.ruleId as number;
  if (!ruleId) return { success: false, error: "ruleId is required" };
  const data = await jitbitService.disableAutomationRule(ruleId);
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
    offset: params.offset as number | undefined,
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

async function handleHawkIrGetEscalatedCases(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const data = await hawkIrService.getEscalatedCases({
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

async function handleHawkIrAddCaseNote(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const caseId = params.caseId as string;
  const body = params.body as string;
  if (!caseId) return { success: false, error: "caseId is required" };
  if (!body) return { success: false, error: "body is required" };
  const data = await hawkIrService.addCaseNote(caseId, body);
  return { success: true, data };
}

async function handleHawkIrUpdateCaseStatus(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const caseId = params.caseId as string;
  const status = params.status as string;
  if (!caseId) return { success: false, error: "caseId is required" };
  if (!status) return { success: false, error: "status is required" };
  const data = await hawkIrService.updateCaseStatus(caseId, status);
  const comment = params.comment as string | undefined;
  if (comment) {
    await hawkIrService.addCaseNote(caseId, comment);
  }
  return { success: true, data };
}

async function handleHawkIrUpdateCaseRisk(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const caseId = params.caseId as string;
  const riskLevel = params.riskLevel as string;
  if (!caseId) return { success: false, error: "caseId is required" };
  if (!riskLevel) return { success: false, error: "riskLevel is required" };
  const data = await hawkIrService.updateCaseRisk(caseId, riskLevel);
  const reason = params.reason as string | undefined;
  if (reason) {
    await hawkIrService.addCaseNote(caseId, `Risk level changed to ${riskLevel}: ${reason}`);
  }
  return { success: true, data };
}

async function handleHawkIrEscalateCase(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const caseId = params.caseId as string;
  const type = params.type as string;
  if (!caseId) return { success: false, error: "caseId is required" };
  if (!type) return { success: false, error: "type is required" };
  const vendor = params.vendor as string | undefined;
  const ticketId = params.ticketId as string | undefined;
  const data = await hawkIrService.escalateCase(caseId, type, vendor, ticketId);
  const comment = params.comment as string | undefined;
  if (comment) {
    await hawkIrService.addCaseNote(caseId, comment);
  }
  return { success: true, data };
}

async function handleHawkIrAssignCase(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const caseId = params.caseId as string;
  const ownerId = params.ownerId as string;
  if (!caseId) return { success: false, error: "caseId is required" };
  if (!ownerId) return { success: false, error: "ownerId is required" };
  const data = await hawkIrService.assignCase(caseId, ownerId);
  const comment = params.comment as string | undefined;
  if (comment) {
    await hawkIrService.addCaseNote(caseId, comment);
  }
  return { success: true, data };
}

async function handleHawkIrMergeCases(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const sourceCaseId = params.sourceCaseId as string;
  const targetCaseId = params.targetCaseId as string;
  if (!sourceCaseId) return { success: false, error: "sourceCaseId is required" };
  if (!targetCaseId) return { success: false, error: "targetCaseId is required" };
  const data = await hawkIrService.mergeCases(sourceCaseId, targetCaseId);
  return { success: true, data };
}

async function handleHawkIrRenameCase(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const caseId = params.caseId as string;
  const name = params.name as string;
  if (!caseId) return { success: false, error: "caseId is required" };
  if (!name) return { success: false, error: "name is required" };
  const data = await hawkIrService.renameCase(caseId, name);
  return { success: true, data };
}

async function handleHawkIrUpdateCaseDetails(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const caseId = params.caseId as string;
  const details = params.details as string;
  if (!caseId) return { success: false, error: "caseId is required" };
  if (!details) return { success: false, error: "details is required" };
  const data = await hawkIrService.updateCaseDetails(caseId, details);
  return { success: true, data };
}

async function handleHawkIrSetCaseCategories(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const caseId = params.caseId as string;
  const categories = params.categories as string[];
  if (!caseId) return { success: false, error: "caseId is required" };
  if (!Array.isArray(categories)) {
    return { success: false, error: "categories must be an array" };
  }
  const data = await hawkIrService.setCaseCategories(caseId, categories);
  return { success: true, data };
}

async function handleHawkIrAddIgnoreLabel(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const label = params.label as string;
  if (!label) return { success: false, error: "label is required" };
  const data = await hawkIrService.addIgnoreLabel(label, params.category as string | undefined);
  return { success: true, data };
}

async function handleHawkIrDeleteIgnoreLabel(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const labelId = params.labelId as string;
  if (!labelId) return { success: false, error: "labelId is required" };
  const data = await hawkIrService.deleteIgnoreLabel(labelId);
  return { success: true, data };
}

async function handleHawkIrGetCaseCategories(): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const data = await hawkIrService.getCaseCategories();
  return { success: true, data };
}

async function handleHawkIrGetCaseLabels(): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const data = await hawkIrService.getCaseLabels();
  return { success: true, data };
}

async function handleHawkIrQuarantineHost(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const caseId = params.caseId as string;
  const target = params.target as string;
  if (!caseId) return { success: false, error: "caseId is required" };
  if (!target) return { success: false, error: "target is required" };
  const options: { type?: string; expires?: string } = {};
  if (params.type) options.type = params.type as string;
  if (params.expires) options.expires = params.expires as string;
  const data = await hawkIrService.quarantineHost(caseId, target, options);
  return { success: true, data };
}

async function handleHawkIrUnquarantineHost(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const caseId = params.caseId as string;
  const target = params.target as string;
  if (!caseId) return { success: false, error: "caseId is required" };
  if (!target) return { success: false, error: "target is required" };
  const data = await hawkIrService.unquarantineHost(caseId, target);
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

async function handleHawkIrGetFields(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const idx = params.idx as string;
  if (!idx) return { success: false, error: "idx (index name) is required" };
  const data = await hawkIrService.getFields(idx);
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

async function handleHawkIrRunDashboardQuery(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const from = params.from as string;
  if (!from) return { success: false, error: "from is required" };
  const data = await hawkIrService.runDashboardQuery({
    from,
    to: params.to as string | undefined,
    query: params.query as string | undefined,
    index: params.index as string | undefined,
    type: params.type as "table" | "bar" | "line" | "pie" | "count" | "metric" | undefined,
    columns: params.columns as string[] | undefined,
    groupBy: params.groupBy as string[] | undefined,
    metrics: params.metrics as { field: string; operator: string }[] | undefined,
    size: params.size as number | undefined,
    sort: params.sort as { field: string; direction: "asc" | "desc" } | undefined,
    pagination: params.pagination as { limit?: number; offset?: number; page?: number } | undefined,
  });
  return { success: true, data };
}

async function handleHawkIrWeeklyReport(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const data = await hawkIrService.weeklyReport({
    query: params.query as string | undefined,
    index: params.index as string | undefined,
    columns: params.columns as string[] | undefined,
    groupBy: params.groupBy as string[] | undefined,
    metrics: params.metrics as { field: string; operator: string }[] | undefined,
    size: params.size as number | undefined,
  });
  return { success: true, data };
}

async function handleHawkIrMonthlySummary(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const data = await hawkIrService.monthlySummary({
    query: params.query as string | undefined,
    index: params.index as string | undefined,
    columns: params.columns as string[] | undefined,
    groupBy: params.groupBy as string[] | undefined,
    metrics: params.metrics as { field: string; operator: string }[] | undefined,
  });
  return { success: true, data };
}

async function handleHawkIrGetCaseCount(
  _params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const data = await hawkIrService.getCaseCount();
  return { success: true, data: { count: data } };
}

async function handleHawkIrGetRecentCases(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const limit = (params.limit as number) ?? 20;
  const offset = (params.offset as number) ?? 0;
  const data = await hawkIrService.getRecentCases(limit, offset);
  return { success: true, data };
}

async function handleHawkIrGetLogHistogram(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const q = params.q as string;
  if (!q) return { success: false, error: "q (search query) is required" };
  const data = await hawkIrService.getLogHistogram({
    q,
    idx: params.idx as string | undefined,
    from: params.from as string | undefined,
    to: params.to as string | undefined,
    interval: params.interval as string | undefined,
  });
  return { success: true, data };
}

async function handleHawkIrGetSavedSearches(
  _params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const data = await hawkIrService.getSavedSearches();
  return { success: true, data };
}

async function handleHawkIrGetArtefacts(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const data = await hawkIrService.getArtefacts({ asset: params.asset as string | undefined });
  return { success: true, data };
}

async function handleHawkIrExecuteHybridTool(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!hawkIrService.isConfigured()) {
    return { success: false, error: "HAWK IR client not configured" };
  }
  const groupId = params.groupId as string;
  const cmd = params.cmd as string;
  if (!groupId || !cmd) return { success: false, error: "groupId and cmd are required" };
  const data = await hawkIrService.executeHybridTool({
    groupId,
    cmd,
    data: params.data,
    targetNodeId: params.targetNodeId as string | undefined,
    timeoutMs: params.timeoutMs as number | undefined,
  });
  return { success: true, data };
}

// ── Tenable Cloud Handlers ──────────────────────────────────────────────────

// Tracks export completeness per export UUID so chunk download responses can
// report progress and warn when reports would be based on partial data.
const exportTracker = new Map<string, { totalChunks: number; downloadedChunks: Set<number> }>();

function tenableOpts(params: Record<string, unknown>) {
  const accessKey = params.accessKey as string | undefined;
  const secretKey = params.secretKey as string | undefined;
  return accessKey || secretKey ? { accessKey, secretKey } : undefined;
}

function tenableConfigCheck(params: Record<string, unknown>): string | null {
  const accessKey = params.accessKey as string | undefined;
  const secretKey = params.secretKey as string | undefined;
  if (accessKey?.includes("***REDACTED***") || secretKey?.includes("***REDACTED***")) {
    return "Redacted credentials detected. system.read_env masks secret values for security — the returned value is NOT the real key and cannot be used for API calls. To query Tenable: either omit accessKey/secretKey and use the server's configured credentials, or ask the user to provide the actual key value directly.";
  }
  if (!tenableCloudService.isConfigured(tenableOpts(params))) {
    return "Tenable Cloud not configured. Set TENABLE_CLOUD_ACCESS_KEY and TENABLE_CLOUD_SECRET_KEY, or pass accessKey/secretKey params.";
  }
  return null;
}

function tenableSeverityLabel(vuln: any): string {
  const risk = String(vuln?.plugin?.risk_factor ?? "").toLowerCase();
  if (risk) return risk === "medium" ? "moderate" : risk;
  const severity = Number(vuln?.severity_id ?? vuln?.severity ?? 0);
  if (severity >= 4) return "critical";
  if (severity === 3) return "high";
  if (severity === 2) return "moderate";
  if (severity === 1) return "low";
  return "info";
}

function tenableAssetName(asset: any): string {
  const first = (value: unknown): string | undefined =>
    Array.isArray(value) ? value.find((v) => typeof v === "string") : typeof value === "string" ? value : undefined;
  return (
    first(asset?.hostname) ??
    first(asset?.fqdn) ??
    asset?.hostname ??
    asset?.netbios_name ??
    first(asset?.ipv4) ??
    first(asset?.asset?.fqdn) ??
    asset?.asset?.hostname ??
    first(asset?.asset?.ipv4) ??
    asset?.id ??
    asset?.asset?.id ??
    "unknown"
  );
}

function summarizeTenableVulnerabilities(vulnerabilities: any[]) {
  const severityCounts: Record<string, number> = {
    critical: 0,
    high: 0,
    moderate: 0,
    low: 0,
    info: 0,
  };
  const hosts = new Map<string, {
    host: string;
    critical: number;
    high: number;
    moderate: number;
    low: number;
    info: number;
    exploitAvailable: number;
    score: number;
    topVulnerabilities: Map<number, { pluginId: number; name: string; severity: string; count: number }>;
  }>();
  const plugins = new Map<number, { pluginId: number; name: string; severity: string; count: number; solution?: string }>();

  for (const vuln of vulnerabilities) {
    const severity = tenableSeverityLabel(vuln);
    severityCounts[severity] = (severityCounts[severity] ?? 0) + 1;
    const pluginId = Number(vuln?.plugin?.id ?? 0);
    const pluginName = String(vuln?.plugin?.name ?? "Unknown plugin");
    const solution = typeof vuln?.plugin?.solution === "string" ? vuln.plugin.solution.slice(0, 500) : undefined;
    const plugin = plugins.get(pluginId) ?? { pluginId, name: pluginName, severity, count: 0, solution };
    plugin.count += 1;
    plugins.set(pluginId, plugin);

    const host = tenableAssetName(vuln);
    const hostStats = hosts.get(host) ?? {
      host,
      critical: 0,
      high: 0,
      moderate: 0,
      low: 0,
      info: 0,
      exploitAvailable: 0,
      score: 0,
      topVulnerabilities: new Map(),
    };
    if (severity === "critical") hostStats.critical += 1;
    else if (severity === "high") hostStats.high += 1;
    else if (severity === "moderate") hostStats.moderate += 1;
    else if (severity === "low") hostStats.low += 1;
    else hostStats.info += 1;
    if (vuln?.plugin?.exploit_available) hostStats.exploitAvailable += 1;
    hostStats.score +=
      severity === "critical" ? 100 :
      severity === "high" ? 25 :
      severity === "moderate" ? 5 :
      severity === "low" ? 1 :
      0;
    if (pluginId) {
      const hostPlugin = hostStats.topVulnerabilities.get(pluginId) ?? { pluginId, name: pluginName, severity, count: 0 };
      hostPlugin.count += 1;
      hostStats.topVulnerabilities.set(pluginId, hostPlugin);
    }
    hosts.set(host, hostStats);
  }

  const hostsByPriority = Array.from(hosts.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map((host) => ({
      host: host.host,
      score: host.score,
      critical: host.critical,
      high: host.high,
      moderate: host.moderate,
      low: host.low,
      info: host.info,
      exploitAvailable: host.exploitAvailable,
      topVulnerabilities: Array.from(host.topVulnerabilities.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 3),
    }));

  return {
    total: vulnerabilities.length,
    severityCounts,
    affectedHostCount: hosts.size,
    topHostsToPatchFirst: hostsByPriority,
    topVulnerabilities: Array.from(plugins.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 15),
  };
}

function summarizeTenableAssets(assets: any[]) {
  const deviceTypes: Record<string, number> = {};
  const operatingSystems: Record<string, number> = {};
  let withPluginResults = 0;
  let licensed = 0;
  let authenticated = 0;

  for (const asset of assets) {
    if (asset?.has_plugin_results) withPluginResults += 1;
    if (asset?.last_licensed_scan_date) licensed += 1;
    if (asset?.last_authenticated_scan_date) authenticated += 1;
    const deviceType = Array.isArray(asset?.device_type) ? asset.device_type[0] : asset?.device_type;
    if (deviceType) deviceTypes[String(deviceType)] = (deviceTypes[String(deviceType)] ?? 0) + 1;
    const osName = Array.isArray(asset?.operating_system) ? asset.operating_system[0] : asset?.operating_system;
    if (osName) operatingSystems[String(osName)] = (operatingSystems[String(osName)] ?? 0) + 1;
  }

  const topCounts = (counts: Record<string, number>) =>
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, count]) => ({ name, count }));

  return {
    total: assets.length,
    withPluginResults,
    authenticated,
    licensed,
    topDeviceTypes: topCounts(deviceTypes),
    topOperatingSystems: topCounts(operatingSystems),
  };
}

/** Poll a Tenable export job until FINISHED, then download all chunks. */
async function runTenableExportPipeline<T>(
  _exportUuid: string,
  getStatus: () => Promise<TenableExportStatus>,
  downloadChunk: (chunkId: number) => Promise<T[]>,
  opts: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<{ items: T[]; chunksDownloaded: number; totalChunks: number; elapsedMs: number }> {
  const pollInterval = opts.pollIntervalMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const startTime = Date.now();

  while (true) {
    const status = await getStatus();
    if (status.status === "FINISHED") {
      const chunks = status.chunks_available ?? [];
      const items: T[] = [];
      for (const chunkId of chunks) {
        const chunkItems = await downloadChunk(chunkId);
        items.push(...chunkItems);
      }
      return {
        items,
        chunksDownloaded: chunks.length,
        totalChunks: chunks.length,
        elapsedMs: Date.now() - startTime,
      };
    }
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Export timed out after ${timeoutMs / 1000}s. Last status: ${status.status}`);
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
}

async function handleTenableListVulnerabilities(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const opts = tenableOpts(params);

  // Map date_range (days) to since (unix timestamp) for the export API
  let since: number | undefined;
  const dateRange = params.date_range as number | undefined;
  if (dateRange) {
    since = Math.floor(Date.now() / 1000) - dateRange * 24 * 60 * 60;
  }

  // Start async export — this returns every vulnerability, not just the 5,000 workbench limit
  const { export_uuid } = await tenableCloudService.exportVulnerabilities(
    { since, severity: params.severity as any, state: params.state as string[] | undefined, plugin_id: params.plugin_id as number[] | undefined, tag: params.tag as any },
    opts,
  );

  try {
    const result = await runTenableExportPipeline(
      export_uuid,
      () => tenableCloudService.getVulnExportStatus(export_uuid, opts),
      (chunkId) => tenableCloudService.downloadVulnExportChunk(export_uuid, chunkId, opts),
    );

    return {
      success: true,
      data: {
        summary: summarizeTenableVulnerabilities(result.items),
        export_uuid,
        chunks_downloaded: result.chunksDownloaded,
        total_vulnerabilities: result.items.length,
        elapsed_seconds: Math.round(result.elapsedMs / 1000),
        _guidance: `Comprehensive vulnerability export complete: ${result.items.length} vulnerabilities across ${result.chunksDownloaded} chunk(s).`,
      },
    };
  } catch (pipelineErr) {
    const message = pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr);
    return { success: false, error: `Vulnerability export failed: ${message}` };
  }
}

async function handleTenableGetVulnerabilityDetails(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const pluginId = params.plugin_id as number;
  if (!pluginId) return { success: false, error: "plugin_id is required" };
  const data = await tenableCloudService.getVulnerabilityDetails(pluginId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableExportVulnerabilities(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.exportVulnerabilities({
    since: params.since as number | undefined,
    severity: params.severity as any,
    state: params.state as string[] | undefined,
    plugin_id: params.plugin_id as number[] | undefined,
    tag: params.tag as any,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetVulnExportStatus(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const exportUuid = params.export_uuid as string;
  if (!exportUuid) return { success: false, error: "export_uuid is required" };
  const status = await tenableCloudService.getVulnExportStatus(exportUuid, tenableOpts(params));
  const chunksAvailable = status.chunks_available ?? [];
  const totalChunks = chunksAvailable.length;
  // Register/update tracker so download handler can report progress
  if (status.status === "FINISHED" && totalChunks > 0) {
    if (!exportTracker.has(exportUuid)) {
      exportTracker.set(exportUuid, { totalChunks, downloadedChunks: new Set() });
    } else {
      exportTracker.get(exportUuid)!.totalChunks = totalChunks;
    }
  }
  const tracker = exportTracker.get(exportUuid);
  const downloadedCount = tracker?.downloadedChunks.size ?? 0;
  const remainingChunks = chunksAvailable.filter(id => !tracker?.downloadedChunks.has(id));
  let guidance: string;
  if (status.status === "FINISHED") {
    if (downloadedCount === 0) {
      guidance = `Export finished. ${totalChunks} chunk(s) to download: [${chunksAvailable.join(", ")}]. Download ALL ${totalChunks} chunk(s) with tenable.download_vuln_export_chunk before writing any report.`;
    } else if (remainingChunks.length > 0) {
      guidance = `Export finished. Progress: ${downloadedCount}/${totalChunks} chunks downloaded. Still need: [${remainingChunks.join(", ")}]. Do NOT write a report until all ${totalChunks} chunks are downloaded.`;
    } else {
      guidance = `Export finished. All ${totalChunks} chunks downloaded. Data is complete — you may now summarize.`;
    }
  } else if (status.status === "PROCESSING") {
    guidance = `Export is still processing. Poll again in a few seconds.`;
  } else {
    guidance = `Export status: ${status.status}.`;
  }
  return {
    success: true,
    data: {
      ...status,
      total_chunks: totalChunks,
      chunks_downloaded: downloadedCount,
      chunks_remaining: remainingChunks.length,
      all_chunks_downloaded: downloadedCount === totalChunks && totalChunks > 0,
      _guidance: guidance,
    },
  };
}

async function handleTenableDownloadVulnExportChunk(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const exportUuid = params.export_uuid as string;
  const chunkId = params.chunk_id as number;
  if (!exportUuid) return { success: false, error: "export_uuid is required" };
  if (chunkId === undefined) return { success: false, error: "chunk_id is required" };
  const vulns = await tenableCloudService.downloadVulnExportChunk(exportUuid, chunkId, tenableOpts(params));
  // Record this chunk as downloaded
  if (!exportTracker.has(exportUuid)) {
    exportTracker.set(exportUuid, { totalChunks: 0, downloadedChunks: new Set() });
  }
  const tracker = exportTracker.get(exportUuid)!;
  tracker.downloadedChunks.add(chunkId);
  const downloadedCount = tracker.downloadedChunks.size;
  const totalChunks = tracker.totalChunks;
  const remaining = totalChunks > 0 ? totalChunks - downloadedCount : null;
  const allDone = totalChunks > 0 && downloadedCount >= totalChunks;
  let guidance: string;
  if (allDone) {
    guidance = `All ${totalChunks} chunks downloaded. Dataset is complete — you may now summarize.`;
  } else if (totalChunks > 0) {
    guidance = `Progress: ${downloadedCount}/${totalChunks} chunks downloaded (${remaining} remaining). Do NOT write a report until all ${totalChunks} chunks are downloaded.`;
  } else {
    guidance = `Chunk ${chunkId} downloaded. Call tenable.get_vuln_export_status to see total chunk count, then download all remaining chunks before summarizing.`;
  }
  return {
    success: true,
    data: {
      chunk_id: chunkId,
      count: vulns.length,
      chunks_downloaded: downloadedCount,
      total_chunks: totalChunks > 0 ? totalChunks : "unknown — call get_vuln_export_status",
      chunks_remaining: remaining,
      all_chunks_downloaded: allDone,
      summary: summarizeTenableVulnerabilities(vulns),
      _guidance: guidance,
    },
  };
}

async function handleTenableListWorkbenchAssets(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const opts = tenableOpts(params);

  // Start async asset export — returns every asset, not just the 5,000 workbench limit
  const { export_uuid } = await tenableCloudService.exportAssets(
    { chunk_size: params.chunk_size as number | undefined },
    opts,
  );

  try {
    const result = await runTenableExportPipeline(
      export_uuid,
      () => tenableCloudService.getAssetExportStatus(export_uuid, opts),
      (chunkId) => tenableCloudService.downloadAssetExportChunk(export_uuid, chunkId, opts),
    );

    return {
      success: true,
      data: {
        summary: summarizeTenableAssets(result.items),
        export_uuid,
        chunks_downloaded: result.chunksDownloaded,
        total_assets: result.items.length,
        elapsed_seconds: Math.round(result.elapsedMs / 1000),
        _guidance: `Comprehensive asset export complete: ${result.items.length} assets across ${result.chunksDownloaded} chunk(s).`,
      },
    };
  } catch (pipelineErr) {
    const message = pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr);
    return { success: false, error: `Asset export failed: ${message}` };
  }
}

async function handleTenableGetAssetVulnerabilities(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const assetId = params.asset_id as string;
  if (!assetId) return { success: false, error: "asset_id is required" };
  const data = await tenableCloudService.getAssetVulnerabilities(assetId, {
    date_range: params.date_range as number | undefined,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableListAssets(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listAssets(tenableOpts(params));
  return { success: true, data: { summary: summarizeTenableAssets(data), total_assets: data.length } };
}

async function handleTenableGetAsset(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const assetId = params.asset_id as string;
  if (!assetId) return { success: false, error: "asset_id is required" };
  const data = await tenableCloudService.getAsset(assetId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableDeleteAsset(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const assetId = params.asset_id as string;
  if (!assetId) return { success: false, error: "asset_id is required" };
  await tenableCloudService.deleteAsset(assetId, tenableOpts(params));
  return { success: true, data: { deleted: assetId } };
}

async function handleTenableImportAssets(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const assets = params.assets as unknown[];
  if (!Array.isArray(assets) || assets.length === 0) return { success: false, error: "assets must be a non-empty array" };
  const data = await tenableCloudService.importAssets(assets, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableExportAssets(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.exportAssets({
    chunk_size: params.chunk_size as number | undefined,
    filters: {
      has_plugin_results: params.has_plugin_results as boolean | undefined,
      tag: params.tag as any,
    },
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetAssetExportStatus(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const exportUuid = params.export_uuid as string;
  if (!exportUuid) return { success: false, error: "export_uuid is required" };
  const data = await tenableCloudService.getAssetExportStatus(exportUuid, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableDownloadAssetExportChunk(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const exportUuid = params.export_uuid as string;
  const chunkId = params.chunk_id as number;
  if (!exportUuid) return { success: false, error: "export_uuid is required" };
  if (chunkId === undefined) return { success: false, error: "chunk_id is required" };
  const data = await tenableCloudService.downloadAssetExportChunk(exportUuid, chunkId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableBulkDeleteAssets(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.query) return { success: false, error: "query is required" };
  const data = await tenableCloudService.bulkDeleteAssets(params.query, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableListScans(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listScans({
    folder_id: params.folder_id as number | undefined,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetScan(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const scanId = params.scan_id as number;
  if (!scanId) return { success: false, error: "scan_id is required" };
  const data = await tenableCloudService.getScan(scanId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableCreateScan(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.template_uuid) return { success: false, error: "template_uuid is required" };
  if (!params.name) return { success: false, error: "name is required" };
  const settings: Record<string, unknown> = {
    template_uuid: params.template_uuid,
    name: params.name,
    description: params.description,
    text_targets: params.targets,
    policy_id: params.policy_id,
    scanner_id: params.scanner_id,
    enabled: params.schedule_enabled,
  };
  const data = await tenableCloudService.createScan(settings, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableUpdateScan(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const scanId = params.scan_id as number;
  if (!scanId) return { success: false, error: "scan_id is required" };
  const settings: Record<string, unknown> = {};
  if (params.name !== undefined) settings.name = params.name;
  if (params.description !== undefined) settings.description = params.description;
  if (params.targets !== undefined) settings.text_targets = params.targets;
  if (params.enabled !== undefined) settings.enabled = params.enabled;
  const data = await tenableCloudService.updateScan(scanId, settings, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableDeleteScan(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const scanId = params.scan_id as number;
  if (!scanId) return { success: false, error: "scan_id is required" };
  await tenableCloudService.deleteScan(scanId, tenableOpts(params));
  return { success: true, data: { deleted: scanId } };
}

async function handleTenableLaunchScan(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const scanId = params.scan_id as number;
  if (!scanId) return { success: false, error: "scan_id is required" };
  const data = await tenableCloudService.launchScan(scanId, params.alt_targets as string[] | undefined, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableStopScan(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const scanId = params.scan_id as number;
  if (!scanId) return { success: false, error: "scan_id is required" };
  await tenableCloudService.stopScan(scanId, tenableOpts(params));
  return { success: true, data: { stopped: scanId } };
}

async function handleTenablePauseScan(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const scanId = params.scan_id as number;
  if (!scanId) return { success: false, error: "scan_id is required" };
  await tenableCloudService.pauseScan(scanId, tenableOpts(params));
  return { success: true, data: { paused: scanId } };
}

async function handleTenableResumeScan(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const scanId = params.scan_id as number;
  if (!scanId) return { success: false, error: "scan_id is required" };
  await tenableCloudService.resumeScan(scanId, tenableOpts(params));
  return { success: true, data: { resumed: scanId } };
}

async function handleTenableCopyScan(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const scanId = params.scan_id as number;
  if (!scanId) return { success: false, error: "scan_id is required" };
  const data = await tenableCloudService.copyScan(scanId, params.folder_id as number | undefined, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableExportScan(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const scanId = params.scan_id as number;
  if (!scanId) return { success: false, error: "scan_id is required" };
  const data = await tenableCloudService.exportScan(scanId, params.format as string | undefined, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableImportScan(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const file = params.file as string;
  if (!file) return { success: false, error: "file is required" };
  const data = await tenableCloudService.importScan(file, params.folder_id as number | undefined, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetScanHistory(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const scanId = params.scan_id as number;
  if (!scanId) return { success: false, error: "scan_id is required" };
  const data = await tenableCloudService.getScanHistory(scanId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableListScanTemplates(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listScanTemplates(tenableOpts(params));
  return { success: true, data };
}

async function handleTenableListPolicies(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listPolicies(tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetPolicy(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const policyId = params.policy_id as number;
  if (!policyId) return { success: false, error: "policy_id is required" };
  const data = await tenableCloudService.getPolicy(policyId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableCreatePolicy(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.uuid) return { success: false, error: "uuid (template UUID) is required" };
  if (!params.name) return { success: false, error: "name is required" };
  const data = await tenableCloudService.createPolicy({
    uuid: params.uuid,
    settings: { name: params.name, description: params.description },
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableUpdatePolicy(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const policyId = params.policy_id as number;
  if (!policyId) return { success: false, error: "policy_id is required" };
  const settings: Record<string, unknown> = {};
  if (params.name !== undefined) settings.name = params.name;
  if (params.description !== undefined) settings.description = params.description;
  const data = await tenableCloudService.updatePolicy(policyId, { settings }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableDeletePolicy(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const policyId = params.policy_id as number;
  if (!policyId) return { success: false, error: "policy_id is required" };
  await tenableCloudService.deletePolicy(policyId, tenableOpts(params));
  return { success: true, data: { deleted: policyId } };
}

async function handleTenableCopyPolicy(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const policyId = params.policy_id as number;
  if (!policyId) return { success: false, error: "policy_id is required" };
  const data = await tenableCloudService.copyPolicy(policyId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableListNetworks(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listNetworks(tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetNetwork(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const networkId = params.network_id as string;
  if (!networkId) return { success: false, error: "network_id is required" };
  const data = await tenableCloudService.getNetwork(networkId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableCreateNetwork(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.name) return { success: false, error: "name is required" };
  const data = await tenableCloudService.createNetwork({
    name: params.name as string,
    description: params.description as string | undefined,
    assets_ttl_days: params.assets_ttl_days as number | undefined,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableUpdateNetwork(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const networkId = params.network_id as string;
  if (!networkId) return { success: false, error: "network_id is required" };
  const data = await tenableCloudService.updateNetwork(networkId, {
    name: params.name as string | undefined,
    description: params.description as string | undefined,
    assets_ttl_days: params.assets_ttl_days as number | undefined,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableDeleteNetwork(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const networkId = params.network_id as string;
  if (!networkId) return { success: false, error: "network_id is required" };
  await tenableCloudService.deleteNetwork(networkId, tenableOpts(params));
  return { success: true, data: { deleted: networkId } };
}

async function handleTenableListNetworkScanners(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const networkId = params.network_id as string;
  if (!networkId) return { success: false, error: "network_id is required" };
  const data = await tenableCloudService.listNetworkScanners(networkId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableAssignScannerToNetwork(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const networkId = params.network_id as string;
  const scannerId = params.scanner_id as number;
  if (!networkId) return { success: false, error: "network_id is required" };
  if (!scannerId) return { success: false, error: "scanner_id is required" };
  await tenableCloudService.assignScannerToNetwork(networkId, scannerId, tenableOpts(params));
  return { success: true, data: { assigned: { networkId, scannerId } } };
}

async function handleTenableListTagCategories(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listTagCategories(tenableOpts(params));
  return { success: true, data };
}

async function handleTenableCreateTagCategory(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.name) return { success: false, error: "name is required" };
  const data = await tenableCloudService.createTagCategory({
    name: params.name as string,
    description: params.description as string | undefined,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableUpdateTagCategory(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const categoryUuid = params.category_uuid as string;
  if (!categoryUuid) return { success: false, error: "category_uuid is required" };
  const data = await tenableCloudService.updateTagCategory(categoryUuid, {
    name: params.name as string | undefined,
    description: params.description as string | undefined,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableDeleteTagCategory(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const categoryUuid = params.category_uuid as string;
  if (!categoryUuid) return { success: false, error: "category_uuid is required" };
  await tenableCloudService.deleteTagCategory(categoryUuid, tenableOpts(params));
  return { success: true, data: { deleted: categoryUuid } };
}

async function handleTenableListTagValues(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listTagValues(params.category_uuid as string | undefined, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableCreateTagValue(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.category_uuid) return { success: false, error: "category_uuid is required" };
  if (!params.value) return { success: false, error: "value is required" };
  const data = await tenableCloudService.createTagValue({
    category_uuid: params.category_uuid as string,
    value: params.value as string,
    description: params.description as string | undefined,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableUpdateTagValue(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const valueUuid = params.value_uuid as string;
  if (!valueUuid) return { success: false, error: "value_uuid is required" };
  const data = await tenableCloudService.updateTagValue(valueUuid, {
    value: params.value as string | undefined,
    description: params.description as string | undefined,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableDeleteTagValue(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const valueUuid = params.value_uuid as string;
  if (!valueUuid) return { success: false, error: "value_uuid is required" };
  await tenableCloudService.deleteTagValue(valueUuid, tenableOpts(params));
  return { success: true, data: { deleted: valueUuid } };
}

async function handleTenableAssignTagsToAssets(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!Array.isArray(params.asset_uuids)) return { success: false, error: "asset_uuids must be an array" };
  if (!Array.isArray(params.tag_uuids)) return { success: false, error: "tag_uuids must be an array" };
  const data = await tenableCloudService.assignTagsToAssets(params.asset_uuids as string[], params.tag_uuids as string[], tenableOpts(params));
  return { success: true, data };
}

async function handleTenableRemoveTagsFromAssets(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!Array.isArray(params.asset_uuids)) return { success: false, error: "asset_uuids must be an array" };
  if (!Array.isArray(params.tag_uuids)) return { success: false, error: "tag_uuids must be an array" };
  const data = await tenableCloudService.removeTagsFromAssets(params.asset_uuids as string[], params.tag_uuids as string[], tenableOpts(params));
  return { success: true, data };
}

async function handleTenableListUsers(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listUsers(tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetUser(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const userId = params.user_id as number;
  if (!userId) return { success: false, error: "user_id is required" };
  const data = await tenableCloudService.getUser(userId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableCreateUser(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.username) return { success: false, error: "username is required" };
  if (!params.password) return { success: false, error: "password is required" };
  if (params.permissions === undefined) return { success: false, error: "permissions is required" };
  const data = await tenableCloudService.createUser({
    username: params.username as string,
    password: params.password as string,
    permissions: params.permissions as number,
    name: params.name as string | undefined,
    email: params.email as string | undefined,
    type: params.type as string | undefined,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableUpdateUser(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const userId = params.user_id as number;
  if (!userId) return { success: false, error: "user_id is required" };
  const data = await tenableCloudService.updateUser(userId, {
    permissions: params.permissions as number | undefined,
    name: params.name as string | undefined,
    email: params.email as string | undefined,
    enabled: params.enabled as boolean | undefined,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableDeleteUser(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const userId = params.user_id as number;
  if (!userId) return { success: false, error: "user_id is required" };
  await tenableCloudService.deleteUser(userId, tenableOpts(params));
  return { success: true, data: { deleted: userId } };
}

async function handleTenableGetUserKeys(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const userId = params.user_id as number;
  if (!userId) return { success: false, error: "user_id is required" };
  const data = await tenableCloudService.getUserKeys(userId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableEnableUser(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const userId = params.user_id as number;
  if (!userId) return { success: false, error: "user_id is required" };
  await tenableCloudService.enableUser(userId, tenableOpts(params));
  return { success: true, data: { enabled: userId } };
}

async function handleTenableDisableUser(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const userId = params.user_id as number;
  if (!userId) return { success: false, error: "user_id is required" };
  await tenableCloudService.disableUser(userId, tenableOpts(params));
  return { success: true, data: { disabled: userId } };
}

async function handleTenableListGroups(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listGroups(tenableOpts(params));
  return { success: true, data };
}

async function handleTenableCreateGroup(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.name) return { success: false, error: "name is required" };
  const data = await tenableCloudService.createGroup(params.name as string, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableUpdateGroup(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const groupId = params.group_id as number;
  if (!groupId) return { success: false, error: "group_id is required" };
  if (!params.name) return { success: false, error: "name is required" };
  const data = await tenableCloudService.updateGroup(groupId, params.name as string, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableDeleteGroup(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const groupId = params.group_id as number;
  if (!groupId) return { success: false, error: "group_id is required" };
  await tenableCloudService.deleteGroup(groupId, tenableOpts(params));
  return { success: true, data: { deleted: groupId } };
}

async function handleTenableListGroupUsers(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const groupId = params.group_id as number;
  if (!groupId) return { success: false, error: "group_id is required" };
  const data = await tenableCloudService.listGroupUsers(groupId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableAddUserToGroup(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const groupId = params.group_id as number;
  const userId = params.user_id as number;
  if (!groupId) return { success: false, error: "group_id is required" };
  if (!userId) return { success: false, error: "user_id is required" };
  await tenableCloudService.addUserToGroup(groupId, userId, tenableOpts(params));
  return { success: true, data: { added: { groupId, userId } } };
}

async function handleTenableRemoveUserFromGroup(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const groupId = params.group_id as number;
  const userId = params.user_id as number;
  if (!groupId) return { success: false, error: "group_id is required" };
  if (!userId) return { success: false, error: "user_id is required" };
  await tenableCloudService.removeUserFromGroup(groupId, userId, tenableOpts(params));
  return { success: true, data: { removed: { groupId, userId } } };
}

async function handleTenableListScanners(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listScanners(tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetScanner(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const scannerId = params.scanner_id as number;
  if (!scannerId) return { success: false, error: "scanner_id is required" };
  const data = await tenableCloudService.getScanner(scannerId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableUpdateScanner(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const scannerId = params.scanner_id as number;
  if (!scannerId) return { success: false, error: "scanner_id is required" };
  const data = await tenableCloudService.updateScanner(scannerId, {
    name: params.name as string | undefined,
    link_permission: params.link_permission as boolean | undefined,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableDeleteScanner(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const scannerId = params.scanner_id as number;
  if (!scannerId) return { success: false, error: "scanner_id is required" };
  await tenableCloudService.deleteScanner(scannerId, tenableOpts(params));
  return { success: true, data: { deleted: scannerId } };
}

async function handleTenableToggleScannerLink(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const scannerId = params.scanner_id as number;
  if (!scannerId) return { success: false, error: "scanner_id is required" };
  if (params.linked === undefined) return { success: false, error: "linked is required" };
  await tenableCloudService.toggleScannerLink(scannerId, params.linked as boolean, tenableOpts(params));
  return { success: true, data: { scannerId, linked: params.linked } };
}

async function handleTenableListAgents(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listAgents({
    offset: params.offset as number | undefined,
    limit: params.limit as number | undefined,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetAgent(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const agentId = params.agent_id as number;
  if (!agentId) return { success: false, error: "agent_id is required" };
  const data = await tenableCloudService.getAgent(agentId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableDeleteAgent(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.scanner_id) return { success: false, error: "scanner_id is required" };
  if (!params.agent_id) return { success: false, error: "agent_id is required" };
  await tenableCloudService.deleteAgent(params.scanner_id as number, params.agent_id as number, tenableOpts(params));
  return { success: true, data: { deleted: params.agent_id } };
}

async function handleTenableUnlinkAgent(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.scanner_id) return { success: false, error: "scanner_id is required" };
  if (!params.agent_id) return { success: false, error: "agent_id is required" };
  await tenableCloudService.unlinkAgent(params.scanner_id as number, params.agent_id as number, tenableOpts(params));
  return { success: true, data: { unlinked: params.agent_id } };
}

async function handleTenableBulkDeleteAgents(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.scanner_id) return { success: false, error: "scanner_id is required" };
  if (!Array.isArray(params.agent_ids)) return { success: false, error: "agent_ids must be an array" };
  const data = await tenableCloudService.bulkDeleteAgents(params.scanner_id as number, params.agent_ids as number[], tenableOpts(params));
  return { success: true, data };
}

async function handleTenableBulkUnlinkAgents(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.scanner_id) return { success: false, error: "scanner_id is required" };
  if (!Array.isArray(params.agent_ids)) return { success: false, error: "agent_ids must be an array" };
  const data = await tenableCloudService.bulkUnlinkAgents(params.scanner_id as number, params.agent_ids as number[], tenableOpts(params));
  return { success: true, data };
}

async function handleTenableListAgentGroups(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.scanner_id) return { success: false, error: "scanner_id is required" };
  const data = await tenableCloudService.listAgentGroups(params.scanner_id as number, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableCreateAgentGroup(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.scanner_id) return { success: false, error: "scanner_id is required" };
  if (!params.name) return { success: false, error: "name is required" };
  const data = await tenableCloudService.createAgentGroup(params.scanner_id as number, params.name as string, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableUpdateAgentGroup(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.scanner_id) return { success: false, error: "scanner_id is required" };
  if (!params.group_id) return { success: false, error: "group_id is required" };
  if (!params.name) return { success: false, error: "name is required" };
  const data = await tenableCloudService.updateAgentGroup(params.scanner_id as number, params.group_id as number, params.name as string, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableDeleteAgentGroup(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.scanner_id) return { success: false, error: "scanner_id is required" };
  if (!params.group_id) return { success: false, error: "group_id is required" };
  await tenableCloudService.deleteAgentGroup(params.scanner_id as number, params.group_id as number, tenableOpts(params));
  return { success: true, data: { deleted: params.group_id } };
}

async function handleTenableAddAgentToGroup(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.scanner_id) return { success: false, error: "scanner_id is required" };
  if (!params.group_id) return { success: false, error: "group_id is required" };
  if (!params.agent_id) return { success: false, error: "agent_id is required" };
  await tenableCloudService.addAgentToGroup(params.scanner_id as number, params.group_id as number, params.agent_id as number, tenableOpts(params));
  return { success: true, data: { added: params.agent_id } };
}

async function handleTenableRemoveAgentFromGroup(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.scanner_id) return { success: false, error: "scanner_id is required" };
  if (!params.group_id) return { success: false, error: "group_id is required" };
  if (!params.agent_id) return { success: false, error: "agent_id is required" };
  await tenableCloudService.removeAgentFromGroup(params.scanner_id as number, params.group_id as number, params.agent_id as number, tenableOpts(params));
  return { success: true, data: { removed: params.agent_id } };
}

async function handleTenableListExclusions(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listExclusions(tenableOpts(params));
  return { success: true, data };
}

async function handleTenableCreateExclusion(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.name) return { success: false, error: "name is required" };
  if (!params.members) return { success: false, error: "members is required" };
  const data = await tenableCloudService.createExclusion({
    name: params.name as string,
    members: params.members as string,
    description: params.description as string | undefined,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetExclusion(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const exclusionId = params.exclusion_id as number;
  if (!exclusionId) return { success: false, error: "exclusion_id is required" };
  const data = await tenableCloudService.getExclusion(exclusionId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableUpdateExclusion(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const exclusionId = params.exclusion_id as number;
  if (!exclusionId) return { success: false, error: "exclusion_id is required" };
  const data = await tenableCloudService.updateExclusion(exclusionId, {
    name: params.name as string | undefined,
    members: params.members as string | undefined,
    description: params.description as string | undefined,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableDeleteExclusion(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const exclusionId = params.exclusion_id as number;
  if (!exclusionId) return { success: false, error: "exclusion_id is required" };
  await tenableCloudService.deleteExclusion(exclusionId, tenableOpts(params));
  return { success: true, data: { deleted: exclusionId } };
}

async function handleTenableListCredentials(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listCredentials(tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetCredential(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const credentialUuid = params.credential_uuid as string;
  if (!credentialUuid) return { success: false, error: "credential_uuid is required" };
  const data = await tenableCloudService.getCredential(credentialUuid, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableCreateCredential(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.name) return { success: false, error: "name is required" };
  if (!params.type) return { success: false, error: "type is required" };
  if (!params.settings) return { success: false, error: "settings is required" };
  const data = await tenableCloudService.createCredential({
    name: params.name,
    description: params.description,
    type: params.type,
    ...(params.settings as Record<string, unknown>),
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableUpdateCredential(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const credentialUuid = params.credential_uuid as string;
  if (!credentialUuid) return { success: false, error: "credential_uuid is required" };
  const updates: Record<string, unknown> = {};
  if (params.name !== undefined) updates.name = params.name;
  if (params.description !== undefined) updates.description = params.description;
  if (params.settings) Object.assign(updates, params.settings as Record<string, unknown>);
  const data = await tenableCloudService.updateCredential(credentialUuid, updates, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableDeleteCredential(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const credentialUuid = params.credential_uuid as string;
  if (!credentialUuid) return { success: false, error: "credential_uuid is required" };
  await tenableCloudService.deleteCredential(credentialUuid, tenableOpts(params));
  return { success: true, data: { deleted: credentialUuid } };
}

async function handleTenableListPluginFamilies(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listPluginFamilies(tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetPluginFamily(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const familyId = params.family_id as number;
  if (!familyId) return { success: false, error: "family_id is required" };
  const data = await tenableCloudService.getPluginFamily(familyId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetPlugin(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const pluginId = params.plugin_id as number;
  if (!pluginId) return { success: false, error: "plugin_id is required" };
  const data = await tenableCloudService.getPlugin(pluginId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableListAlerts(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listAlerts(tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetAlert(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const alertId = params.alert_id as number;
  if (!alertId) return { success: false, error: "alert_id is required" };
  const data = await tenableCloudService.getAlert(alertId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableCreateAlert(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.name) return { success: false, error: "name is required" };
  const data = await tenableCloudService.createAlert({
    name: params.name,
    enabled: params.enabled,
    filters: params.filters,
    action: params.action,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableUpdateAlert(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const alertId = params.alert_id as number;
  if (!alertId) return { success: false, error: "alert_id is required" };
  const updates: Record<string, unknown> = {};
  if (params.name !== undefined) updates.name = params.name;
  if (params.enabled !== undefined) updates.enabled = params.enabled;
  const data = await tenableCloudService.updateAlert(alertId, updates, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableDeleteAlert(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const alertId = params.alert_id as number;
  if (!alertId) return { success: false, error: "alert_id is required" };
  await tenableCloudService.deleteAlert(alertId, tenableOpts(params));
  return { success: true, data: { deleted: alertId } };
}

async function handleTenableExecuteAlert(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const alertId = params.alert_id as number;
  if (!alertId) return { success: false, error: "alert_id is required" };
  await tenableCloudService.executeAlert(alertId, tenableOpts(params));
  return { success: true, data: { executed: alertId } };
}

async function handleTenableGetAuditLog(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.getAuditLog({
    limit: params.limit as number | undefined,
    offset: params.offset as number | undefined,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableListAccessGroups(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listAccessGroups(tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetAccessGroup(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const groupId = params.group_id as string;
  if (!groupId) return { success: false, error: "group_id is required" };
  const data = await tenableCloudService.getAccessGroup(groupId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableCreateAccessGroup(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.name) return { success: false, error: "name is required" };
  const data = await tenableCloudService.createAccessGroup({
    name: params.name,
    rules: params.rules,
    principals: params.principals,
    all_users: params.all_users,
    all_assets: params.all_assets,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableUpdateAccessGroup(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const groupId = params.group_id as string;
  if (!groupId) return { success: false, error: "group_id is required" };
  const updates: Record<string, unknown> = {};
  if (params.name !== undefined) updates.name = params.name;
  if (params.rules !== undefined) updates.rules = params.rules;
  if (params.principals !== undefined) updates.principals = params.principals;
  const data = await tenableCloudService.updateAccessGroup(groupId, updates, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableDeleteAccessGroup(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const groupId = params.group_id as string;
  if (!groupId) return { success: false, error: "group_id is required" };
  await tenableCloudService.deleteAccessGroup(groupId, tenableOpts(params));
  return { success: true, data: { deleted: groupId } };
}

async function handleTenableListRemediationRules(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listRemediationRules(tenableOpts(params));
  return { success: true, data };
}

async function handleTenableCreateRemediationRule(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  if (!params.rule_type) return { success: false, error: "rule_type is required" };
  if (!params.description) return { success: false, error: "description is required" };
  if (!params.plugin_id) return { success: false, error: "plugin_id is required" };
  const data = await tenableCloudService.createRemediationRule({
    rule_type: params.rule_type as string,
    description: params.description as string,
    target: { type: (params.target_type as string) || "all", id: params.target_id as string | undefined },
    plugin: { id: params.plugin_id as number },
    new_severity: params.new_severity as number | undefined,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableDeleteRemediationRule(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const ruleId = params.rule_id as string;
  if (!ruleId) return { success: false, error: "rule_id is required" };
  await tenableCloudService.deleteRemediationRule(ruleId, tenableOpts(params));
  return { success: true, data: { deleted: ruleId } };
}

async function handleTenableListContainerImages(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.listContainerImages({
    offset: params.offset as number | undefined,
    limit: params.limit as number | undefined,
  }, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetContainerReport(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const imageId = params.image_id as string;
  if (!imageId) return { success: false, error: "image_id is required" };
  const data = await tenableCloudService.getContainerReport(imageId, tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetServerStatus(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.getServerStatus(tenableOpts(params));
  return { success: true, data };
}

async function handleTenableGetServerProperties(params: Record<string, unknown>): Promise<ToolCallResult> {
  const err = tenableConfigCheck(params);
  if (err) return { success: false, error: err };
  const data = await tenableCloudService.getServerProperties(tenableOpts(params));
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

async function handleCodeReviewGithubPr(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const owner = params.owner as string;
  const repo = params.repo as string;
  const prNumber = params.prNumber as number;
  if (!owner || !repo || !prNumber) {
    return { success: false, error: "owner, repo, and prNumber are required" };
  }
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const review = await reviewAssistant.reviewGitHubPullRequest({ owner, repo, prNumber });
  return { success: true, data: review };
}

async function handleCodeReviewGitlabMr(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const projectId = params.projectId as string | number;
  const mrIid = params.mrIid as number;
  if (!projectId || !mrIid) {
    return { success: false, error: "projectId and mrIid are required" };
  }
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const review = await reviewAssistant.reviewGitLabMergeRequest({ projectId, mrIid });
  return { success: true, data: review };
}

async function handleCodeReviewReleaseReadiness(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const platform = params.platform as string;
  if (!platform) {
    return { success: false, error: "platform is required (github or gitlab)" };
  }
  if (platform === "github" && !githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  if (platform === "gitlab" && !gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const report = await reviewAssistant.generateReleaseReadinessReport({
    platform: platform as "github" | "gitlab",
    owner: params.owner as string | undefined,
    repo: params.repo as string | undefined,
    prNumber: params.prNumber as number | undefined,
    projectId: params.projectId as string | number | undefined,
    mrIid: params.mrIid as number | undefined,
    notes: params.notes as string | undefined,
  });
  return { success: true, data: report };
}

async function handleCodeReviewGenerateComment(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const review = params.review as any;
  if (!review) {
    return { success: false, error: "review is required" };
  }
  const comment = reviewAssistant.generateReviewComment(review);
  return { success: true, data: { comment } };
}

async function handleCodeReviewCreateWorkItem(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const title = params.title as string;
  const type = params.type as string;
  if (!title || !type) {
    return { success: false, error: "title and type are required" };
  }
  if (type !== "code_review" && type !== "release") {
    return { success: false, error: 'type must be "code_review" or "release"' };
  }
  const item = reviewAssistant.createReviewWorkItem({
    title,
    type: type as "code_review" | "release",
    prUrl: params.prUrl as string | undefined,
    riskLevel: params.riskLevel as string | undefined,
    recommendation: params.recommendation as string | undefined,
    description: params.description as string | undefined,
    priority: params.priority as "low" | "medium" | "high" | "critical" | undefined,
  });
  return { success: true, data: item };
}

// ── GitHub Milestone Handlers ──────────────────────────────────

async function handleGithubCreateMilestone(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const title = params.title as string;
  if (!title) {
    return { success: false, error: "title is required" };
  }
  const milestone = await githubClient.createMilestone(
    {
      title,
      description: params.description as string | undefined,
      due_on: params.due_on as string | undefined,
    },
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return {
    success: true,
    data: {
      number: milestone.number,
      title: milestone.title,
      state: milestone.state,
      due_on: milestone.due_on,
      url: milestone.html_url,
    },
  };
}

async function handleGithubUpdateMilestone(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const number = params.number as number;
  if (!number) {
    return { success: false, error: "number is required" };
  }
  const updates: Record<string, unknown> = {};
  if (params.title !== undefined) updates.title = params.title;
  if (params.description !== undefined) updates.description = params.description;
  if (params.due_on !== undefined) updates.due_on = params.due_on;
  if (params.state !== undefined) updates.state = params.state;
  if (Object.keys(updates).length === 0) {
    return { success: false, error: "No fields to update" };
  }
  const milestone = await githubClient.updateMilestone(
    number,
    updates,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return {
    success: true,
    data: {
      number: milestone.number,
      title: milestone.title,
      state: milestone.state,
      due_on: milestone.due_on,
      url: milestone.html_url,
    },
  };
}

async function handleGithubDeleteMilestone(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!githubClient.isConfigured()) {
    return { success: false, error: "GitHub client not configured" };
  }
  const number = params.number as number;
  if (!number) {
    return { success: false, error: "number is required" };
  }
  await githubClient.deleteMilestone(
    number,
    params.owner as string | undefined,
    params.repo as string | undefined,
  );
  return { success: true, data: { deleted: true, number } };
}

// ── GitLab Milestone Handlers ──────────────────────────────────

async function handleGitlabListMilestones(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const milestones = await gitlabClient.listMilestones(
    (params.projectId as string) || undefined,
    (params.state as "active" | "closed" | "all") || undefined,
  );
  return {
    success: true,
    data: milestones.map((m) => ({
      id: m.id,
      iid: m.iid,
      title: m.title,
      description: m.description,
      state: m.state,
      due_date: m.due_date,
      start_date: m.start_date,
      web_url: m.web_url,
    })),
  };
}

async function handleGitlabCreateMilestone(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const title = params.title as string;
  if (!title) {
    return { success: false, error: "title is required" };
  }
  const milestone = await gitlabClient.createMilestone(
    (params.projectId as string) || undefined,
    {
      title,
      description: params.description as string | undefined,
      due_date: params.due_date as string | undefined,
      start_date: params.start_date as string | undefined,
    },
  );
  return {
    success: true,
    data: {
      id: milestone.id,
      iid: milestone.iid,
      title: milestone.title,
      state: milestone.state,
      due_date: milestone.due_date,
      web_url: milestone.web_url,
    },
  };
}

async function handleGitlabUpdateMilestone(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const milestoneId = params.milestoneId as number;
  if (!milestoneId) {
    return { success: false, error: "milestoneId is required" };
  }
  const updates: Record<string, unknown> = {};
  if (params.title !== undefined) updates.title = params.title;
  if (params.description !== undefined) updates.description = params.description;
  if (params.due_date !== undefined) updates.due_date = params.due_date;
  if (params.start_date !== undefined) updates.start_date = params.start_date;
  if (params.state_event !== undefined) updates.state_event = params.state_event;
  if (Object.keys(updates).length === 0) {
    return { success: false, error: "No fields to update" };
  }
  const milestone = await gitlabClient.updateMilestone(
    (params.projectId as string) || undefined,
    milestoneId,
    updates,
  );
  return {
    success: true,
    data: {
      id: milestone.id,
      iid: milestone.iid,
      title: milestone.title,
      state: milestone.state,
      due_date: milestone.due_date,
      web_url: milestone.web_url,
    },
  };
}

async function handleGitlabDeleteMilestone(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!gitlabClient.isConfigured()) {
    return { success: false, error: "GitLab client not configured" };
  }
  const milestoneId = params.milestoneId as number;
  if (!milestoneId) {
    return { success: false, error: "milestoneId is required" };
  }
  await gitlabClient.deleteMilestone(
    (params.projectId as string) || undefined,
    milestoneId,
  );
  return { success: true, data: { deleted: true, milestoneId } };
}

// ── Jira Sprint Handlers ─────────────────────────────────────

async function handleJiraCreateSprint(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jiraClient.isConfigured()) {
    return { success: false, error: "Jira client not configured" };
  }
  const projectKey = params.projectKey as string;
  const name = params.name as string;
  if (!projectKey || !name) {
    return { success: false, error: "projectKey and name are required" };
  }
  const sprint = await jiraClient.createSprint({
    projectKey,
    name,
    goal: params.goal as string | undefined,
    startDate: params.startDate as string | undefined,
    endDate: params.endDate as string | undefined,
  });
  return {
    success: true,
    data: {
      id: sprint.id,
      name: sprint.name,
      state: sprint.state,
      goal: sprint.goal,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
    },
  };
}

async function handleJiraUpdateSprint(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jiraClient.isConfigured()) {
    return { success: false, error: "Jira client not configured" };
  }
  const sprintId = params.sprintId as number;
  if (!sprintId) {
    return { success: false, error: "sprintId is required" };
  }
  const updates: Record<string, unknown> = {};
  if (params.name !== undefined) updates.name = params.name;
  if (params.goal !== undefined) updates.goal = params.goal;
  if (params.startDate !== undefined) updates.startDate = params.startDate;
  if (params.endDate !== undefined) updates.endDate = params.endDate;
  if (params.state !== undefined) updates.state = params.state;
  if (Object.keys(updates).length === 0) {
    return { success: false, error: "No fields to update" };
  }
  const sprint = await jiraClient.updateSprint(sprintId, updates);
  return {
    success: true,
    data: {
      id: sprint.id,
      name: sprint.name,
      state: sprint.state,
      goal: sprint.goal,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
    },
  };
}

async function handleJiraDeleteSprint(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!jiraClient.isConfigured()) {
    return { success: false, error: "Jira client not configured" };
  }
  const sprintId = params.sprintId as number;
  if (!sprintId) {
    return { success: false, error: "sprintId is required" };
  }
  // Jira doesn't truly delete sprints; we close them
  const sprint = await jiraClient.updateSprint(sprintId, { state: "closed" });
  return {
    success: true,
    data: { id: sprint.id, name: sprint.name, state: sprint.state, closed: true },
  };
}

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  "calendar.list_events": handleCalendarListEvents,
  "calendar.create_focus_block": handleCalendarCreateFocusBlock,
  "calendar.create_health_block": handleCalendarCreateHealthBlock,
  "calendar.create_event": handleCalendarCreateEvent,
  "calendar.update_event": handleCalendarUpdateEvent,
  "calendar.delete_event": handleCalendarDeleteEvent,
  "calendar.get_event": handleCalendarGetEvent,
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
  "jira.delete_comment": handleJiraDeleteComment,
  "jira.get_project": handleJiraGetProject,
  "jira.list_projects": handleJiraListProjects,
  "jira.create_sprint": handleJiraCreateSprint,
  "jira.update_sprint": handleJiraUpdateSprint,
  "jira.delete_sprint": handleJiraDeleteSprint,
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
  "gitlab.list_milestones": handleGitlabListMilestones,
  "gitlab.create_milestone": handleGitlabCreateMilestone,
  "gitlab.update_milestone": handleGitlabUpdateMilestone,
  "gitlab.delete_milestone": handleGitlabDeleteMilestone,
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
  "github.create_milestone": handleGithubCreateMilestone,
  "github.update_milestone": handleGithubUpdateMilestone,
  "github.delete_milestone": handleGithubDeleteMilestone,
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
  "jitbit.search_assets": handleJitbitSearchAssets,
  "jitbit.add_tag": handleJitbitAddTag,
  "jitbit.remove_tag": handleJitbitRemoveTag,
  "jitbit.add_time_entry": handleJitbitAddTimeEntry,
  "jitbit.update_ticket": handleJitbitUpdateTicket,
  "jitbit.list_users": handleJitbitListUsers,
  "jitbit.search_users": handleJitbitSearchUsers,
  "jitbit.list_companies": handleJitbitListCompanies,
  "jitbit.search_companies": handleJitbitSearchCompanies,
  "jitbit.list_categories": handleJitbitListCategories,
  "jitbit.list_priorities": handleJitbitListPriorities,
  "jitbit.subscribe_to_ticket": handleJitbitSubscribeToTicket,
  "jitbit.unsubscribe_from_ticket": handleJitbitUnsubscribeFromTicket,
  "jitbit.list_attachments": handleJitbitListAttachments,
  "jitbit.add_attachment": handleJitbitAddAttachment,
  "jitbit.get_attachment": handleJitbitGetAttachment,
  "jitbit.delete_attachment": handleJitbitDeleteAttachment,
  "jitbit.summarize_ticket": handleJitbitSummarizeTicket,
  "jitbit.list_custom_fields": handleJitbitListCustomFields,
  "jitbit.get_custom_field_values": handleJitbitGetCustomFieldValues,
  "jitbit.set_custom_field_value": handleJitbitSetCustomFieldValue,
  "jitbit.list_tags": handleJitbitListTags,
  "jitbit.list_sections": handleJitbitListSections,
  "jitbit.get_time_entries": handleJitbitGetTimeEntries,
  "jitbit.get_automation_rule": handleJitbitGetAutomationRule,
  "jitbit.enable_automation_rule": handleJitbitEnableAutomationRule,
  "jitbit.disable_automation_rule": handleJitbitDisableAutomationRule,

  // HAWK IR
  "hawk_ir.get_cases": handleHawkIrGetCases,
  "hawk_ir.get_case": handleHawkIrGetCase,
  "hawk_ir.get_case_summary": handleHawkIrGetCaseSummary,
  "hawk_ir.get_risky_open_cases": handleHawkIrGetRiskyOpenCases,
  "hawk_ir.get_escalated_cases": handleHawkIrGetEscalatedCases,
  "hawk_ir.deescalate_case": handleHawkIrDeescalateCase,
  "hawk_ir.add_case_note": handleHawkIrAddCaseNote,
  "hawk_ir.update_case_status": handleHawkIrUpdateCaseStatus,
  "hawk_ir.update_case_risk": handleHawkIrUpdateCaseRisk,
  "hawk_ir.escalate_case": handleHawkIrEscalateCase,
  "hawk_ir.assign_case": handleHawkIrAssignCase,
  "hawk_ir.merge_cases": handleHawkIrMergeCases,
  "hawk_ir.rename_case": handleHawkIrRenameCase,
  "hawk_ir.update_case_details": handleHawkIrUpdateCaseDetails,
  "hawk_ir.set_case_categories": handleHawkIrSetCaseCategories,
  "hawk_ir.add_ignore_label": handleHawkIrAddIgnoreLabel,
  "hawk_ir.delete_ignore_label": handleHawkIrDeleteIgnoreLabel,
  "hawk_ir.get_case_categories": handleHawkIrGetCaseCategories,
  "hawk_ir.get_case_labels": handleHawkIrGetCaseLabels,
  "hawk_ir.quarantine_host": handleHawkIrQuarantineHost,
  "hawk_ir.unquarantine_host": handleHawkIrUnquarantineHost,
  "hawk_ir.search_logs": handleHawkIrSearchLogs,
  "hawk_ir.get_available_indexes": handleHawkIrGetAvailableIndexes,
  "hawk_ir.get_fields": handleHawkIrGetFields,
  "hawk_ir.get_assets": handleHawkIrGetAssets,
  "hawk_ir.get_asset_summary": handleHawkIrGetAssetSummary,
  "hawk_ir.get_identities": handleHawkIrGetIdentities,
  "hawk_ir.get_identity_summary": handleHawkIrGetIdentitySummary,
  "hawk_ir.list_nodes": handleHawkIrListNodes,
  "hawk_ir.get_active_nodes": handleHawkIrGetActiveNodes,
  "hawk_ir.list_dashboards": handleHawkIrListDashboards,
  "hawk_ir.run_dashboard": handleHawkIrRunDashboard,
  "hawk_ir.run_dashboard_query": handleHawkIrRunDashboardQuery,
  "hawk_ir.weekly_report": handleHawkIrWeeklyReport,
  "hawk_ir.monthly_summary": handleHawkIrMonthlySummary,
  "hawk_ir.get_case_count": handleHawkIrGetCaseCount,
  "hawk_ir.get_recent_cases": handleHawkIrGetRecentCases,
  "hawk_ir.get_log_histogram": handleHawkIrGetLogHistogram,
  "hawk_ir.get_saved_searches": handleHawkIrGetSavedSearches,
  "hawk_ir.get_artefacts": handleHawkIrGetArtefacts,
  "hawk_ir.execute_hybrid_tool": handleHawkIrExecuteHybridTool,

  // ── Tenable Cloud Handlers ──────────────────────────────────────────────────
  "tenable.list_vulnerabilities": handleTenableListVulnerabilities,
  "tenable.get_vulnerability_details": handleTenableGetVulnerabilityDetails,
  "tenable.export_vulnerabilities": handleTenableExportVulnerabilities,
  "tenable.get_vuln_export_status": handleTenableGetVulnExportStatus,
  "tenable.download_vuln_export_chunk": handleTenableDownloadVulnExportChunk,
  "tenable.list_workbench_assets": handleTenableListWorkbenchAssets,
  "tenable.get_asset_vulnerabilities": handleTenableGetAssetVulnerabilities,
  "tenable.list_assets": handleTenableListAssets,
  "tenable.get_asset": handleTenableGetAsset,
  "tenable.delete_asset": handleTenableDeleteAsset,
  "tenable.import_assets": handleTenableImportAssets,
  "tenable.export_assets": handleTenableExportAssets,
  "tenable.get_asset_export_status": handleTenableGetAssetExportStatus,
  "tenable.download_asset_export_chunk": handleTenableDownloadAssetExportChunk,
  "tenable.bulk_delete_assets": handleTenableBulkDeleteAssets,
  "tenable.list_scans": handleTenableListScans,
  "tenable.get_scan": handleTenableGetScan,
  "tenable.create_scan": handleTenableCreateScan,
  "tenable.update_scan": handleTenableUpdateScan,
  "tenable.delete_scan": handleTenableDeleteScan,
  "tenable.launch_scan": handleTenableLaunchScan,
  "tenable.stop_scan": handleTenableStopScan,
  "tenable.pause_scan": handleTenablePauseScan,
  "tenable.resume_scan": handleTenableResumeScan,
  "tenable.copy_scan": handleTenableCopyScan,
  "tenable.export_scan": handleTenableExportScan,
  "tenable.import_scan": handleTenableImportScan,
  "tenable.get_scan_history": handleTenableGetScanHistory,
  "tenable.list_scan_templates": handleTenableListScanTemplates,
  "tenable.list_policies": handleTenableListPolicies,
  "tenable.get_policy": handleTenableGetPolicy,
  "tenable.create_policy": handleTenableCreatePolicy,
  "tenable.update_policy": handleTenableUpdatePolicy,
  "tenable.delete_policy": handleTenableDeletePolicy,
  "tenable.copy_policy": handleTenableCopyPolicy,
  "tenable.list_networks": handleTenableListNetworks,
  "tenable.get_network": handleTenableGetNetwork,
  "tenable.create_network": handleTenableCreateNetwork,
  "tenable.update_network": handleTenableUpdateNetwork,
  "tenable.delete_network": handleTenableDeleteNetwork,
  "tenable.list_network_scanners": handleTenableListNetworkScanners,
  "tenable.assign_scanner_to_network": handleTenableAssignScannerToNetwork,
  "tenable.list_tag_categories": handleTenableListTagCategories,
  "tenable.create_tag_category": handleTenableCreateTagCategory,
  "tenable.update_tag_category": handleTenableUpdateTagCategory,
  "tenable.delete_tag_category": handleTenableDeleteTagCategory,
  "tenable.list_tag_values": handleTenableListTagValues,
  "tenable.create_tag_value": handleTenableCreateTagValue,
  "tenable.update_tag_value": handleTenableUpdateTagValue,
  "tenable.delete_tag_value": handleTenableDeleteTagValue,
  "tenable.assign_tags_to_assets": handleTenableAssignTagsToAssets,
  "tenable.remove_tags_from_assets": handleTenableRemoveTagsFromAssets,
  "tenable.list_users": handleTenableListUsers,
  "tenable.get_user": handleTenableGetUser,
  "tenable.create_user": handleTenableCreateUser,
  "tenable.update_user": handleTenableUpdateUser,
  "tenable.delete_user": handleTenableDeleteUser,
  "tenable.get_user_keys": handleTenableGetUserKeys,
  "tenable.enable_user": handleTenableEnableUser,
  "tenable.disable_user": handleTenableDisableUser,
  "tenable.list_groups": handleTenableListGroups,
  "tenable.create_group": handleTenableCreateGroup,
  "tenable.update_group": handleTenableUpdateGroup,
  "tenable.delete_group": handleTenableDeleteGroup,
  "tenable.list_group_users": handleTenableListGroupUsers,
  "tenable.add_user_to_group": handleTenableAddUserToGroup,
  "tenable.remove_user_from_group": handleTenableRemoveUserFromGroup,
  "tenable.list_scanners": handleTenableListScanners,
  "tenable.get_scanner": handleTenableGetScanner,
  "tenable.update_scanner": handleTenableUpdateScanner,
  "tenable.delete_scanner": handleTenableDeleteScanner,
  "tenable.toggle_scanner_link": handleTenableToggleScannerLink,
  "tenable.list_agents": handleTenableListAgents,
  "tenable.get_agent": handleTenableGetAgent,
  "tenable.delete_agent": handleTenableDeleteAgent,
  "tenable.unlink_agent": handleTenableUnlinkAgent,
  "tenable.bulk_delete_agents": handleTenableBulkDeleteAgents,
  "tenable.bulk_unlink_agents": handleTenableBulkUnlinkAgents,
  "tenable.list_agent_groups": handleTenableListAgentGroups,
  "tenable.create_agent_group": handleTenableCreateAgentGroup,
  "tenable.update_agent_group": handleTenableUpdateAgentGroup,
  "tenable.delete_agent_group": handleTenableDeleteAgentGroup,
  "tenable.add_agent_to_group": handleTenableAddAgentToGroup,
  "tenable.remove_agent_from_group": handleTenableRemoveAgentFromGroup,
  "tenable.list_exclusions": handleTenableListExclusions,
  "tenable.create_exclusion": handleTenableCreateExclusion,
  "tenable.get_exclusion": handleTenableGetExclusion,
  "tenable.update_exclusion": handleTenableUpdateExclusion,
  "tenable.delete_exclusion": handleTenableDeleteExclusion,
  "tenable.list_credentials": handleTenableListCredentials,
  "tenable.get_credential": handleTenableGetCredential,
  "tenable.create_credential": handleTenableCreateCredential,
  "tenable.update_credential": handleTenableUpdateCredential,
  "tenable.delete_credential": handleTenableDeleteCredential,
  "tenable.list_plugin_families": handleTenableListPluginFamilies,
  "tenable.get_plugin_family": handleTenableGetPluginFamily,
  "tenable.get_plugin": handleTenableGetPlugin,
  "tenable.list_alerts": handleTenableListAlerts,
  "tenable.get_alert": handleTenableGetAlert,
  "tenable.create_alert": handleTenableCreateAlert,
  "tenable.update_alert": handleTenableUpdateAlert,
  "tenable.delete_alert": handleTenableDeleteAlert,
  "tenable.execute_alert": handleTenableExecuteAlert,
  "tenable.get_audit_log": handleTenableGetAuditLog,
  "tenable.list_access_groups": handleTenableListAccessGroups,
  "tenable.get_access_group": handleTenableGetAccessGroup,
  "tenable.create_access_group": handleTenableCreateAccessGroup,
  "tenable.update_access_group": handleTenableUpdateAccessGroup,
  "tenable.delete_access_group": handleTenableDeleteAccessGroup,
  "tenable.list_remediation_rules": handleTenableListRemediationRules,
  "tenable.create_remediation_rule": handleTenableCreateRemediationRule,
  "tenable.delete_remediation_rule": handleTenableDeleteRemediationRule,
  "tenable.list_container_images": handleTenableListContainerImages,
  "tenable.get_container_report": handleTenableGetContainerReport,
  "tenable.get_server_status": handleTenableGetServerStatus,
  "tenable.get_server_properties": handleTenableGetServerProperties,

  "code_review.github_pr": handleCodeReviewGithubPr,
  "code_review.gitlab_mr": handleCodeReviewGitlabMr,
  "code_review.release_readiness": handleCodeReviewReleaseReadiness,
  "code_review.generate_comment": handleCodeReviewGenerateComment,
  "code_review.create_work_item": handleCodeReviewCreateWorkItem,
  "productivity.generate_daily_plan": handleDailyPlan,
  "productivity.generate_weekly_plan": handleWeeklyPlan,
  "cto.daily_command_center": handleCtoDailyCommandCenter,
  "cto.create_suggested_work_items": handleCtoCreateSuggestedWorkItems,
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
  "product.shipped_vs_planned": handleProductShippedVsPlanned,
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
  "engineering.ticket_to_task": handleEngineeringTicketToTask,
  "ticket_bridge.generate_prompt": handleTicketBridgeGeneratePrompt,

  // Musician Tools
  "musician.explain_theory": handleMusicianExplainTheory,
  "musician.compose": handleMusicianCompose,
  "musician.generate_sample": handleMusicianGenerateSample,
  "musician.analyze_audio": handleMusicianAnalyzeAudio,
  "musician.transcribe_audio": handleMusicianTranscribeAudio,
  "musician.practice_plan": handleMusicianPracticePlan,

  "system.approve_action": handleApproveAction,
  "system.reject_action": handleRejectAction,
  "system.list_approvals": handleListApprovals,
  "system.get_time": handleSystemGetTime,
  "system.check_health": handleSystemCheckHealth,
  "system.exec": handleSystemExec,
  "system.read_env": handleSystemReadEnv,
  "system.disk_usage": handleSystemDiskUsage,
  "system.process_info": handleSystemProcessInfo,

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
  "agent.list_runs": handleAgentListRuns,
  "agent.get_run": handleAgentGetRun,
  "agent.get_run_stats": handleAgentGetRunStats,
  "agent.get_aicoder_status": handleAgentGetAicoderStatus,

  "memory.find_entities": handleMemoryFindEntities,
  "memory.get_entity_context": handleMemoryGetEntityContext,
  "memory.add_entity_fact": handleMemoryAddEntityFact,
  "memory.manage": handleMemoryManage,
  "skill.manage": handleSkillManage,

  "workflow.create": handleWorkflowCreate,
  "workflow.advance": handleWorkflowAdvance,
  "workflow.get": handleWorkflowGet,
  "workflow.list": handleWorkflowList,
  "workflow.execute_phase": handleWorkflowExecutePhase,

  "local.read_file": handleLocalReadFile,
  "local.write_file": handleLocalWriteFile,
  "local.edit_file": handleLocalEditFile,
  "local.delete_file": handleLocalDeleteFile,
  "local.list_dir": handleLocalListDir,
  "git.status": handleGitStatus,
  "git.diff": handleGitDiff,
  "git.log": handleGitLog,
  "git.add": handleGitAdd,
  "git.commit": handleGitCommit,
  "git.push": handleGitPush,
  "git.branch": handleGitBranch,
  "local.list_tree": handleLocalListTree,
  "local.search_code": handleLocalSearchCode,
  "local.file_summary": handleLocalFileSummary,
  "local.read_section": handleLocalReadSection,
  "local.file_chunks": handleLocalFileChunks,

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
  "agent.list_runs",
  "agent.get_run",
  "agent.get_run_stats",
  "agent.get_aicoder_status",
  "memory.manage",
  "skill.manage",
  "engineering.workflow_brief",
  "engineering.architecture_proposal",
  "engineering.scaffolding_plan",
  "engineering.ticket_to_task",
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
  "product.shipped_vs_planned",
  "hawk_ir.get_cases",
  "hawk_ir.get_case",
  "hawk_ir.get_case_summary",
  "hawk_ir.get_risky_open_cases",
  "hawk_ir.search_logs",
  "hawk_ir.get_available_indexes",
  "hawk_ir.get_assets",
  "hawk_ir.get_asset_summary",
  "hawk_ir.get_identities",
  "hawk_ir.get_identity_summary",
  "hawk_ir.list_nodes",
  "hawk_ir.get_active_nodes",
  "hawk_ir.list_dashboards",
  "hawk_ir.get_case_count",
  "hawk_ir.get_recent_cases",
  "hawk_ir.get_log_histogram",
  "hawk_ir.get_saved_searches",
  "hawk_ir.get_artefacts",
  "hawk_ir.get_case_categories",
  "hawk_ir.get_case_labels",
  "calendar.get_event",
]);

const SANITIZED_TOOL_NAME_MAP = new Map(
  Object.keys(TOOL_HANDLERS).map((name) => [
    name.replace(/[^a-zA-Z0-9_-]/g, "_"),
    name,
  ]),
);

function resolveToolName(toolName: string): string {
  if (TOOL_HANDLERS[toolName]) return toolName;
  return SANITIZED_TOOL_NAME_MAP.get(toolName) ?? toolName;
}

export interface DispatchContext {
  /** Recent conversation messages for platform intent detection */
  messages?: import("../agent/providers/types").ChatMessage[];
  /** Agent mode (productivity, engineering) */
  mode?: string;
}

const userToolCounters = new Map<string, number>();
const MEMORY_NUDGE_INTERVAL = 15;
const MAX_COUNTER_ENTRIES = 1000;
const SKILL_SUGGEST_THRESHOLD = 5;
const MAX_SKILLED_USERS = 1000;
const skilledUsers = new Map<string, number>();

export function resetToolCallCounter(userId?: string): void {
  if (userId) {
    userToolCounters.delete(userId);
  } else {
    userToolCounters.clear();
  }
}

export function getToolCallCounter(userId?: string): number {
  if (userId) {
    return userToolCounters.get(userId) ?? 0;
  }
  return 0;
}

export async function dispatchToolCall(
  toolName: string,
  params: Record<string, unknown>,
  userId: string = "user",
  skipPolicyCheck: boolean = false,
  context?: DispatchContext,
): Promise<ToolCallResult> {
  const resolvedToolName = resolveToolName(toolName);
  const handler = TOOL_HANDLERS[resolvedToolName];
  if (!handler) {
    const mode = (params._mode as string) || "productivity";
    const prefix = toolName.includes(".") ? toolName.split(".")[0] : null;
    let hint = "";
    if (prefix) {
      const categoryTools = getToolsByCategory(mode, prefix);
      if (categoryTools.length > 0) {
        const names = categoryTools.map((t) => t.name).slice(0, 10).join(", ");
        const more = categoryTools.length > 10 ? ` (and ${categoryTools.length - 10} more)` : "";
        hint = ` Available '${prefix}' tools: ${names}${more}.`;
      } else {
        const categories = Object.keys(getToolCategories(mode));
        hint = ` No tools found for prefix '${prefix}'. Available categories: ${categories.join(", ")}.`;
      }
    }
    return {
      success: false,
      error: `Unknown tool: Tool '${toolName}' does not exist.${hint} Use discover_tools to see all available tools.`,
    };
  }

  if (!skipPolicyCheck && !SYSTEM_TOOLS.has(resolvedToolName)) {
    const toolDef = getToolByName(
      resolvedToolName,
      (params._mode as string) || "productivity",
    );
    const actionType = toolDef?.actionType || resolvedToolName;

    const action = {
      id: `action-${Date.now()}`,
      type: actionType,
      description: `Execute ${resolvedToolName}`,
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
        error: `Action "${resolvedToolName}" is blocked by policy: ${decision.reason}. This action cannot be performed.`,
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
        error: `⚠️ This action requires your approval before proceeding.\n\n**Action:** ${resolvedToolName}\n**Approval ID:** ${approvalRequest.id}\n**Risk Level:** ${decision.riskLevel}\n**Reason:** ${decision.reason}\n\nSay "approve ${approvalRequest.id}" to allow this action, or "reject ${approvalRequest.id}" to deny it.`,
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
  if (context?.messages && !SYSTEM_TOOLS.has(resolvedToolName)) {
    const intent = detectPlatformIntent(context.messages);
    const alignment = validatePlatformAlignment(
      resolvedToolName,
      intent,
    );

    if (alignment.result === "warning") {
      await auditLogger.log({
        id: "",
        timestamp: new Date(),
        action: `platform.cross_contamination`,
        actor: userId,
        details: {
          toolName: resolvedToolName,
          toolPlatform: alignment.toolPlatform,
          intentPlatform: alignment.intentPlatform,
          reason: alignment.reason,
        },
        severity: "warn",
      });

      const toolDef = getToolByName(
        resolvedToolName,
        context.mode || (params._mode as string) || "productivity",
      );
      const actionType = toolDef?.actionType || resolvedToolName;

      const action = {
        id: `action-${Date.now()}`,
        type: actionType,
        description: `Execute ${resolvedToolName} (platform mismatch: ${alignment.reason})`,
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

    // Self-nudge: after every 15 tool calls per user, remind the agent to consider memory updates
    const currentCount = userToolCounters.get(userId) ?? 0;
    const newCount = currentCount + 1;
    // Evict oldest entries if the map exceeds the limit
    if (userToolCounters.size >= MAX_COUNTER_ENTRIES && !userToolCounters.has(userId)) {
      const firstKey = userToolCounters.keys().next().value;
      if (firstKey !== undefined) userToolCounters.delete(firstKey);
    }
    userToolCounters.set(userId, newCount);
    if (result && typeof result === "object" && !Array.isArray(result) && newCount > 0 && newCount % MEMORY_NUDGE_INTERVAL === 0) {
      const nudge = "\n[Memory nudge] Consider whether your recent work revealed anything worth remembering. Use the memory tool to add, replace, or remove entries.";
      const existingMsg = typeof result.message === "string" ? result.message : "";
      result.message = existingMsg ? `${existingMsg}${nudge}` : nudge.trim();
      console.log(`[AgentMemory] nudge fired for user ${userId} at call count ${newCount}`);
    }

    // Skill suggestion: after 5+ tool calls in a turn, suggest codifying as a skill (once per session)
    if (
      result &&
      typeof result === "object" &&
      newCount >= SKILL_SUGGEST_THRESHOLD &&
      !skilledUsers.has(userId)
    ) {
      if (skilledUsers.size >= MAX_SKILLED_USERS) {
        const oldest = skilledUsers.keys().next().value;
        if (oldest !== undefined) skilledUsers.delete(oldest);
      }
      skilledUsers.set(userId, Date.now());
      const skillNudge = "\n[Skill suggestion] You just completed a multi-step task. Consider whether this workflow is worth saving as a reusable skill using the skill.manage tool.";
      result.message = result.message ? `${result.message}${skillNudge}` : skillNudge.trim();
    }

    await auditLogger.log({
      id: "",
      timestamp: new Date(),
      action: `tool.${resolvedToolName}`,
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
      action: `tool.${resolvedToolName}`,
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
