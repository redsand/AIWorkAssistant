import { RISK_LEVELS, POLICY_RESULTS } from '../config/constants';

/**
 * Platform identifiers derived from tool namespaces
 */
export type Platform =
  | 'github'
  | 'gitlab'
  | 'jira'
  | 'jitbit'
  | 'calendar'
  | 'web'
  | 'local'
  | 'lsp'
  | 'codex'
  | 'mcp'
  | 'hawk-ir'
  | 'cross-platform';

/**
 * Result of detecting which platform the user's conversation is focused on
 */
export interface PlatformIntent {
  /** The primary platform, or null if ambiguous */
  platform: Platform | null;
  /** How the platform was determined */
  source: 'explicit' | 'inferred' | 'sticky' | 'none';
  /** Human-readable evidence string */
  evidence: string;
}

/**
 * Result of validating a tool call against the user's platform intent
 */
export interface PlatformValidation {
  result: 'allowed' | 'warning';
  toolPlatform: Platform;
  intentPlatform: Platform | null;
  reason: string;
  /** Suggested alternative tools on the user's intended platform */
  suggestedAlternatives?: string[];
}

/**
 * Action type represents a requested operation
 */
export type ActionType = string;

/**
 * Risk level for an action (using values, not keys)
 */
export type RiskLevel = typeof RISK_LEVELS[keyof typeof RISK_LEVELS];

/**
 * Policy evaluation result (using values, not keys)
 */
export type PolicyResult = typeof POLICY_RESULTS[keyof typeof POLICY_RESULTS];

/**
 * A proposed action awaiting policy evaluation
 */
export interface Action {
  id: string;
  type: ActionType;
  description: string;
  params: Record<string, unknown>;
  userId: string;
  timestamp: Date;
  /** Set by platform alignment check when a mismatch is detected */
  platformMismatch?: {
    toolPlatform: string;
    intentPlatform: string | null;
    source: string;
    evidence: string;
    suggestedAlternatives?: string[];
  };
}

/**
 * Result of policy evaluation
 */
export interface PolicyDecision {
  action: Action;
  result: PolicyResult;
  riskLevel: RiskLevel;
  reason: string;
  applicablePolicy?: string;
}

/**
 * Approval request
 */
export interface ApprovalRequest {
  id: string;
  action: Action;
  decision: PolicyDecision;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  requestedAt: Date;
  respondedAt?: Date;
  responseBy?: string;
  executionResult?: ExecutionResult;
}

/**
 * Result of executing an approved action
 */
export interface ExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  executedAt: Date;
}

/**
 * Audit log entry
 */
export interface AuditEntry {
  id: string;
  timestamp: Date;
  action: string;
  actor: string;
  details: Record<string, unknown>;
  severity: 'debug' | 'info' | 'warn' | 'error';
}
