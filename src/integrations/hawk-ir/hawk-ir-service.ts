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
  CaseRiskLevel,
} from "./types";

const riskPriority: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

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
    return this.client.getCases(params);
  }

  async getCase(caseId: string): Promise<HawkCase | null> {
    return this.client.getCase(caseId);
  }

  async getCaseSummary(caseId: string): Promise<HawkCaseSummary | null> {
    return this.client.getCaseSummary(caseId);
  }

  async getCaseCount(): Promise<number> {
    return this.client.getCaseCount();
  }

  async getRecentCases(limit = 20): Promise<HawkCase[]> {
    const cases = await this.client.getCases({ limit });
    return cases.slice(0, limit);
  }

  /**
   * Returns open high-risk unescalated cases — the primary CTO Command Center signal.
   * These are security incidents that are serious but haven't generated a Jitbit ticket.
   */
  async getRiskyOpenCases(params: {
    minRiskLevel?: CaseRiskLevel;
    limit?: number;
  } = {}): Promise<HawkCase[]> {
    const minRiskLevel = params.minRiskLevel ?? "high";
    const limit = params.limit ?? 25;
    const minPriority = riskPriority[minRiskLevel] ?? 3;

    const cases = await this.client.getCases({ limit: Math.min(limit * 4, 100) });

    return cases
      .filter((c) => {
        const risk = String(c.riskLevel ?? c["risk_level"] ?? "low").toLowerCase();
        const status = String(c.progressStatus ?? c["progress_status"] ?? "").toLowerCase();
        const escalated = c.escalated ?? c["escalated"] ?? false;
        return (riskPriority[risk] ?? 0) >= minPriority && !escalated && status !== "closed" && status !== "resolved";
      })
      .sort((a, b) => {
        const ra = String(a.riskLevel ?? a["risk_level"] ?? "low").toLowerCase();
        const rb = String(b.riskLevel ?? b["risk_level"] ?? "low").toLowerCase();
        return (riskPriority[rb] ?? 0) - (riskPriority[ra] ?? 0);
      })
      .slice(0, limit);
  }

  async deescalateCase(caseId: string, reason: string, note?: string): Promise<any> {
    return this.client.deescalateCase(caseId, reason, note);
  }

  // === Explore ===

  async searchLogs(params: HawkExploreSearchParams): Promise<HawkExploreResult[]> {
    return this.client.search(params);
  }

  async getLogHistogram(params: HawkExploreSearchParams): Promise<HawkHistogramBucket[]> {
    return this.client.histogram(params);
  }

  async getAvailableIndexes(): Promise<string[]> {
    return this.client.getAvailableIndexes();
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

  async runDashboardWidget(dashboardId: string, body?: Record<string, unknown>): Promise<HawkDashboardRunResult> {
    return this.client.runDashboardWidget(dashboardId, body);
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
