import type { WorkItem, WorkItemCreateParams } from "../work-items/types";

export interface WeeklyDigestParams {
  weekStart?: string; // ISO date, defaults to Monday of current week
  includeJira?: boolean;
  includeGitLab?: boolean;
  includeGitHub?: boolean;
  includeJitbit?: boolean;
  includeHawkIr?: boolean;
  includeRoadmap?: boolean;
  includeWorkItems?: boolean;
  includeCalendar?: boolean;
  includeMemory?: boolean;
}

export interface WeeklyDigestResult {
  weekStart: string;
  weekEnd: string;
  markdown: string;
  suggestedWorkItems: WorkItemCreateParams[];
  sources: Record<string, { enabled: boolean; available: boolean; error?: string }>;
}

export interface WeeklyDigestData {
  calendar: any[];
  jira: any[];
  gitlab: { mergeRequests: any[]; pipelines: any[]; commits: any[] };
  github: { pullRequests: any[]; workflowRuns: any[]; commits: any[]; releases: any[] };
  roadmaps: Array<any & { milestones?: any[] }>;
  workItems: WorkItem[];
  jitbit: { recent: any[]; followups: any[]; highPriority: any[] };
  hawkIr: { riskyOpenCases: any[]; caseCount: number; recentCases: any[]; activeNodes: any[] };
  memories: string[];
  agentRuns: { total: number; failed: number; lastWeek: number };
}