// === Case Types ===

export type CaseRiskLevel = "low" | "medium" | "moderate" | "high" | "critical" | "informational";
export type CaseProgressStatus = "new" | "open" | "in_progress" | "closed" | "resolved";

export interface HawkCase {
  rid: string;
  name: string;
  groupId: string;
  riskLevel: CaseRiskLevel;
  progressStatus: CaseProgressStatus;
  category: string | string[] | null;
  owner: string | null;
  ownerName: string | null;
  escalated: boolean;
  escalationTicket: string | null;
  escalationModule: string | null;
  escalationId: string | null;
  escalationTimestamp: string | null;
  firstSeen: string;
  lastSeen: string;
  ipSrcs: string[];
  ipDsts: string[];
  alertNames: string[];
  analytics: any[];
  summary: string | null;
  rootCause: string | null;
  feedback: string | null;
  feedbackDetails: string | null;
  actions: any[];
  notes: any[];
  events: HawkCaseEvent[];
  linkedCount: number;
  [key: string]: unknown;
}

export interface HawkCaseEvent {
  dateAdded: string;
  priority: number;
  weight: number;
  alertName: string;
  alertsTypeName: string;
  count: number;
  blocked: boolean;
  eventId: string;
  [key: string]: unknown;
}

export interface HawkCaseSummary {
  rid: string;
  name: string;
  progressStatus: string;
  ipSrcs: string[];
  ipDsts: string[];
  alertNames: string[];
  analytics: any[];
  [key: string]: unknown;
}

export interface HawkCasesParams {
  startDate?: string;
  stopDate?: string;
  groupId?: string;
  limit?: number;
  offset?: number;
}

// === Explore Types ===

export interface HawkExploreSearchParams {
  q: string;
  idx?: string;
  from?: string;
  to?: string | null;
  offset?: number;
  size?: number;
  sort?: "asc" | "desc";
  interval?: string;
}

export interface HawkExploreResult {
  [key: string]: unknown;
}

export interface HawkHistogramBucket {
  time: string;
  count: number;
}

export interface HawkSavedSearch {
  rid: string;
  name: string;
  query: string;
  public: boolean;
  groupId: string;
  userId: string;
  givenName?: string;
  familyName?: string;
  added: string;
  updated: string;
}

// === Asset Types ===

export interface HawkAsset {
  rid: string;
  asset: string;
  hostname: string;
  group: string;
  tags: string[];
  adapters: string[];
  specificData?: {
    data: {
      name?: string;
      osType?: string;
      lastSeen?: string;
      networkInterfacesIps?: string[];
    };
  };
  indexed: boolean;
  lastSeen: string;
  [key: string]: unknown;
}

export interface HawkAssetsParams {
  limit?: number;
  offset?: number;
  search?: string;
  sort?: "name" | "last_seen";
  sortDir?: "asc" | "desc";
  includeSummary?: boolean;
}

export interface HawkAssetsResult {
  rows: HawkAsset[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  } | null;
  summary: HawkAssetSummary | null;
}

export interface HawkAssetSummary {
  tags: { label: string; value: number }[];
  osTypes: { label: string; value: number }[];
  adapters: { label: string; value: number }[];
}

// === Identity Types ===

export interface HawkIdentity {
  rid: string;
  username: string;
  group: string;
  tags: string[];
  adapters: string[];
  isAdmin: boolean | string;
  specificData?: {
    data: {
      domain?: string;
      mail?: string;
      lastSeen?: string;
    };
  };
  indexed: boolean;
  lastSeen: string;
  [key: string]: unknown;
}

export interface HawkIdentitiesParams {
  limit?: number;
  offset?: number;
  search?: string;
  sort?: "name" | "last_seen";
  sortDir?: "asc" | "desc";
  includeSummary?: boolean;
}

export interface HawkIdentitiesResult {
  rows: HawkIdentity[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  } | null;
  summary: HawkIdentitySummary | null;
}

export interface HawkIdentitySummary {
  tags: { label: string; value: number }[];
  admin: { label: string; value: number }[];
  adapters: { label: string; value: number }[];
}

// === Artefact Types ===

export interface HawkArtefact {
  rid?: string;
  group_id: string;
  key: string;
  type: string;
  module: string;
  value?: unknown;
  dateAdded?: string;
  dateUpdated?: string;
  [key: string]: unknown;
}

export interface HawkArtefactsParams {
  asset?: string;
}

// === Dashboard Types ===

export interface HawkDashboard {
  id: string;
  name: string;
  description?: string;
  group?: string;
  widgets: HawkDashboardWidget[];
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface HawkDashboardWidget {
  id: string;
  title: string;
  type: "table" | "bar" | "line" | "pie" | "count" | "metric" | string;
  query: string;
  index?: string;
  columns?: string[];
  groupBy?: string[];
  metrics?: { field: string; operator: string }[];
  size?: number;
  [key: string]: unknown;
}

export interface HawkDashboardRunResult {
  widgetId: string;
  rows?: any[];
  buckets?: any[];
  count?: number;
  total?: number;
  [key: string]: unknown;
}

export interface MonthlySummaryWindow {
  /** Inclusive start of this 10-day window (ISO string). */
  from: string;
  /** Inclusive end of this 10-day window (ISO string). */
  to: string;
  /** Human label e.g. "Week 1 (May 1 – May 10)". */
  label: string;
  /** Total matching records in this window. */
  total: number;
  /** Breakdown by a grouped field (e.g. riskLevel → count). */
  breakdown: Record<string, number>;
  /** Whether this window's query succeeded. */
  partial: boolean;
  /** Error message if the query failed. */
  error?: string;
}

export interface MonthlySummary {
  /** ISO date range actually queried. */
  rangeFrom: string;
  rangeTo: string;
  /** Number of 10-day windows that make up this summary. */
  windowCount: number;
  /** Per-window detail. */
  windows: MonthlySummaryWindow[];
  /** Aggregate total across all windows. */
  totalEvents: number;
  /** Aggregate breakdown across all windows. */
  totalBreakdown: Record<string, number>;
  /** Week-over-week deltas (windows[n].total - windows[n+1].total). Positive = increase. */
  weekOverWeekDeltas: number[];
  /** True if any window returned partial/failed data. */
  hasPartialData: boolean;
  /** Field used for the groupBy breakdown. */
  groupByField: string;
}
