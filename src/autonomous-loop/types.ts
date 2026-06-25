/**
 * Shared types for the autonomous-loop pipeline.
 *
 * Centralised here so every module can import without pulling in
 * the full aicoder.ts initialisation side effects.
 */

export interface ServerConfig {
  owner: string;
  repo: string;
  source: string;
  apiUrl: string;
  apiKey: string;
}

export interface WorkItem {
  id: string;
  number: number;
  title: string;
  url: string;
  owner: string;
  repo: string;
  suggestedBranch: string;
  labels?: string[];
  body?: string;
  /**
   * Sprint name when the source provides one (Jira mainly — Sprint custom
   * field rendered as the sprint name, not the internal id). Surfaced on
   * the runner card so users can see "SIEM-8 is in Sprint 12" without
   * leaving the UI. Null when unknown or when the source has no concept
   * of sprints (GitHub, work_items, etc.).
   */
  sprint?: string | null;
}

export interface GeneratedPrompt {
  prompt: string;
  skipped: boolean;
  skipReason: string | null;
}

export interface RunResult {
  finDetected: boolean;
  exitCode: number | null;
  ranTests?: boolean;
  sessionId?: string;
  stderr?: string;
}

export type TestSuiteKind = "unit" | "integration" | "all";
export type TestSuiteOutcome = "pass" | "fail" | "timeout" | "spawn_error";

export interface TestSuiteResult {
  passed: boolean;
  output: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  error: string | null;
  kind: TestSuiteOutcome;
}

export type PipelineCheckpoint =
  | "issue_transitioned"
  | "branch_checked_out"
  | "baseline_tests_pass"
  | "agent_complete"
  | "changes_committed"
  | "tests_passed"
  | "branch_pushed"
  | "pr_created"
  | "review_polling"
  | "rework_agent_complete"
  | "rework_committed"
  | "rework_tests_passed"
  | "rework_pushed";

export interface RunState {
  issueKey: string;
  issueNumber: number;
  title: string;
  url: string;
  owner: string;
  repo: string;
  suggestedBranch: string;
  labels?: string[];
  source: "github" | "gitlab" | "jira" | "work_items";
  checkpoint: PipelineCheckpoint;
  fromBranch?: string;
  sessionId?: string;
  agentRanTests?: boolean;
  prNumber?: number;
  reworkCount?: number;
  promptStrategiesTried?: string[];
  sinceTimestamp?: string;
  convergenceState?: {
    roundNumber: number;
    previousFindings: string[];
    identicalCount: Record<string, number>;
    emptyPRCount: number;
    findingsResolved: number;
    findingsNew: number;
    noProgressCount: number;
    lastRoundFindings: string[];
    roundSummaries?: Array<{
      roundNumber: number;
      findingsCount: number;
      prHadChanges: boolean;
      changedFiles: string[];
      diffStat?: string;
      note?: string;
    }>;
  };
  apiUrl: string;
  apiKey: string;
  startedAt: string;
  updatedAt: string;
}

export interface ProjectConfig {
  type: "node" | "python" | "rust" | "go" | "make" | "unknown";
  testCommand: string[];
  unitTestCommand: string[];
  integrationTestCommand: string[];
  coverageCommand: string[];
  buildCommand: string[];
  hasTests: boolean;
}

/** Minimal logger surface used by pipeline modules. */
export interface PipelineLogger {
  logGit(action: string, detail?: string): void;
  logError(message: string): void;
  logConfig(message: string): void;
  logWork(message: string): void;
  logAgent(message: string): void;
}
