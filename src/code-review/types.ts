export type ReviewRiskLevel = "low" | "medium" | "high" | "critical";

export type ReviewRecommendation =
  | "ready_for_human_review"
  | "needs_changes"
  | "low_risk"
  | "high_risk_hold";

export type ReleaseGoNoGo = "go" | "no_go" | "conditional_go";

export interface ChangedFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
  patch?: string;
}

export interface ChangeSet {
  platform: "github" | "gitlab";
  title: string;
  description: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  url: string;
  files: ChangedFile[];
  linesAdded: number;
  linesRemoved: number;
  ciStatus: "success" | "failed" | "pending" | "unknown";
  existingComments: string[];
  hasMigration: boolean;
  hasTests: boolean;
  hasConfigChange: boolean;
}

export interface CodeReview {
  prUrl: string;
  title: string;
  author: string;
  platform: "github" | "gitlab";
  riskLevel: ReviewRiskLevel;
  recommendation: ReviewRecommendation;
  whatChanged: string;
  mustFix: string[];
  shouldFix: string[];
  testGaps: string[];
  securityConcerns: string[];
  observabilityConcerns: string[];
  migrationRisks: string[];
  rollbackConsiderations: string[];
  suggestedReviewComment: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  ciStatus: string;
  generatedAt: string;
}

export interface ReleaseReadinessReport {
  title: string;
  platform: "github" | "gitlab";
  prUrl: string;
  recommendation: ReleaseGoNoGo;
  summary: string;
  includedChanges: string[];
  knownRisks: string[];
  testStatus: string;
  deploymentNotes: string[];
  rollbackPlan: string;
  customerImpact: string;
  internalCommsDraft: string;
  generatedAt: string;
}

export interface GitHubPRReviewInput {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface GitLabMRReviewInput {
  projectId: string | number;
  mrIid: number;
}

export interface ReleaseReadinessInput {
  platform: "github" | "gitlab";
  owner?: string;
  repo?: string;
  prNumber?: number;
  projectId?: string | number;
  mrIid?: number;
  notes?: string;
}
