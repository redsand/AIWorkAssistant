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
  pattern: string;           // Action pattern (e.g., "jira.*.read")
  riskLevel: 'low' | 'medium' | 'high';
  defaultResult: 'allow' | 'approval_required' | 'blocked';
  description: string;
}

export const DEFAULT_POLICIES: PolicyRule[] = [
  // ===== READ-ONLY ACTIONS (ALLOWED) =====
  {
    pattern: '*.read',
    riskLevel: 'low',
    defaultResult: 'allow',
    description: 'All read-only operations',
  },
  {
    pattern: 'calendar.event.list',
    riskLevel: 'low',
    defaultResult: 'allow',
    description: 'List calendar events',
  },
  {
    pattern: 'jira.issue.read',
    riskLevel: 'low',
    defaultResult: 'allow',
    description: 'Read Jira issue details',
  },
  {
    pattern: 'jira.issue.search',
    riskLevel: 'low',
    defaultResult: 'allow',
    description: 'Search Jira issues',
  },
  {
    pattern: 'gitlab.*.read',
    riskLevel: 'low',
    defaultResult: 'allow',
    description: 'Read GitLab resources',
  },

  // ===== DRAFTING/PLANNING (ALLOWED) =====
  {
    pattern: '*.draft',
    riskLevel: 'low',
    defaultResult: 'allow',
    description: 'Draft plans, comments, tickets',
  },
  {
    pattern: 'productivity.plan.generate',
    riskLevel: 'low',
    defaultResult: 'allow',
    description: 'Generate daily/weekly plans',
  },
  {
    pattern: 'engineering.workflow.brief',
    riskLevel: 'low',
    defaultResult: 'allow',
    description: 'Generate workflow briefs',
  },
  {
    pattern: 'engineering.architecture.proposal',
    riskLevel: 'low',
    defaultResult: 'allow',
    description: 'Generate architecture proposals',
  },

  // ===== JIRA: MEDIUM-RISK ACTIONS =====
  {
    pattern: 'jira.comment.create',
    riskLevel: 'medium',
    defaultResult: 'approval_required',
    description: 'Post comment to Jira issue',
  },
  {
    pattern: 'jira.issue.create',
    riskLevel: 'medium',
    defaultResult: 'approval_required',
    description: 'Create new Jira issue',
  },
  {
    pattern: 'jira.issue.update',
    riskLevel: 'medium',
    defaultResult: 'approval_required',
    description: 'Update Jira issue fields',
  },
  {
    pattern: 'jira.issue.assign',
    riskLevel: 'medium',
    defaultResult: 'approval_required',
    description: 'Assign Jira issue',
  },
  {
    pattern: 'jira.issue.label',
    riskLevel: 'medium',
    defaultResult: 'approval_required',
    description: 'Add labels to Jira issue',
  },

  // ===== JIRA: HIGH-RISK ACTIONS =====
  {
    pattern: 'jira.issue.transition',
    riskLevel: 'high',
    defaultResult: 'approval_required',
    description: 'Transition Jira issue status',
  },
  {
    pattern: 'jira.issue.close',
    riskLevel: 'high',
    defaultResult: 'approval_required',
    description: 'Close Jira issue',
  },
  {
    pattern: 'jira.issue.delete',
    riskLevel: 'high',
    defaultResult: 'blocked',
    description: 'Delete Jira issue (always blocked)',
  },

  // ===== CALENDAR: MEDIUM-RISK ACTIONS =====
  {
    pattern: 'calendar.event.create',
    riskLevel: 'medium',
    defaultResult: 'approval_required',
    description: 'Create calendar event',
  },
  {
    pattern: 'calendar.event.update',
    riskLevel: 'medium',
    defaultResult: 'approval_required',
    description: 'Update calendar event',
  },
  {
    pattern: 'calendar.focus_block.create',
    riskLevel: 'medium',
    defaultResult: 'approval_required',
    description: 'Create focus block',
  },
  {
    pattern: 'calendar.health_block.create',
    riskLevel: 'medium',
    defaultResult: 'approval_required',
    description: 'Create health/fitness/mental health block',
  },

  // ===== CALENDAR: HIGH-RISK ACTIONS =====
  {
    pattern: 'calendar.event.move_with_attendees',
    riskLevel: 'high',
    defaultResult: 'approval_required',
    description: 'Move meeting with attendees',
  },
  {
    pattern: 'calendar.event.delete',
    riskLevel: 'high',
    defaultResult: 'blocked',
    description: 'Delete calendar event (blocked unless policy override)',
  },
  {
    pattern: 'calendar.event.cancel',
    riskLevel: 'high',
    defaultResult: 'approval_required',
    description: 'Cancel calendar event',
  },

  // ===== GITLAB ACTIONS =====
  {
    pattern: 'gitlab.webhook.process',
    riskLevel: 'low',
    defaultResult: 'allow',
    description: 'Process GitLab webhook',
  },
  {
    pattern: 'gitlab.jira_link.auto_comment',
    riskLevel: 'medium',
    defaultResult: 'approval_required',
    description: 'Auto-post Jira comment from GitLab activity',
  },
  {
    pattern: 'gitlab.jira_link.auto_transition',
    riskLevel: 'high',
    defaultResult: 'approval_required',
    description: 'Auto-transition Jira issue based on GitLab activity',
  },

  // ===== BULK/DESTRUCTIVE ACTIONS =====
  {
    pattern: '*.bulk',
    riskLevel: 'high',
    defaultResult: 'blocked',
    description: 'Bulk operations (blocked unless explicitly allowed)',
  },
  {
    pattern: '*.destructive',
    riskLevel: 'high',
    defaultResult: 'blocked',
    description: 'Destructive operations (always blocked)',
  },
  {
    pattern: 'shell.*',
    riskLevel: 'high',
    defaultResult: 'blocked',
    description: 'Shell commands (blocked in production)',
  },
];

/**
 * Mode-specific policy overrides
 */
export const MODE_OVERRIDES: Record<string, Partial<PolicyRule>[]> = {
  strict: [
    {
      pattern: 'jira.comment.create',
      defaultResult: 'approval_required',
    },
    {
      pattern: 'jira.issue.create',
      defaultResult: 'approval_required',
    },
    {
      pattern: 'calendar.health_block.create',
      defaultResult: 'approval_required',
    },
  ],
  permissive: [
    {
      pattern: 'jira.comment.create',
      defaultResult: 'allow',
    },
    {
      pattern: 'jira.issue.create',
      defaultResult: 'allow',
    },
    {
      pattern: 'calendar.health_block.create',
      defaultResult: 'allow',
    },
  ],
};
