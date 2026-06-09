import { hawkIrClient, HawkIrClient, HawkNode, HawkHybridResult } from "./hawk-ir-client";
import type {
  HawkCase,
  HawkCaseSummary,
  HawkCasesParams,
  HawkAssetsParams,
  HawkAssetsResult,
  HawkAssetSummary,
  HawkIdentitiesParams,
  HawkIdentitiesResult,
  HawkIdentitySummary,
  HawkExploreSearchParams,
  HawkExploreResult,
  HawkHistogramBucket,
  HawkSavedSearch,
  HawkArtefact,
  HawkArtefactsParams,
  HawkDashboard,
  HawkDashboardRunResult,
  MonthlySummaryWindow,
  MonthlySummary,
  CaseRiskLevel,
} from "./types";

const riskPriority: Record<string, number> = { low: 1, medium: 2, moderate: 2, high: 3, critical: 4, informational: 0 };

function isEscalated(c: HawkCase | any): boolean {
  const raw = c.escalated ?? c["escalated"];
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw.toLowerCase() === "true" || raw === "1";
  if (typeof raw === "number") return raw !== 0;
  return false;
}

const MAX_QUERY_RANGE_DAYS = 10;

export function todayRange(): { startDate: string; stopDate: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { startDate: start.toISOString(), stopDate: now.toISOString() };
}

export function enforceMaxRange(from: Date | string, to: Date | string): { from: string; to: string } {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const maxFrom = new Date(toDate.getTime() - MAX_QUERY_RANGE_DAYS * 24 * 60 * 60 * 1000);
  if (fromDate < maxFrom) {
    throw new Error(
      `Query range exceeds ${MAX_QUERY_RANGE_DAYS} days (from=${fromDate.toISOString()}, to=${toDate.toISOString()}). ` +
      `Maximum range starts at ${maxFrom.toISOString()}. Use weeklyReport() or monthlySummary() for longer periods.`,
    );
  }
  return { from: fromDate.toISOString(), to: toDate.toISOString() };
}

