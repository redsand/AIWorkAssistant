import { fileCalendarService } from "../integrations/file/calendar-service";
import { jiraService } from "../integrations/jira/jira-service";
import { jiraClient } from "../integrations/jira/jira-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { dailyPlanner } from "../productivity/daily-planner";
import { auditLogger } from "../audit/logger";
import { env } from "../config/env";

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

async function handleGitlabListMergeRequests(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const mrs = await gitlabClient.getMergeRequests(params.status as string);
  return { success: true, data: mrs };
}

async function handleGitlabGetCommit(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const commit = await gitlabClient.getCommit(
    params.projectId as string,
    params.sha as string,
  );
  return { success: true, data: commit };
}

async function handleDailyPlan(
  params: Record<string, unknown>,
  userId: string,
): Promise<ToolCallResult> {
  const date = params.date ? new Date(params.date as string) : new Date();
  const plan = await dailyPlanner.generatePlan(date, userId);
  return { success: true, data: plan };
}

type ToolHandler = (
  params: Record<string, unknown>,
  userId: string,
) => Promise<ToolCallResult>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  "calendar.list_events": handleCalendarListEvents,
  "calendar.create_focus_block": handleCalendarCreateFocusBlock,
  "calendar.create_health_block": handleCalendarCreateHealthBlock,
  "jira.list_assigned": handleJiraListAssigned,
  "jira.get_issue": handleJiraGetIssue,
  "jira.add_comment": handleJiraAddComment,
  "jira.transition_issue": handleJiraTransitionIssue,
  "jira.create_project": handleJiraCreateProject,
  "jira.get_project": handleJiraGetProject,
  "jira.list_projects": handleJiraListProjects,
  "gitlab.list_merge_requests": handleGitlabListMergeRequests,
  "gitlab.get_commit": handleGitlabGetCommit,
  "productivity.generate_daily_plan": handleDailyPlan,
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
