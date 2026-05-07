import type { WorkItemCreateParams } from "../work-items/types";

export interface ProjectAssessmentParams {
  includeGitHub?: boolean;
  includeGitLab?: boolean;
  includeJira?: boolean;
  includeJitbit?: boolean;
  includeRoadmap?: boolean;
  includeWorkItems?: boolean;
  includeAgentRuns?: boolean;
}

export interface ProjectAssessmentResult {
  markdown: string;
  suggestedWorkItems: WorkItemCreateParams[];
  sources: Record<string, { enabled: boolean; available: boolean; error?: string }>;
  stats: {
    totalWorkItems: number;
    completedWorkItems: number;
    blockedWorkItems: number;
    overdueWorkItems: number;
    activeRoadmaps: number;
    openJiraTickets: number;
    openPRs: number;
    openMRs: number;
    recentCommits: number;
    agentRunSuccessRate: number;
  };
}