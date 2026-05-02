/**
 * Default policy configuration for the agent.
 *
 * Policies are evaluated based on:
 * - Action type (e.g., jira.comment.create, calendar.event.delete)
 * - Risk level (low, medium, high)
 * - Current mode (strict, balanced, permissive)
 *
 * Policy results:
 * - allow: Action can proceed automatically
 * - approval_required: Action must be approved by user
 * - blocked: Action cannot be performed
 */

export interface PolicyRule {
  pattern: string;
  riskLevel: "low" | "medium" | "high";
  defaultResult: "allow" | "approval_required" | "blocked";
  description: string;
}

export const DEFAULT_POLICIES: PolicyRule[] = [
  // ===== READ-ONLY (ALLOWED) =====
  {
    pattern: "*.read",
    riskLevel: "low",
    defaultResult: "allow",
    description: "All read-only operations",
  },
  {
    pattern: "calendar.event.list",
    riskLevel: "low",
    defaultResult: "allow",
    description: "List calendar events",
  },
  {
    pattern: "jira.issue.read",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Read Jira issue details",
  },
  {
    pattern: "jira.issue.search",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Search Jira issues",
  },
  {
    pattern: "gitlab.*.read",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Read GitLab resources",
  },

  // ===== DRAFTING/PLANNING (ALLOWED) =====
  {
    pattern: "*.draft",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Draft plans, comments, tickets",
  },
  {
    pattern: "productivity.plan.generate",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Generate daily/weekly plans",
  },
  {
    pattern: "engineering.workflow.brief",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Generate workflow briefs",
  },
  {
    pattern: "engineering.architecture.proposal",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Generate architecture proposals",
  },

  // ===== JIRA: ALL ALLOWED (your agent, your tickets) =====
  {
    pattern: "jira.comment.create",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Post comment to Jira issue",
  },
  {
    pattern: "jira.issue.create",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Create new Jira issue",
  },
  {
    pattern: "jira.issue.update",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Update Jira issue fields",
  },
  {
    pattern: "jira.issue.assign",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Assign Jira issue",
  },
  {
    pattern: "jira.issue.label",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Add labels to Jira issue",
  },
  {
    pattern: "jira.issue.transition",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Transition Jira issue status",
  },
  {
    pattern: "jira.issue.close",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Close Jira issue",
  },

  // ===== JIRA: DELETES REQUIRE APPROVAL =====
  {
    pattern: "jira.issue.delete",
    riskLevel: "high",
    defaultResult: "approval_required",
    description: "Delete Jira issue (requires approval)",
  },

  // ===== CALENDAR: ALL ALLOWED =====
  {
    pattern: "calendar.event.create",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Create calendar event",
  },
  {
    pattern: "calendar.event.update",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Update calendar event",
  },
  {
    pattern: "calendar.focus_block.create",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Create focus block",
  },
  {
    pattern: "calendar.health_block.create",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Create health/fitness/mental health block",
  },
  {
    pattern: "calendar.event.move_with_attendees",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Move meeting with attendees",
  },
  {
    pattern: "calendar.event.cancel",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Cancel calendar event",
  },

  // ===== CALENDAR: DELETES REQUIRE APPROVAL =====
  {
    pattern: "calendar.event.delete",
    riskLevel: "high",
    defaultResult: "approval_required",
    description: "Delete calendar event (requires approval)",
  },

  // ===== GITLAB: ALL ALLOWED =====
  {
    pattern: "gitlab.webhook.process",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Process GitLab webhook",
  },
  {
    pattern: "gitlab.jira_link.auto_comment",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Auto-post Jira comment from GitLab activity",
  },
  {
    pattern: "gitlab.jira_link.auto_transition",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Auto-transition Jira issue based on GitLab activity",
  },

  // ===== BLOCKED: DANGEROUS ACTIONS =====
  {
    pattern: "*.bulk",
    riskLevel: "high",
    defaultResult: "blocked",
    description: "Bulk operations (blocked unless explicitly allowed)",
  },
  {
    pattern: "*.destructive",
    riskLevel: "high",
    defaultResult: "blocked",
    description: "Destructive operations (always blocked)",
  },
  {
    pattern: "shell.*",
    riskLevel: "high",
    defaultResult: "blocked",
    description: "Shell commands (blocked in production)",
  },
];

export const MODE_OVERRIDES: Record<string, Partial<PolicyRule>[]> = {
  strict: [],
  permissive: [],
};
