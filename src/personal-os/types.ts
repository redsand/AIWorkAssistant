import type { WorkItem, WorkItemCreateParams } from "../work-items/types";

// --- Input types ---

export interface PersonalBriefParams {
  userId: string;
  date?: string;
  daysBack?: number;
  includeCalendar?: boolean;
  includeJira?: boolean;
  includeGitLab?: boolean;
  includeGitHub?: boolean;
  includeWorkItems?: boolean;
  includeJitbit?: boolean;
  includeRoadmap?: boolean;
  includeMemory?: boolean;
}

export interface PatternDetectionParams {
  userId: string;
  daysBack?: number;
}

export interface FocusBlockSuggestParams {
  userId: string;
  date?: string;
  minDurationMinutes?: number;
}

export interface OpenLoopParams {
  userId: string;
}

// --- Output types ---

export interface SourceStatus {
  enabled: boolean;
  available: boolean;
  error?: string;
}

export interface BriefData {
  calendar: any[];
  jira: any[];
  gitlab: {
    mergeRequests: any[];
    pipelines: any[];
    commits: any[];
  };
  github: {
    pullRequests: any[];
    workflowRuns: any[];
    commits: any[];
    releases: any[];
  };
  roadmaps: Array<any & { milestones?: any[] }>;
  workItems: WorkItem[];
  jitbit: {
    recent: any[];
    followups: any[];
    highPriority: any[];
  };
  memories: string[];
}

export interface TodaysLoadSection {
  calendarEventCount: number;
  openWorkItemCount: number;
  blockedWorkItemCount: number;
  waitingWorkItemCount: number;
  overdueWorkItemCount: number;
  openPRCount: number;
  openMRCount: number;
  highPriorityTicketCount: number;
  failedPipelineCount: number;
}

export interface OpenLoop {
  id: string;
  type: "task" | "decision" | "followup" | "approval";
  title: string;
  source: string;
  sourceUrl?: string;
  age?: string;
  urgency: "low" | "medium" | "high" | "critical";
}

export interface DecisionItem {
  title: string;
  source: string;
  sourceUrl?: string;
  context: string;
  waitingSince?: string;
}

export interface PatternMatch {
  pattern: string;
  frequency: string;
  category:
    | "recurring_task"
    | "context_switch"
    | "meeting_overload"
    | "support_spike"
    | "review_bottleneck";
  evidence: string[];
}

export interface DelegationCandidate {
  workItemId?: string;
  title: string;
  reason: string;
  delegatableTo: string;
  priority: "low" | "medium" | "high";
}

export interface FocusBlockSuggestion {
  startTime: string;
  durationMinutes: number;
  title: string;
  reason: string;
  priority: "low" | "medium" | "high";
}

export interface EnergyRisk {
  type:
    | "context_switch"
    | "meeting_overload"
    | "back_to_back"
    | "late_day_deep_work"
    | "no_breaks";
  description: string;
  severity: "low" | "medium" | "high";
  affectedTime?: string;
}

export interface StopSuggestion {
  title: string;
  reason: string;
  category: "meeting" | "habit" | "task" | "process";
}

export interface PersonalBriefResult {
  date: string;
  markdown: string;
  todaysLoad: TodaysLoadSection;
  openLoops: OpenLoop[];
  decisionsWaiting: DecisionItem[];
  recurringPatterns: PatternMatch[];
  suggestedDelegations: DelegationCandidate[];
  suggestedFocusBlocks: FocusBlockSuggestion[];
  energyRisks: EnergyRisk[];
  thingsToStop: StopSuggestion[];
  workItemsToCreate: WorkItemCreateParams[];
  sources: Record<string, SourceStatus>;
}

export type { WorkItem, WorkItemCreateParams };