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

  // ===== JITBIT: DELETES REQUIRE APPROVAL =====
  {
    pattern: "jitbit.ticket.create",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Create Jitbit ticket",
  },
  {
    pattern: "jitbit.ticket.update",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Update Jitbit ticket (close, reopen, assign, merge, forward)",
  },
  {
    pattern: "jitbit.ticket.delete",
    riskLevel: "high",
    defaultResult: "approval_required",
    description: "Delete Jitbit ticket (requires approval)",
  },
  {
    pattern: "jitbit.ticket.comment",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Add comments to Jitbit tickets",
  },
  {
    pattern: "jitbit.asset.create",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Create Jitbit asset",
  },
  {
    pattern: "jitbit.asset.update",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Update Jitbit asset",
  },
  {
    pattern: "jitbit.asset.delete",
    riskLevel: "high",
    defaultResult: "approval_required",
    description: "Delete Jitbit asset (requires approval)",
  },
  {
    pattern: "jitbit.tag.manage",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Add and remove tags on Jitbit tickets",
  },
  {
    pattern: "jitbit.time.create",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Add time tracking entries to Jitbit tickets",
  },
  {
    pattern: "jitbit.automation.execute",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Trigger Jitbit automation rules",
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

  // ===== GITLAB: WRITE OPERATIONS (ALLOWED) =====
  {
    pattern: "gitlab.mr.create",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Create GitLab merge request",
  },
  {
    pattern: "gitlab.mr.merge",
    riskLevel: "high",
    defaultResult: "allow",
    description: "Accept/merge a GitLab merge request",
  },
  {
    pattern: "gitlab.mr.comment",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Comment on GitLab merge request",
  },
  {
    pattern: "gitlab.branch.create",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Create GitLab branch",
  },
  {
    pattern: "gitlab.file.write",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Create/update files in GitLab repository",
  },
  {
    pattern: "gitlab.issue.create",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Create GitLab issue",
  },
  {
    pattern: "gitlab.pipeline.write",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Retry/rerun GitLab CI/CD pipeline",
  },

  // ===== GITHUB: ALL ALLOWED =====
  {
    pattern: "github.*.read",
    riskLevel: "low",
    defaultResult: "allow",
    description: "All GitHub read operations",
  },
  {
    pattern: "github.repo.read",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Read GitHub repository data",
  },
  {
    pattern: "github.file.write",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Create/update files in GitHub repository",
  },
  {
    pattern: "github.branch.create",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Create GitHub branch",
  },
  {
    pattern: "github.pr.create",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Create GitHub pull request",
  },
  {
    pattern: "github.pr.merge",
    riskLevel: "high",
    defaultResult: "allow",
    description: "Merge GitHub pull request",
  },
  {
    pattern: "github.pr.comment",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Comment on GitHub pull request",
  },
  {
    pattern: "github.issue.create",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Create GitHub issue",
  },
  {
    pattern: "github.issue.update",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Update GitHub issue",
  },
  {
    pattern: "github.issue.comment",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Comment on GitHub issue",
  },
  {
    pattern: "github.actions.write",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Re-run GitHub Actions workflows",
  },
  {
    pattern: "github.release.create",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Create GitHub release",
  },
  {
    pattern: "github.code.search",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Search GitHub code",
  },

  // ===== HAWK IR: CASE READS ALLOWED, CASE WRITES REQUIRE APPROVAL =====
  {
    pattern: "hawk_ir.get_case_categories",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Read HAWK IR case categories",
  },
  {
    pattern: "hawk_ir.get_case_labels",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Read HAWK IR case labels and ignore labels",
  },
  {
    pattern: "hawk_ir.merge_cases",
    riskLevel: "high",
    defaultResult: "approval_required",
    description: "Merge duplicate HAWK IR cases",
  },
  {
    pattern: "hawk_ir.rename_case",
    riskLevel: "low",
    defaultResult: "approval_required",
    description: "Rename HAWK IR case",
  },
  {
    pattern: "hawk_ir.update_case_details",
    riskLevel: "medium",
    defaultResult: "approval_required",
    description: "Update HAWK IR case details",
  },
  {
    pattern: "hawk_ir.set_case_categories",
    riskLevel: "medium",
    defaultResult: "approval_required",
    description: "Set HAWK IR case categories",
  },
  {
    pattern: "hawk_ir.add_ignore_label",
    riskLevel: "high",
    defaultResult: "approval_required",
    description: "Add HAWK IR suppression/ignore label",
  },
  {
    pattern: "hawk_ir.delete_ignore_label",
    riskLevel: "high",
    defaultResult: "approval_required",
    description: "Delete HAWK IR suppression/ignore label",
  },

  // ===== ROADMAP: ALL ALLOWED =====
  {
    pattern: "roadmap.read",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Read roadmap data",
  },
  {
    pattern: "roadmap.write",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Create/update/delete roadmap data",
  },

  // ===== ENGINEERING: ALL ALLOWED =====
  {
    pattern: "engineering.*",
    riskLevel: "low",
    defaultResult: "allow",
    description:
      "All engineering tools (workflow briefs, architecture, scaffolding, Jira tickets)",
  },

  // ===== SYSTEM: ALL ALLOWED =====
  {
    pattern: "system.*",
    riskLevel: "low",
    defaultResult: "allow",
    description: "System tools (discover, approve, reject, list approvals)",
  },

  // ===== WEB SEARCH: ALLOWED =====
  {
    pattern: "web.search",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Search the web for information",
  },
  {
    pattern: "web.fetch",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Fetch and read web page content",
  },

  // ===== CODEX CLI: ALLOWED =====
  {
    pattern: "codex.run",
    riskLevel: "high",
    defaultResult: "allow",
    description: "Run Codex CLI coding agent for autonomous implementation",
  },

  // ===== TODO MANAGEMENT: ALLOWED =====
  {
    pattern: "todo.manage",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Create and manage todo/task lists",
  },

  // ===== KNOWLEDGE STORE: ALLOWED =====
  {
    pattern: "knowledge.manage",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Store information in the knowledge base",
  },
  {
    pattern: "knowledge.read",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Search and read from the knowledge base",
  },

  // ===== AGENT SPAWN: ALLOWED =====
  {
    pattern: "agent.spawn",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Spawn sub-agents for parallel task execution",
  },

  // ===== WORKFLOW ORCHESTRATION: ALLOWED =====
  {
    pattern: "workflow.manage",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Create and manage workflows",
  },
  {
    pattern: "workflow.execute",
    riskLevel: "medium",
    defaultResult: "allow",
    description: "Execute workflow phases via sub-agents",
  },

  // ===== LOCAL FILESYSTEM: READ-ONLY (ALLOWED) =====
  {
    pattern: "local.file.read",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Read local files from the project filesystem",
  },
  {
    pattern: "local.tree.read",
    riskLevel: "low",
    defaultResult: "allow",
    description: "List local directory tree structure",
  },
  {
    pattern: "local.code.search",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Search code patterns in local files",
  },

  // ===== MCP: ALLOWED =====
  {
    pattern: "mcp.call",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Call tools via MCP protocol",
  },
  {
    pattern: "mcp.list",
    riskLevel: "low",
    defaultResult: "allow",
    description: "List available MCP tools",
  },

  // ===== CODEBASE INDEX: ALLOWED =====
  {
    pattern: "codebase.search",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Search the indexed codebase",
  },
  {
    pattern: "codebase.stats",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Get codebase index statistics",
  },

  // ===== KNOWLEDGE GRAPH: ALLOWED =====
  {
    pattern: "graph.manage",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Manage knowledge graph nodes and edges",
  },
  {
    pattern: "graph.read",
    riskLevel: "low",
    defaultResult: "allow",
    description: "Query and explore the knowledge graph",
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

  // ===== PLATFORM CROSS-CONTAMINATION =====
  {
    pattern: "platform.cross_contamination",
    riskLevel: "medium",
    defaultResult: "approval_required",
    description:
      "Tool platform does not match user's stated platform intent (requires approval to prevent cross-platform mistakes)",
  },
];

export const MODE_OVERRIDES: Record<string, Partial<PolicyRule>[]> = {
  strict: [],
  permissive: [],
};