function last10Days(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - MAX_QUERY_RANGE_DAYS * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export class HawkIrService {
  constructor(private client: HawkIrClient = hawkIrClient) {}

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  async validateConfig(): Promise<boolean> {
    return this.client.validateConfig();
  }

  // === Cases ===

  async getCases(params: HawkCasesParams = {}): Promise<HawkCase[]> {
    if (!params.startDate) {
      const range = last10Days();
      params.startDate = range.from;
      if (!params.stopDate) params.stopDate = range.to;
    } else if (params.stopDate) {
      enforceMaxRange(params.startDate, params.stopDate);
    }
    return this.client.getCases(params);
  }

  async getCase(caseId: string): Promise<HawkCase | null> {
    return this.client.getCase(caseId);
  }

  async getCaseSummary(caseId: string): Promise<HawkCaseSummary | null> {
    return this.client.getCaseSummary(caseId);
  }

  /**
   * Returns the count of cases visible to this user within the last 10 days.
   * The backend's /api/cases/getUserCount only counts the API token user's own open cases,
   * which is typically 0. Instead, we fetch recent cases and count them.
   */
  async getCaseCount(): Promise<number> {
    const range = last10Days();
    const cases = await this.client.getCases({ startDate: range.from, stopDate: range.to, limit: 100 });
    return cases.length;
  }

  async getRecentCases(limit = 20, offset = 0): Promise<HawkCase[]> {
    const range = last10Days();
    const cases = await this.client.getCases({ limit, offset, startDate: range.from, stopDate: range.to });
    return cases.slice(0, limit);
  }

  /**
   * Returns open high-risk unescalated cases — the primary CTO Command Center signal.
   * These are security incidents that are serious but haven't generated a Jitbit ticket.
   * @param statuses - If provided, only include cases whose progressStatus matches one of these values.
   *                   Useful for escalation pipelines that should only notify on unhandled items (e.g. ["New"]).
   *                   When omitted, includes all non-closed/resolved statuses (New, Open, In Progress).
   */
  async getRiskyOpenCases(params: {
    minRiskLevel?: CaseRiskLevel;
    limit?: number;
    offset?: number;
    statuses?: string[];
  } = {}): Promise<HawkCase[]> {
    const minRiskLevel = params.minRiskLevel ?? "high";
    const limit = params.limit ?? 25;
    const offset = params.offset ?? 0;
    const minPriority = riskPriority[minRiskLevel] ?? 3;
    const range = last10Days();

    const cases = await this.client.getCases({
      limit: Math.min(limit * 4, 100),
      offset,
      startDate: range.from,
      stopDate: range.to,
    });

    const allowedStatuses = params.statuses
      ? params.statuses.map((s) => s.toLowerCase())
      : null;

    return cases
      .filter((c) => {
        const risk = String(c.riskLevel ?? c["risk_level"] ?? "low").toLowerCase();
        const status = String(c.progressStatus ?? c["progress_status"] ?? "").toLowerCase();
        const meetsRisk = (riskPriority[risk] ?? 0) >= minPriority;
        const notEscalated = !isEscalated(c);
        const notClosed = status !== "closed" && status !== "resolved";
        const statusAllowed = allowedStatuses ? allowedStatuses.includes(status) : true;
        return meetsRisk && notEscalated && notClosed && statusAllowed;
      })
      .sort((a, b) => {
        const ra = String(a.riskLevel ?? a["risk_level"] ?? "low").toLowerCase();
        const rb = String(b.riskLevel ?? b["risk_level"] ?? "low").toLowerCase();
        return (riskPriority[rb] ?? 0) - (riskPriority[ra] ?? 0);
      })
      .slice(0, limit);
  }

  /**
   * Returns cases that have been escalated — for customer briefings and escalation tracking.
   * Filters for escalated=true regardless of risk level, sorted by most recent first.
   */
  async getEscalatedCases(params: {
    limit?: number;
    offset?: number;
  } = {}): Promise<HawkCase[]> {
    const limit = params.limit ?? 25;
    const offset = params.offset ?? 0;
    const range = last10Days();

    const cases = await this.client.getCases({
      limit: Math.min(limit * 4, 100),
      offset,
      startDate: range.from,
      stopDate: range.to,
    });

    return cases
      .filter((c) => {
        const status = String(c.progressStatus ?? c["progress_status"] ?? "").toLowerCase();
        return isEscalated(c) && status !== "closed" && status !== "resolved";
      })
      .sort((a, b) => {
        const ta = String(a.escalationTimestamp ?? a["escalation_timestamp"] ?? a.lastSeen ?? "");
        const tb = String(b.escalationTimestamp ?? b["escalation_timestamp"] ?? b.lastSeen ?? "");
        return tb.localeCompare(ta);
      })
      .slice(0, limit);
  }

  async deescalateCase(caseId: string, reason: string, note?: string): Promise<any> {
    return this.client.deescalateCase(caseId, reason, note);
  }

  async getCaseCategories(): Promise<any[]> {
    return this.client.getCaseCategories();
  }

  async getCaseLabels(): Promise<{ categories: any[]; ignoreLabels: any[] }> {
    return this.client.getCaseLabels();
  }

  // === Case Management (Write) ===

  async addCaseNote(caseId: string, body: string): Promise<any> {
    return this.client.addCaseNote(caseId, body);
  }

  async updateCaseStatus(caseId: string, status: string): Promise<any> {
    const validStatuses = ["New", "Open", "In Progress", "Closed", "Resolved"];
    const statusMap: Record<string, string> = {
      new: "New",
      open: "Open",
      in_progress: "In Progress",
      inprogress: "In Progress",
      "in progress": "In Progress",
      closed: "Closed",
      resolved: "Resolved",
    };
    const mapped = statusMap[status.toLowerCase()] ?? status;
    if (!validStatuses.includes(mapped)) {
      throw new Error(`Invalid case status: "${status}". Valid statuses: ${validStatuses.join(", ")}`);
    }
    return this.client.updateCaseStatus(caseId, mapped);
  }

  async updateCaseRisk(caseId: string, riskLevel: string): Promise<any> {
    const validRiskLevels = ["Informational", "Low", "Moderate", "High", "Critical"];
    const riskMap: Record<string, string> = {
      informational: "Informational",
      low: "Low",
      medium: "Moderate",
      moderate: "Moderate",
      high: "High",
      critical: "Critical",
    };
    const mapped = riskMap[riskLevel.toLowerCase()];
    if (!mapped) {
      throw new Error(`Invalid risk level: "${riskLevel}". Valid levels: ${validRiskLevels.join(", ")}`);
    }
    return this.client.updateCaseRisk(caseId, mapped);
  }

  async escalateCase(caseId: string, type: string, vendor?: string, ticketId?: string): Promise<any> {
    const validTypes = ["vendor", "internal", "customer"];
    const mapped = type.toLowerCase();
    if (!validTypes.includes(mapped)) {
      throw new Error(`Invalid escalation type: "${type}". Valid types: ${validTypes.join(", ")}`);
    }
    return this.client.escalateCase(caseId, mapped, vendor, ticketId);
  }

  async assignCase(caseId: string, ownerId: string): Promise<any> {
    if (!ownerId || !ownerId.trim()) {
      throw new Error("ownerId is required and cannot be empty");
    }
    return this.client.assignCase(caseId, ownerId);
  }

  async mergeCases(sourceCaseId: string, targetCaseId: string): Promise<any> {
    if (!sourceCaseId || !sourceCaseId.trim()) {
      throw new Error("sourceCaseId is required");
    }
    if (!targetCaseId || !targetCaseId.trim()) {
      throw new Error("targetCaseId is required");
    }
    if (sourceCaseId.replace(/^#/, "") === targetCaseId.replace(/^#/, "")) {
      throw new Error("sourceCaseId and targetCaseId must be different");
    }
    return this.client.mergeCases(sourceCaseId, targetCaseId);
  }

  async renameCase(caseId: string, name: string): Promise<any> {
    if (!name || !name.trim()) {
      throw new Error("name is required and cannot be empty");
    }
    return this.client.renameCase(caseId, name);
  }

  async updateCaseDetails(caseId: string, details: string): Promise<any> {
    if (!details || !details.trim()) {
      throw new Error("details is required and cannot be empty");
    }
    return this.client.updateCaseDetails(caseId, details);
  }

  async setCaseCategories(caseId: string, categories: string[]): Promise<any> {
    if (!Array.isArray(categories) || categories.length === 0) {
      throw new Error("categories must be a non-empty array");
    }
    const normalized = categories.map((c) => String(c).trim()).filter(Boolean);
    if (normalized.length === 0) {
      throw new Error("categories must contain at least one non-empty value");
    }
    return this.client.setCaseCategories(caseId, normalized);
  }

  async addIgnoreLabel(label: string, category?: string): Promise<any> {
    if (!label || !label.trim()) {
      throw new Error("label is required and cannot be empty");
    }
    return this.client.addIgnoreLabel(label.trim(), category?.trim() || undefined);
  }

  async deleteIgnoreLabel(labelId: string): Promise<any> {
    if (!labelId || !labelId.trim()) {
      throw new Error("labelId is required and cannot be empty");
    }
    return this.client.deleteIgnoreLabel(labelId.trim());
  }

  async quarantineHost(caseId: string, target: string, options?: { type?: string; expires?: string }): Promise<any> {
    if (!target || !target.trim()) {
      throw new Error("target is required (IP address or hostname)");
    }
    return this.client.quarantineHost(caseId, target, options);
  }

  async unquarantineHost(caseId: string, target: string): Promise<any> {
    if (!target || !target.trim()) {
      throw new Error("target is required (IP address or hostname)");
    }
    const records = await this.client.getQuarantineRecords();
    const normalizedCaseId = "#" + caseId.replace(/^#/, "");
    const match = records.find((r: any) => {
      const objectMatch = r.object === target || r.object_highlight === target;
      const caseMatch = r.case_id === normalizedCaseId || r.case_id === caseId;
      return objectMatch && caseMatch && r.quarantine !== false;
    });
    if (!match) {
      throw new Error(`No active quarantine record found for target "${target}" on case ${caseId}`);
    }
    return this.client.unquarantineHost(match["@rid"], match.case_id, match.object_highlight || target);
  }

  // === Explore ===

  async searchLogs(params: HawkExploreSearchParams): Promise<HawkExploreResult[]> {
    if (!params.from) {
      const range = last10Days();
      params.from = range.from;
      if (!params.to) params.to = range.to;
    } else if (params.to) {
      enforceMaxRange(params.from, params.to);
    }
    return this.client.search(params);
  }

  async getLogHistogram(params: HawkExploreSearchParams): Promise<HawkHistogramBucket[]> {
    if (!params.from) {
      const range = last10Days();
      params.from = range.from;
      if (!params.to) params.to = range.to;
    } else if (params.to) {
      enforceMaxRange(params.from, params.to);
    }
    return this.client.histogram(params);
  }

  async getAvailableIndexes(): Promise<string[]> {
    return this.client.getAvailableIndexes();
  }

  async getFields(idx: string): Promise<string[]> {
    return this.client.getFields(idx);
  }

  async getSavedSearches(): Promise<HawkSavedSearch[]> {
    return this.client.getSavedSearches();
  }

  // === Assets ===

  async getAssets(params: HawkAssetsParams = {}): Promise<HawkAssetsResult> {
    return this.client.getAssets(params);
  }

  async getAssetSummary(): Promise<HawkAssetSummary> {
    return this.client.getAssetSummary();
  }

  // === Identities ===

  async getIdentities(params: HawkIdentitiesParams = {}): Promise<HawkIdentitiesResult> {
    return this.client.getIdentities(params);
  }

  async getIdentitySummary(): Promise<HawkIdentitySummary> {
    return this.client.getIdentitySummary();
  }

  // === Artefacts (WS) ===

  async getArtefacts(params: HawkArtefactsParams = {}): Promise<HawkArtefact[]> {
    return this.client.getArtefacts(params);
  }

  // === Nodes (WS — Admin/SysOp only) ===

  async listNodes(groupIds?: string[]): Promise<HawkNode[]> {
    return this.client.listNodes(groupIds);
  }

  /** Returns only online/active nodes, sorted by lastSeen desc. */
  async getActiveNodes(): Promise<HawkNode[]> {
    const nodes = await this.client.listNodes();
    return nodes
      .filter((n) => n.approval !== false)
      .sort((a, b) => {
        const ta = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
        const tb = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
        return tb - ta;
      });
  }

  // === Hybrid tool execution (WS — Admin/SOC) ===

  /**
   * Dispatches a hybrid investigation command to a HAWK node and returns the response.
   * Requires Admin or SOC privileges. Use targetNodeId to direct to a specific node.
   */
  async executeHybridTool(params: {
    groupId: string;
    cmd: string;
    data?: unknown;
    targetNodeId?: string;
    timeoutMs?: number;
  }): Promise<HawkHybridResult> {
    return this.client.executeHybrid(
      { groupId: params.groupId, cmd: params.cmd, data: params.data, targetNodeId: params.targetNodeId },
      params.timeoutMs,
    );
  }

  // === Dashboards ===

  async listDashboards(): Promise<HawkDashboard[]> {
    return this.client.listDashboards();
  }

  async runDashboardWidget(dashboardId: string, body: Record<string, unknown> = {}): Promise<HawkDashboardRunResult> {
    const timeRange = body.timeRange as { from?: string; to?: string } | undefined;
    if (timeRange?.from && timeRange?.to) {
      enforceMaxRange(timeRange.from, timeRange.to);
    }
    return this.client.runDashboardWidget(dashboardId, body);
  }

  /**
   * Run an ad-hoc dashboard query without needing a saved dashboard.
   * Enforces a maximum 10-day query range. Use weeklyReport() or
   * monthlySummary() for longer periods.
   */
  async runDashboardQuery(params: {
    query?: string;
    index?: string;
    from: string;
    to?: string;
    type?: "table" | "bar" | "line" | "pie" | "count" | "metric";
    columns?: string[];
    groupBy?: string[];
    metrics?: { field: string; operator: string }[];
    size?: number;
    sort?: { field: string; direction: "asc" | "desc" };
    pagination?: { limit?: number; offset?: number; page?: number };
  }): Promise<HawkDashboardRunResult> {
    const validated = enforceMaxRange(params.from, params.to ?? new Date().toISOString());

    const dashboards = await this.client.listDashboards();
    if (!dashboards.length) {
      throw new Error("No dashboards available for running queries");
    }
    const dashboardId = dashboards[0].id;
    return this.client.runDashboardWidget(dashboardId, {
      widget: {
        id: `ad-hoc-${Date.now()}`,
        title: "Ad-hoc Query",
        type: params.type ?? "table",
        query: params.query ?? "*",
        columns: params.columns ?? [],
        groupBy: params.groupBy ?? [],
        metrics: params.metrics ?? [{ field: "@timestamp", operator: "count" }],
        size: params.size ?? 25,
        sort: params.sort ?? { field: "@timestamp", direction: "desc" },
      },
      index: params.index,
      timeRange: { from: validated.from, to: validated.to },
      pagination: params.pagination,
    });
  }

  /**
   * Generate a weekly report covering the last 10 days (allows 3 days of overlap for summary runs).
   * Returns dashboard query results for the specified metrics and groupings.
   */
  async weeklyReport(params: {
    query?: string;
    index?: string;
    columns?: string[];
    groupBy?: string[];
    metrics?: { field: string; operator: string }[];
    size?: number;
  } = {}): Promise<HawkDashboardRunResult> {
    const range = last10Days();
    return this.runDashboardQuery({
      ...params,
      from: range.from,
      to: range.to,
    });
  }

  /**
   * Generate a monthly summary covering a user-specified date range.
   *
   * The range is sliced into non-overlapping 10-day windows (the API maximum).
   * Each window is queried independently; failures are caught per-window so partial
   * data is returned rather than nothing.  Results are pre-aggregated into a typed
   * MonthlySummary so the model receives structured metrics rather than raw JSON blobs.
   */
  async monthlySummary(params: {
    startDate?: string;
    endDate?: string;
    query?: string;
    index?: string;
    dashboardId?: string;
    groupByField?: string;
    metrics?: { field: string; operator: string }[];
  } = {}): Promise<MonthlySummary> {
    const rangeTo = params.endDate ? new Date(params.endDate) : new Date();
    const rangeFrom = params.startDate
      ? new Date(params.startDate)
      : new Date(rangeTo.getTime() - 30 * 24 * 60 * 60 * 1000);

    const groupByField = params.groupByField ?? "riskLevel";
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const WINDOW_MS = MAX_QUERY_RANGE_DAYS * MS_PER_DAY;

    // Build non-overlapping 10-day windows from oldest to newest.
    const windowBoundaries: { from: Date; to: Date }[] = [];
    let cursor = new Date(rangeFrom.getTime());
    while (cursor < rangeTo) {
      const windowEnd = new Date(Math.min(cursor.getTime() + WINDOW_MS, rangeTo.getTime()));
      windowBoundaries.push({ from: new Date(cursor), to: windowEnd });
      cursor = new Date(windowEnd.getTime());
    }

    // Resolve dashboard ID once — not on every iteration.
    let dashboardId = params.dashboardId;
    if (!dashboardId) {
      const dashboards = await this.client.listDashboards();
      if (!dashboards.length) {
        throw new Error("No dashboards available for running queries");
      }
      dashboardId = dashboards[0].id;
    }

    const windowResults: MonthlySummaryWindow[] = [];

    for (let i = 0; i < windowBoundaries.length; i++) {
      const { from, to } = windowBoundaries[i];
      const label = `Window ${i + 1} (${from.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${to.toLocaleDateString("en-US", { month: "short", day: "numeric" })})`;

      try {
        const result = await this.client.runDashboardWidget(dashboardId, {
          widget: {
            id: `monthly-w${i}-${Date.now()}`,
            title: label,
            type: "table",
            query: params.query ?? "*",
            columns: [groupByField],
            groupBy: [groupByField],
            metrics: params.metrics ?? [{ field: "@timestamp", operator: "count" }],
            size: 500,
            sort: { field: "@timestamp", direction: "desc" },
          },
          index: params.index,
          timeRange: { from: from.toISOString(), to: to.toISOString() },
        });

        // Build the breakdown map from whichever shape the API returned.
        const breakdown: Record<string, number> = {};
        const buckets: any[] = Array.isArray(result.buckets) ? result.buckets : [];
        const rows: any[] = Array.isArray(result.rows) ? result.rows : [];

        for (const bucket of buckets) {
          const key = String(bucket[groupByField] ?? bucket.key ?? bucket.name ?? "unknown");
          const count = Number(bucket.count ?? bucket.doc_count ?? bucket.value ?? 0);
          breakdown[key] = (breakdown[key] ?? 0) + count;
        }
        // Fall back to counting rows if buckets are absent.
        if (buckets.length === 0 && rows.length > 0) {
          for (const row of rows) {
            const key = String(row[groupByField] ?? "unknown");
            breakdown[key] = (breakdown[key] ?? 0) + 1;
          }
        }

        const total = result.total ?? result.count ?? Object.values(breakdown).reduce((s, n) => s + n, 0);

        windowResults.push({ from: from.toISOString(), to: to.toISOString(), label, total, breakdown, partial: false });
      } catch (err) {
        windowResults.push({
          from: from.toISOString(),
          to: to.toISOString(),
          label,
          total: 0,
          breakdown: {},
          partial: true,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Aggregate across all windows.
    const totalEvents = windowResults.reduce((s, w) => s + w.total, 0);
    const totalBreakdown: Record<string, number> = {};
    for (const w of windowResults) {
      for (const [k, v] of Object.entries(w.breakdown)) {
        totalBreakdown[k] = (totalBreakdown[k] ?? 0) + v;
      }
    }
    // Week-over-week deltas: windows are oldest→newest so delta[i] = window[i+1].total - window[i].total.
    const weekOverWeekDeltas = windowResults.slice(1).map((w, i) => w.total - windowResults[i].total);
    const hasPartialData = windowResults.some((w) => w.partial);

    return {
      rangeFrom: rangeFrom.toISOString(),
      rangeTo: rangeTo.toISOString(),
      windowCount: windowResults.length,
      windows: windowResults,
      totalEvents,
      totalBreakdown,
      weekOverWeekDeltas,
      hasPartialData,
      groupByField,
    };
  }

  // === Formatting ===

  formatCaseLabel(c: HawkCase | any): string {
    const rid = c["@rid"] || c.rid || "?";
    const name = c.name || "(unnamed)";
    const risk = c.riskLevel || c["risk_level"] || "unknown";
    const status = c.progressStatus || c["progress_status"] || "unknown";
    const owner = c.ownerName || c["owner_name"] || "unassigned";
    const esc = c.escalated ? " ⚠️ ESCALATED" : "";
    return `#${rid} ${name} (${risk} risk, ${status}, ${owner})${esc}`;
  }

  formatNodeLabel(n: HawkNode): string {
    const tasks = Array.isArray(n.availableTasks) ? n.availableTasks.length : 0;
    const tools = n.hybridTools?.tools?.length ?? 0;
    return `${n.hostname || n.id} (${n.platform || "?"}, ${n.address || "?"}, ${tasks} tasks, ${tools} hybrid tools)`;
  }
}

export const hawkIrService = new HawkIrService();
