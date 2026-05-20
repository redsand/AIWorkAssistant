import type { Recipe } from "./types.js";

export const builtinRecipes: Recipe[] = [
  {
    id: "triage-new-ticket",
    name: "Triage New Support Ticket",
    description:
      "Summarize a new support ticket, check for similar cases, and create a work item",
    category: "triage",
    tags: ["jitbit", "support", "auto-triage"],
    version: "1.0.0",
    variables: [
      {
        name: "ticketId",
        description: "Jitbit ticket ID",
        type: "number",
        required: true,
      },
      {
        name: "priority",
        description: "Override priority",
        type: "string",
        required: false,
      },
    ],
    steps: [
      {
        id: "get-ticket",
        tool: "jitbit.get_ticket",
        params: { ticketId: "{{ticketId}}" },
        onError: "stop",
      },
      {
        id: "summarize",
        tool: "jitbit.summarize_ticket",
        params: { ticketId: "{{ticketId}}" },
        onError: "stop",
      },
      {
        id: "create-work-item",
        tool: "work_items.create",
        params: {
          type: "support",
          title: "Triage: {{summarize.subject}}",
          description: "{{summarize.summary}}",
          priority: "{{priority}}",
          source: "jitbit",
          tags: ["auto-triage", "jitbit-{{ticketId}}"],
        },
        onError: "continue",
      },
    ],
  },
  {
    id: "escalate-hawk-ir-case",
    name: "Escalate HAWK IR Case",
    description:
      "Create a work item for an escalated HAWK IR case and add a note",
    category: "response",
    tags: ["hawk-ir", "escalation", "security"],
    version: "1.0.0",
    variables: [
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
        id: "get-case",
        tool: "hawk_ir.get_case",
        params: { caseId: "{{caseId}}" },
        onError: "stop",
      },
      {
        id: "create-work-item",
        tool: "work_items.create",
        params: {
          type: "detection",
          title: "Escalate: {{case.title}}",
          description: "Case {{caseId}} escalated: {{escalationReason}}",
          priority: "high",
          source: "hawk-ir",
          tags: ["escalation", "hawk-ir-{{caseId}}"],
        },
        onError: "stop",
      },
      {
        id: "add-note",
        tool: "hawk_ir.add_case_note",
        params: {
          caseId: "{{caseId}}",
          note: "Escalated: {{escalationReason}}. Work item created.",
        },
        onError: "continue",
      },
    ],
  },
  {
    id: "daily-standup-prep",
    name: "Daily Standup Prep",
    description:
      "Gather today's calendar, Jira tickets, and recent GitLab activity for standup",
    category: "reporting",
    tags: ["calendar", "jira", "gitlab", "standup"],
    version: "1.0.0",
    variables: [
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
        id: "get-calendar",
        tool: "calendar.list_events",
        params: { startDate: "{{date}}", endDate: "{{date}}" },
        onError: "continue",
      },
      {
        id: "get-jira",
        tool: "jira.list_assigned",
        params: { status: "In Progress" },
        onError: "continue",
      },
      {
        id: "get-gitlab",
        tool: "gitlab.list_merge_requests",
        params: { state: "opened" },
        onError: "continue",
      },
    ],
  },
];
