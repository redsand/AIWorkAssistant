export type WorkItemType =
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

export type WorkItemStatus =
  | "proposed"
  | "planned"
  | "active"
  | "blocked"
  | "waiting"
  | "done"
  | "archived";

export type WorkItemPriority = "low" | "medium" | "high" | "critical";

export type WorkItemSource =
  | "chat"
  | "jira"
  | "github"
  | "gitlab"
  | "jitbit"
  | "calendar"
  | "manual"
  | "roadmap"
  | "hawk-ir";

export interface WorkItem {
  id: string;
  type: WorkItemType;
  title: string;
  description: string;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  owner: string;
  source: WorkItemSource;
  sourceUrl: string | null;
  sourceExternalId: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  tagsJson: string | null;
  linkedResourcesJson: string | null;
  notesJson: string | null;
  metadataJson: string | null;
}

export interface LinkedResource {
  type: "jira" | "github" | "gitlab" | "jitbit" | "calendar" | "roadmap" | "url";
  url: string;
  label: string;
}

export interface WorkItemNote {
  id: string;
  author: string;
  content: string;
  createdAt: string;
}

export interface WorkItemCreateParams {
  type: WorkItemType;
  title: string;
  description?: string;
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  owner?: string;
  source?: WorkItemSource;
  sourceUrl?: string;
  sourceExternalId?: string;
  dueAt?: string;
  tags?: string[];
  linkedResources?: LinkedResource[];
  metadata?: Record<string, unknown>;
}

export interface WorkItemUpdateParams {
  type?: WorkItemType;
  title?: string;
  description?: string;
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  owner?: string;
  source?: WorkItemSource;
  sourceUrl?: string | null;
  sourceExternalId?: string | null;
  dueAt?: string | null;
  tags?: string[];
  linkedResources?: LinkedResource[];
  metadata?: Record<string, unknown>;
}

export interface WorkItemListFilters {
  status?: WorkItemStatus;
  type?: WorkItemType;
  priority?: WorkItemPriority;
  source?: WorkItemSource;
  owner?: string;
  search?: string;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface WorkItemListResult {
  items: WorkItem[];
  total: number;
}

export interface WorkItemStats {
  totalItems: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  byPriority: Record<string, number>;
  overdue: number;
}

export type HandoffStatus = "running" | "completed" | "failed";

export interface WorkItemHandoffMeta {
  handoff: {
    handoffStatus: HandoffStatus;
    agent: string | null;
    branch: string | null;
    startedAt: string;
    completedAt?: string;
    exitCode?: number;
    filesChanged?: string[];
    commitMessages?: string[];
    runDurationMs?: number;
  };
}