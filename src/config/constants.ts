/**
 * System constants used across the application
 */

export const AGENT_NAME = "AI Assistant";

export const AGENT_VERSION = "0.1.0";

export const AGENT_MODES = {
  PRODUCTIVITY: "productivity",
  ENGINEERING: "engineering",
  MUSICIAN: "musician",
} as const;

export const RISK_LEVELS = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
} as const;

export const POLICY_RESULTS = {
  ALLOW: "allow",
  APPROVAL_REQUIRED: "approval_required",
  BLOCKED: "blocked",
} as const;

export const APPROVAL_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  EXECUTED: "executed",
  FAILED: "failed",
} as const;

export const AUDIT_ACTIONS = {
  PROPOSED: "proposed",
  POLICY_EVALUATED: "policy_evaluated",
  APPROVAL_REQUESTED: "approval_requested",
  APPROVED: "approved",
  REJECTED: "rejected",
  EXECUTED: "executed",
  FAILED: "failed",
  BLOCKED: "blocked",
} as const;

export const JIRA_TRANSITIONS = {
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  IN_REVIEW: "In Review",
  DONE: "Done",
  CLOSED: "Closed",
} as const;

export const CALENDAR_EVENT_TYPES = {
  FOCUS: "focus",
  FITNESS: "fitness",
  MEAL: "meal",
  MENTAL_HEALTH: "mental_health",
  MEETING: "meeting",
} as const;

export const GITLAB_WEBHOOK_EVENTS = {
  PUSH: "Push Hook",
  MERGE_REQUEST: "Merge Request Hook",
  MERGE_REQUEST_MERGED: "Merge Request Hook",
} as const;

export const GITHUB_DEFAULTS = {
  OWNER_ENV: "GITHUB_DEFAULT_OWNER",
  REPO_ENV: "GITHUB_DEFAULT_REPO",
} as const;
