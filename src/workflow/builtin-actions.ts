import type { WorkflowAction } from "./types.js";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value as object)) {
      deepFreeze((value as Record<string | symbol, unknown>)[key]);
    }
  }
  return value;
}

const actions: WorkflowAction[] = [
  {
    id: "daily-standup-prep",
    name: "Daily Standup Prep",
    description:
      "Gather today's calendar events, assigned Jira tickets, and open GitLab MRs for standup preparation",
    category: "productivity",
    riskLevel: "low",
    params: [
      {
        name: "date",
        description: "ISO date for standup prep",
        type: "string",
        required: false,
        defaultValue: "today",
      },
    ],
    steps: [
      {
        tool: "calendar.list_events",
        params: { startDate: "{{date}}", endDate: "{{date}}" },
        onError: "continue",
        outputKey: "calendar",
      },
      {
        tool: "jira.list_assigned",
        params: { status: "In Progress" },
        onError: "continue",
        outputKey: "jira",
      },
      {
        tool: "gitlab.list_merge_requests",
        params: { state: "opened" },
        onError: "continue",
        outputKey: "gitlab",
      },
    ],
    tags: ["calendar", "jira", "gitlab", "standup"],
    version: "1.0.0",
    approvalRequired: false,
  },
  {
    id: "triage-support-ticket",
    name: "Triage Support Ticket",
    description:
      "Summarize a Jitbit ticket, check for similar cases, and create a work item for tracking",
    category: "triage",
    riskLevel: "low",
    params: [
      {
        name: "ticketId",
        description: "Jitbit ticket ID",
        type: "number",
        required: true,
      },
    ],
    steps: [
      {
        tool: "jitbit.get_ticket",
        params: { ticketId: "{{ticketId}}" },
        onError: "stop",
        outputKey: "ticket",
      },
      {
        tool: "jitbit.summarize_ticket",
        params: { ticketId: "{{ticketId}}" },
        onError: "stop",
        outputKey: "summary",
      },
      {
        tool: "work_items.create",
        params: {
          type: "support",
          title: "Triage: {{summary.subject}}",
          description: "{{summary.summary}}",
          priority: "medium",
          source: "jitbit",
          tags: ["auto-triage"],
        },
        onError: "continue",
        outputKey: "workItem",
      },
    ],
    tags: ["jitbit", "support", "triage"],
    version: "1.0.0",
    approvalRequired: false,
  },
  {
    id: "escalate-hawk-ir-case",
    name: "Escalate HAWK IR Case",
    description:
      "Create a work item for an escalated HAWK IR case and add a case note",
    category: "response",
    riskLevel: "medium",
    params: [
      {
        name: "caseId",
        description: "HAWK IR case ID",
        type: "string",
        required: true,
      },
      {
        name: "escalationReason",
        description: "Reason for escalation",
        type: "string",
        required: true,
      },
    ],
    steps: [
      {
        tool: "hawk_ir.get_case",
        params: { caseId: "{{caseId}}" },
        onError: "stop",
        outputKey: "case",
      },
      {
        tool: "work_items.create",
        params: {
          type: "detection",
          title: "Escalate: {{case.title}}",
          description: "Case {{caseId}} escalated: {{escalationReason}}",
          priority: "high",
          source: "hawk-ir",
          tags: ["escalation"],
        },
        onError: "stop",
        outputKey: "workItem",
      },
      {
        tool: "hawk_ir.add_note",
        params: {
          caseId: "{{caseId}}",
          note: "Escalated via AIWorkAssistant (work item {{workItem.id}}): {{escalationReason}}",
        },
        onError: "continue",
        outputKey: "caseNote",
      },
    ],
    tags: ["hawk-ir", "escalation", "security"],
    version: "1.0.0",
    approvalRequired: true,
  },
  {
    id: "weekly-product-update",
    name: "Weekly Product Update",
    description:
      "Generate a weekly product update from roadmap progress, work items, and customer signals",
    category: "reporting",
    riskLevel: "low",
    params: [
      {
        name: "weekStart",
        description: "ISO date for week start",
        type: "string",
        required: false,
        defaultValue: "this-week",
      },
    ],
    steps: [
      {
        tool: "product.weekly_update",
        params: { weekStart: "{{weekStart}}" },
        onError: "stop",
        outputKey: "update",
      },
    ],
    tags: ["product", "roadmap", "reporting"],
    version: "1.0.0",
    approvalRequired: false,
  },
];

// Built-in actions are deep-frozen so they cannot be modified at runtime.
export const builtinActions: readonly WorkflowAction[] = deepFreeze(actions);
