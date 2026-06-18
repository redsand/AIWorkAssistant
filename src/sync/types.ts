export interface JitbitSyncInput {
  days?: number;
  categoryId?: number;
  companyId?: number;
  maxItems?: number;
}

export interface JitbitSyncOutput {
  synced: number;
  skipped: number;
  errors: number;
  items: Array<{
    workItemId: string;
    jitbitTicketId: number;
    title: string;
  }>;
}

export interface JitbitTicket {
  id: number;
  subject: string;
  body?: string;
  priority?: number;
  categoryId?: number;
  statusId?: number;
  assignedToUserId?: number;
}

export interface JitbitSyncConfig {
  autoSyncEnabled: boolean;
  syncIntervalMinutes: number;
  defaultPriority: "low" | "medium" | "high" | "critical";
  defaultType:
    | "task"
    | "decision"
    | "code_review"
    | "roadmap"
    | "customer_followup"
    | "detection"
    | "research"
    | "personal"
    | "support"
    | "release";
  defaultSource:
    | "chat"
    | "jira"
    | "github"
    | "gitlab"
    | "jitbit"
    | "calendar"
    | "manual"
    | "roadmap";
  categoryMapping: Record<number, string>;
}
