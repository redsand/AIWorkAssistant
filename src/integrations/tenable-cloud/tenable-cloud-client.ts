import axios, { AxiosInstance } from "axios";
import { env } from "../../config/env";
import type {
  TenableRequestOptions,
  TenableVulnerability,
  TenableVulnExportFilter,
  TenableAsset,
  TenableAssetExportFilter,
  TenableExportStatus,
  TenableScan,
  TenableScanDetails,
  TenableScanTemplate,
  TenablePolicy,
  TenableNetwork,
  TenableTagCategory,
  TenableTagValue,
  TenableUser,
  TenableGroup,
  TenableAgent,
  TenableAgentGroup,
  TenableScanner,
  TenableExclusion,
  TenableCredential,
  TenablePluginFamily,
  TenablePlugin,
  TenableAlert,
  TenableAuditLog,
  TenableAccessGroup,
  TenableRemediationRule,
  TenableContainerImage,
  TenableWorkbenchAsset,
} from "./types";

const BASE_URL = "https://cloud.tenable.com";

export class TenableCloudClient {
  private http: AxiosInstance;
  private globalAccessKey: string;
  private globalSecretKey: string;

  constructor() {
    this.globalAccessKey = env.TENABLE_CLOUD_ACCESS_KEY;
    this.globalSecretKey = env.TENABLE_CLOUD_SECRET_KEY;

    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: 60_000,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    });
  }

  isConfigured(opts?: TenableRequestOptions): boolean {
    const ak = opts?.accessKey || this.globalAccessKey;
    const sk = opts?.secretKey || this.globalSecretKey;
    return !!(ak && sk);
  }

  private authHeader(opts?: TenableRequestOptions): string {
    const ak = opts?.accessKey || this.globalAccessKey;
    const sk = opts?.secretKey || this.globalSecretKey;
    return `accessKey=${ak};secretKey=${sk}`;
  }

  private headers(opts?: TenableRequestOptions): Record<string, string> {
    return { "X-ApiKeys": this.authHeader(opts) };
  }

  // ── Workbench: Vulnerabilities ─────────────────────────────────────────────

  async listVulnerabilities(params: {
    date_range?: number;
    filter_type?: "and" | "or";
    "filter.0.filter"?: string;
    "filter.0.quality"?: string;
    "filter.0.value"?: string;
    num_assets?: number;
    page?: number;
  } = {}, opts?: TenableRequestOptions): Promise<TenableVulnerability[]> {
    const r = await this.http.get("/workbenches/vulnerabilities", {
      headers: this.headers(opts),
      params,
    });
    return r.data.vulnerabilities ?? [];
  }

  async getVulnerabilityDetails(pluginId: number, opts?: TenableRequestOptions): Promise<unknown> {
    const r = await this.http.get(`/workbenches/vulnerabilities/${pluginId}/info`, {
      headers: this.headers(opts),
    });
    return r.data.info ?? r.data;
  }

  async exportVulnerabilities(filters: TenableVulnExportFilter = {}, opts?: TenableRequestOptions): Promise<{ export_uuid: string }> {
    const r = await this.http.post("/vulns/export", { filters }, { headers: this.headers(opts) });
    return r.data;
  }

  async getVulnExportStatus(exportUuid: string, opts?: TenableRequestOptions): Promise<TenableExportStatus> {
    const r = await this.http.get(`/vulns/export/${exportUuid}/status`, { headers: this.headers(opts) });
    return r.data;
  }

  async downloadVulnExportChunk(exportUuid: string, chunkId: number, opts?: TenableRequestOptions): Promise<TenableVulnerability[]> {
    const r = await this.http.get(`/vulns/export/${exportUuid}/chunks/${chunkId}`, { headers: this.headers(opts) });
    return r.data;
  }

  // ── Workbench: Assets ──────────────────────────────────────────────────────

  async listWorkbenchAssets(params: {
    date_range?: number;
    filter_type?: "and" | "or";
    num_assets?: number;
    page?: number;
  } = {}, opts?: TenableRequestOptions): Promise<TenableWorkbenchAsset[]> {
    const r = await this.http.get("/workbenches/assets", {
      headers: this.headers(opts),
      params,
    });
    return r.data.assets ?? [];
  }

  async getAssetVulnerabilities(assetId: string, params: {
    date_range?: number;
    filter_type?: "and" | "or";
  } = {}, opts?: TenableRequestOptions): Promise<TenableVulnerability[]> {
    const r = await this.http.get(`/workbenches/assets/${assetId}/vulnerabilities`, {
      headers: this.headers(opts),
      params,
    });
    return r.data.vulnerabilities ?? [];
  }

  // ── Assets ─────────────────────────────────────────────────────────────────

  async listAssets(
    params: { limit?: number; offset?: number } = {},
    opts?: TenableRequestOptions,
  ): Promise<TenableAsset[]> {
    const query: Record<string, number> = {};
    if (typeof params.limit === "number" && params.limit > 0) {
      query.limit = params.limit;
    }
    if (typeof params.offset === "number" && params.offset >= 0) {
      query.offset = params.offset;
    }
    const r = await this.http.get("/assets", {
      headers: this.headers(opts),
      params: query,
    });
    return r.data.assets ?? [];
  }

  /**
   * Walk every page of the /assets endpoint. Needed when the caller is
   * searching for a specific host that may not be on the first page.
   */
  async listAllAssets(opts?: TenableRequestOptions): Promise<TenableAsset[]> {
    const all: TenableAsset[] = [];
    const pageSize = 10000; // Tenable maximum
    let offset = 0;
    while (true) {
      const page = await this.listAssets({ limit: pageSize, offset }, opts);
      if (page.length === 0) break;
      all.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
    }
    return all;
  }

  async getAsset(assetId: string, opts?: TenableRequestOptions): Promise<TenableAsset> {
    const r = await this.http.get(`/assets/${assetId}`, { headers: this.headers(opts) });
    return r.data;
  }

  async deleteAsset(assetId: string, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/assets/${assetId}`, { headers: this.headers(opts) });
  }

  async importAssets(assets: unknown[], opts?: TenableRequestOptions): Promise<{ task_id: string }> {
    const r = await this.http.post("/assets/import", { source: "api", assets }, { headers: this.headers(opts) });
    return r.data;
  }

  async exportAssets(params: TenableAssetExportFilter = {}, opts?: TenableRequestOptions): Promise<{ export_uuid: string }> {
    const r = await this.http.post("/assets/export", params, { headers: this.headers(opts) });
    return r.data;
  }

  async getAssetExportStatus(exportUuid: string, opts?: TenableRequestOptions): Promise<TenableExportStatus> {
    // Legacy export namespace — must match the POST endpoint at /assets/export.
    // Was previously /exports/assets/... which returned 404 because the
    // export_uuid lives in the legacy namespace. Discovered 2026-06-11
    // in session a149093c after the chunk_size fix unblocked the POST.
    const r = await this.http.get(`/assets/export/${exportUuid}/status`, { headers: this.headers(opts) });
    return r.data;
  }

  async downloadAssetExportChunk(exportUuid: string, chunkId: number, opts?: TenableRequestOptions): Promise<TenableAsset[]> {
    const r = await this.http.get(`/assets/export/${exportUuid}/chunks/${chunkId}`, { headers: this.headers(opts) });
    return r.data;
  }

  async bulkDeleteAssets(query: unknown, opts?: TenableRequestOptions): Promise<{ task_id: string }> {
    const r = await this.http.post("/api/v2/assets/bulk-jobs/delete", { query }, { headers: this.headers(opts) });
    return r.data;
  }

  // ── Scans ──────────────────────────────────────────────────────────────────

  async listScans(params: { folder_id?: number } = {}, opts?: TenableRequestOptions): Promise<TenableScan[]> {
    const r = await this.http.get("/scans", { headers: this.headers(opts), params });
    return r.data.scans ?? [];
  }

  async getScan(scanId: number, opts?: TenableRequestOptions): Promise<TenableScanDetails> {
    const r = await this.http.get(`/scans/${scanId}`, { headers: this.headers(opts) });
    return r.data;
  }

  async createScan(settings: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenableScan> {
    const r = await this.http.post("/scans", { uuid: settings.template_uuid, settings }, { headers: this.headers(opts) });
    return r.data.scan ?? r.data;
  }

  async updateScan(scanId: number, settings: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenableScan> {
    const r = await this.http.put(`/scans/${scanId}`, { uuid: settings.template_uuid, settings }, { headers: this.headers(opts) });
    return r.data.scan ?? r.data;
  }

  async deleteScan(scanId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/scans/${scanId}`, { headers: this.headers(opts) });
  }

  async launchScan(scanId: number, altTargets?: string[], opts?: TenableRequestOptions): Promise<{ scan_uuid: string }> {
    const body = altTargets ? { alt_targets: altTargets } : {};
    const r = await this.http.post(`/scans/${scanId}/launch`, body, { headers: this.headers(opts) });
    return r.data;
  }

  async stopScan(scanId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.post(`/scans/${scanId}/stop`, {}, { headers: this.headers(opts) });
  }

  async pauseScan(scanId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.post(`/scans/${scanId}/pause`, {}, { headers: this.headers(opts) });
  }

  async resumeScan(scanId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.post(`/scans/${scanId}/resume`, {}, { headers: this.headers(opts) });
  }

  async copyScan(scanId: number, folderId?: number, opts?: TenableRequestOptions): Promise<TenableScan> {
    const body: Record<string, unknown> = {};
    if (folderId !== undefined) body.folder_id = folderId;
    const r = await this.http.post(`/scans/${scanId}/copy`, body, { headers: this.headers(opts) });
    return r.data;
  }

  async exportScan(scanId: number, format: string = "nessus", opts?: TenableRequestOptions): Promise<{ file: number; token?: string }> {
    const r = await this.http.post(`/scans/${scanId}/export`, { format }, { headers: this.headers(opts) });
    return r.data;
  }

  async importScan(file: string, folderId?: number, opts?: TenableRequestOptions): Promise<TenableScan> {
    const body: Record<string, unknown> = { file };
    if (folderId !== undefined) body.folder_id = folderId;
    const r = await this.http.post("/scans/import", body, { headers: this.headers(opts) });
    return r.data.scan ?? r.data;
  }

  async getScanHistory(scanId: number, opts?: TenableRequestOptions): Promise<TenableScanDetails["history"]> {
    const r = await this.http.get(`/scans/${scanId}`, { headers: this.headers(opts) });
    return r.data.history ?? [];
  }

  async listScanTemplates(opts?: TenableRequestOptions): Promise<TenableScanTemplate[]> {
    const r = await this.http.get("/editor/scan/templates", { headers: this.headers(opts) });
    return r.data.templates ?? [];
  }

  // ── Policies ───────────────────────────────────────────────────────────────

  async listPolicies(opts?: TenableRequestOptions): Promise<TenablePolicy[]> {
    const r = await this.http.get("/policies", { headers: this.headers(opts) });
    return r.data.policies ?? [];
  }

  async getPolicy(policyId: number, opts?: TenableRequestOptions): Promise<TenablePolicy> {
    const r = await this.http.get(`/policies/${policyId}`, { headers: this.headers(opts) });
    return r.data;
  }

  async createPolicy(settings: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenablePolicy> {
    const r = await this.http.post("/policies", settings, { headers: this.headers(opts) });
    return r.data;
  }

  async updatePolicy(policyId: number, settings: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenablePolicy> {
    const r = await this.http.put(`/policies/${policyId}`, settings, { headers: this.headers(opts) });
    return r.data;
  }

  async deletePolicy(policyId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/policies/${policyId}`, { headers: this.headers(opts) });
  }

  async copyPolicy(policyId: number, opts?: TenableRequestOptions): Promise<TenablePolicy> {
    const r = await this.http.post(`/policies/${policyId}/copy`, {}, { headers: this.headers(opts) });
    return r.data;
  }

  // ── Networks ───────────────────────────────────────────────────────────────

  async listNetworks(opts?: TenableRequestOptions): Promise<TenableNetwork[]> {
    const r = await this.http.get("/networks", { headers: this.headers(opts) });
    return r.data.networks ?? [];
  }

  async getNetwork(networkId: string, opts?: TenableRequestOptions): Promise<TenableNetwork> {
    const r = await this.http.get(`/networks/${networkId}`, { headers: this.headers(opts) });
    return r.data;
  }

  async createNetwork(params: { name: string; description?: string; assets_ttl_days?: number }, opts?: TenableRequestOptions): Promise<TenableNetwork> {
    const r = await this.http.post("/networks", params, { headers: this.headers(opts) });
    return r.data;
  }

  async updateNetwork(networkId: string, params: { name?: string; description?: string; assets_ttl_days?: number }, opts?: TenableRequestOptions): Promise<TenableNetwork> {
    const r = await this.http.put(`/networks/${networkId}`, params, { headers: this.headers(opts) });
    return r.data;
  }

  async deleteNetwork(networkId: string, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/networks/${networkId}`, { headers: this.headers(opts) });
  }

  async listNetworkScanners(networkId: string, opts?: TenableRequestOptions): Promise<TenableScanner[]> {
    const r = await this.http.get(`/networks/${networkId}/scanners`, { headers: this.headers(opts) });
    return r.data.scanners ?? [];
  }

  async assignScannerToNetwork(networkId: string, scannerId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.post(`/networks/${networkId}/scanners/${scannerId}`, {}, { headers: this.headers(opts) });
  }

  // ── Tags ───────────────────────────────────────────────────────────────────

  async listTagCategories(opts?: TenableRequestOptions): Promise<TenableTagCategory[]> {
    const r = await this.http.get("/tags/categories", { headers: this.headers(opts) });
    return r.data.categories ?? [];
  }

  async createTagCategory(params: { name: string; description?: string }, opts?: TenableRequestOptions): Promise<TenableTagCategory> {
    const r = await this.http.post("/tags/categories", params, { headers: this.headers(opts) });
    return r.data;
  }

  async updateTagCategory(categoryUuid: string, params: { name?: string; description?: string }, opts?: TenableRequestOptions): Promise<TenableTagCategory> {
    const r = await this.http.put(`/tags/categories/${categoryUuid}`, params, { headers: this.headers(opts) });
    return r.data;
  }

  async deleteTagCategory(categoryUuid: string, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/tags/categories/${categoryUuid}`, { headers: this.headers(opts) });
  }

  async listTagValues(categoryUuid?: string, opts?: TenableRequestOptions): Promise<TenableTagValue[]> {
    const params = categoryUuid ? { "f[0][type]": "eq", "f[0][property]": "category_uuid", "f[0][value]": categoryUuid } : {};
    const r = await this.http.get("/tags/values", { headers: this.headers(opts), params });
    return r.data.values ?? [];
  }

  async createTagValue(params: { category_uuid: string; value: string; description?: string }, opts?: TenableRequestOptions): Promise<TenableTagValue> {
    const r = await this.http.post("/tags/values", params, { headers: this.headers(opts) });
    return r.data;
  }

  async updateTagValue(valueUuid: string, params: { value?: string; description?: string }, opts?: TenableRequestOptions): Promise<TenableTagValue> {
    const r = await this.http.put(`/tags/values/${valueUuid}`, params, { headers: this.headers(opts) });
    return r.data;
  }

  async deleteTagValue(valueUuid: string, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/tags/values/${valueUuid}`, { headers: this.headers(opts) });
  }

  async assignTagsToAssets(assetUuids: string[], tagUuids: string[], opts?: TenableRequestOptions): Promise<{ job_uuid: string }> {
    const r = await this.http.post("/api/v3/assets/bulk-jobs/tag", {
      assets: assetUuids.map((uuid) => ({ id: uuid })),
      tags: tagUuids.map((uuid) => ({ uuid })),
      action: "add",
    }, { headers: this.headers(opts) });
    return r.data;
  }

  async removeTagsFromAssets(assetUuids: string[], tagUuids: string[], opts?: TenableRequestOptions): Promise<{ job_uuid: string }> {
    const r = await this.http.post("/api/v3/assets/bulk-jobs/tag", {
      assets: assetUuids.map((uuid) => ({ id: uuid })),
      tags: tagUuids.map((uuid) => ({ uuid })),
      action: "remove",
    }, { headers: this.headers(opts) });
    return r.data;
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  async listUsers(opts?: TenableRequestOptions): Promise<TenableUser[]> {
    const r = await this.http.get("/users", { headers: this.headers(opts) });
    return r.data.users ?? [];
  }

  async getUser(userId: number, opts?: TenableRequestOptions): Promise<TenableUser> {
    const r = await this.http.get(`/users/${userId}`, { headers: this.headers(opts) });
    return r.data;
  }

  async createUser(params: {
    username: string;
    password: string;
    permissions: number;
    name?: string;
    email?: string;
    type?: string;
  }, opts?: TenableRequestOptions): Promise<TenableUser> {
    const r = await this.http.post("/users", params, { headers: this.headers(opts) });
    return r.data;
  }

  async updateUser(userId: number, params: {
    permissions?: number;
    name?: string;
    email?: string;
    enabled?: boolean;
  }, opts?: TenableRequestOptions): Promise<TenableUser> {
    const r = await this.http.put(`/users/${userId}`, params, { headers: this.headers(opts) });
    return r.data;
  }

  async deleteUser(userId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/users/${userId}`, { headers: this.headers(opts) });
  }

  async getUserKeys(userId: number, opts?: TenableRequestOptions): Promise<{ accessKey: string; secretKey: string }> {
    const r = await this.http.get(`/users/${userId}/keys`, { headers: this.headers(opts) });
    return r.data;
  }

  async enableUser(userId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.post(`/users/${userId}/enabled`, {}, { headers: this.headers(opts) });
  }

  async disableUser(userId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.post(`/users/${userId}/disabled`, {}, { headers: this.headers(opts) });
  }

  // ── Groups ─────────────────────────────────────────────────────────────────

  async listGroups(opts?: TenableRequestOptions): Promise<TenableGroup[]> {
    const r = await this.http.get("/groups", { headers: this.headers(opts) });
    return r.data.groups ?? [];
  }

  async createGroup(name: string, opts?: TenableRequestOptions): Promise<TenableGroup> {
    const r = await this.http.post("/groups", { name }, { headers: this.headers(opts) });
    return r.data;
  }

  async updateGroup(groupId: number, name: string, opts?: TenableRequestOptions): Promise<TenableGroup> {
    const r = await this.http.put(`/groups/${groupId}`, { name }, { headers: this.headers(opts) });
    return r.data;
  }

  async deleteGroup(groupId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/groups/${groupId}`, { headers: this.headers(opts) });
  }

  async listGroupUsers(groupId: number, opts?: TenableRequestOptions): Promise<TenableUser[]> {
    const r = await this.http.get(`/groups/${groupId}/users`, { headers: this.headers(opts) });
    return r.data.users ?? [];
  }

  async addUserToGroup(groupId: number, userId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.post(`/groups/${groupId}/users/${userId}`, {}, { headers: this.headers(opts) });
  }

  async removeUserFromGroup(groupId: number, userId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/groups/${groupId}/users/${userId}`, { headers: this.headers(opts) });
  }

  // ── Scanners ───────────────────────────────────────────────────────────────

  async listScanners(opts?: TenableRequestOptions): Promise<TenableScanner[]> {
    const r = await this.http.get("/scanners", { headers: this.headers(opts) });
    return r.data.scanners ?? [];
  }

  async getScanner(scannerId: number, opts?: TenableRequestOptions): Promise<TenableScanner> {
    const r = await this.http.get(`/scanners/${scannerId}`, { headers: this.headers(opts) });
    return r.data;
  }

  async updateScanner(scannerId: number, params: { name?: string; link_permission?: boolean }, opts?: TenableRequestOptions): Promise<TenableScanner> {
    const r = await this.http.put(`/scanners/${scannerId}`, params, { headers: this.headers(opts) });
    return r.data;
  }

  async deleteScanner(scannerId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/scanners/${scannerId}`, { headers: this.headers(opts) });
  }

  async toggleScannerLink(scannerId: number, linked: boolean, opts?: TenableRequestOptions): Promise<void> {
    await this.http.put(`/scanners/${scannerId}/link`, { link: linked ? 1 : 0 }, { headers: this.headers(opts) });
  }

  // ── Agents ─────────────────────────────────────────────────────────────────

  async listAgents(params: { offset?: number; limit?: number } = {}, opts?: TenableRequestOptions): Promise<{ agents: TenableAgent[]; pagination: unknown }> {
    const r = await this.http.get("/agents", { headers: this.headers(opts), params });
    return r.data;
  }

  async listAllAgents(opts?: TenableRequestOptions): Promise<TenableAgent[]> {
    const all: TenableAgent[] = [];
    const pageSize = 10000;
    let offset = 0;
    while (true) {
      const page = await this.listAgents({ limit: pageSize, offset }, opts);
      const agents = page.agents ?? [];
      if (agents.length === 0) break;
      all.push(...agents);
      if (agents.length < pageSize) break;
      offset += pageSize;
    }
    return all;
  }

  async getAgent(agentId: number, opts?: TenableRequestOptions): Promise<TenableAgent> {
    const r = await this.http.get(`/agents/${agentId}`, { headers: this.headers(opts) });
    return r.data;
  }

  async deleteAgent(scannerId: number, agentId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/scanners/${scannerId}/agents/${agentId}`, { headers: this.headers(opts) });
  }

  async unlinkAgent(scannerId: number, agentId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/scanners/${scannerId}/agents/${agentId}`, { headers: this.headers(opts) });
  }

  async bulkDeleteAgents(scannerId: number, agentIds: number[], opts?: TenableRequestOptions): Promise<{ task_uuid: string }> {
    const r = await this.http.post(`/scanners/${scannerId}/agents/_bulk/delete`, {
      items: agentIds.map((id) => ({ id })),
    }, { headers: this.headers(opts) });
    return r.data;
  }

  async bulkUnlinkAgents(scannerId: number, agentIds: number[], opts?: TenableRequestOptions): Promise<{ task_uuid: string }> {
    const r = await this.http.post(`/scanners/${scannerId}/agents/_bulk/unlink`, {
      items: agentIds.map((id) => ({ id })),
    }, { headers: this.headers(opts) });
    return r.data;
  }

  async listAgentGroups(scannerId: number, opts?: TenableRequestOptions): Promise<TenableAgentGroup[]> {
    const r = await this.http.get(`/scanners/${scannerId}/agent-groups`, { headers: this.headers(opts) });
    return r.data.groups ?? [];
  }

  async createAgentGroup(scannerId: number, name: string, opts?: TenableRequestOptions): Promise<TenableAgentGroup> {
    const r = await this.http.post(`/scanners/${scannerId}/agent-groups`, { name }, { headers: this.headers(opts) });
    return r.data;
  }

  async updateAgentGroup(scannerId: number, groupId: number, name: string, opts?: TenableRequestOptions): Promise<TenableAgentGroup> {
    const r = await this.http.put(`/scanners/${scannerId}/agent-groups/${groupId}`, { name }, { headers: this.headers(opts) });
    return r.data;
  }

  async deleteAgentGroup(scannerId: number, groupId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/scanners/${scannerId}/agent-groups/${groupId}`, { headers: this.headers(opts) });
  }

  async addAgentToGroup(scannerId: number, groupId: number, agentId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.post(`/scanners/${scannerId}/agent-groups/${groupId}/agents/${agentId}`, {}, { headers: this.headers(opts) });
  }

  async removeAgentFromGroup(scannerId: number, groupId: number, agentId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/scanners/${scannerId}/agent-groups/${groupId}/agents/${agentId}`, { headers: this.headers(opts) });
  }

  // ── Exclusions ─────────────────────────────────────────────────────────────

  async listExclusions(opts?: TenableRequestOptions): Promise<TenableExclusion[]> {
    const r = await this.http.get("/exclusions", { headers: this.headers(opts) });
    return r.data.exclusions ?? [];
  }

  async createExclusion(params: {
    name: string;
    members: string;
    description?: string;
    schedule?: unknown;
  }, opts?: TenableRequestOptions): Promise<TenableExclusion> {
    const r = await this.http.post("/exclusions", params, { headers: this.headers(opts) });
    return r.data;
  }

  async getExclusion(exclusionId: number, opts?: TenableRequestOptions): Promise<TenableExclusion> {
    const r = await this.http.get(`/exclusions/${exclusionId}`, { headers: this.headers(opts) });
    return r.data;
  }

  async updateExclusion(exclusionId: number, params: {
    name?: string;
    members?: string;
    description?: string;
    schedule?: unknown;
  }, opts?: TenableRequestOptions): Promise<TenableExclusion> {
    const r = await this.http.put(`/exclusions/${exclusionId}`, params, { headers: this.headers(opts) });
    return r.data;
  }

  async deleteExclusion(exclusionId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/exclusions/${exclusionId}`, { headers: this.headers(opts) });
  }

  // ── Credentials ────────────────────────────────────────────────────────────

  async listCredentials(opts?: TenableRequestOptions): Promise<TenableCredential[]> {
    const r = await this.http.get("/credentials", { headers: this.headers(opts) });
    return r.data.credentials ?? [];
  }

  async getCredential(credentialUuid: string, opts?: TenableRequestOptions): Promise<TenableCredential> {
    const r = await this.http.get(`/credentials/${credentialUuid}`, { headers: this.headers(opts) });
    return r.data;
  }

  async createCredential(params: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenableCredential> {
    const r = await this.http.post("/credentials", params, { headers: this.headers(opts) });
    return r.data;
  }

  async updateCredential(credentialUuid: string, params: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenableCredential> {
    const r = await this.http.put(`/credentials/${credentialUuid}`, params, { headers: this.headers(opts) });
    return r.data;
  }

  async deleteCredential(credentialUuid: string, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/credentials/${credentialUuid}`, { headers: this.headers(opts) });
  }

  // ── Plugins ────────────────────────────────────────────────────────────────

  async listPluginFamilies(opts?: TenableRequestOptions): Promise<TenablePluginFamily[]> {
    const r = await this.http.get("/plugins/families", { headers: this.headers(opts) });
    return r.data.families ?? [];
  }

  async getPluginFamily(familyId: number, opts?: TenableRequestOptions): Promise<{ info: TenablePluginFamily; plugins: TenablePlugin[] }> {
    const r = await this.http.get(`/plugins/families/${familyId}`, { headers: this.headers(opts) });
    return r.data;
  }

  async getPlugin(pluginId: number, opts?: TenableRequestOptions): Promise<TenablePlugin> {
    const r = await this.http.get(`/plugins/plugin/${pluginId}`, { headers: this.headers(opts) });
    return r.data;
  }

  // ── Alerts ─────────────────────────────────────────────────────────────────

  async listAlerts(opts?: TenableRequestOptions): Promise<TenableAlert[]> {
    const r = await this.http.get("/alerts", { headers: this.headers(opts) });
    return r.data.alerts ?? [];
  }

  async getAlert(alertId: number, opts?: TenableRequestOptions): Promise<TenableAlert> {
    const r = await this.http.get(`/alerts/${alertId}`, { headers: this.headers(opts) });
    return r.data;
  }

  async createAlert(params: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenableAlert> {
    const r = await this.http.post("/alerts", params, { headers: this.headers(opts) });
    return r.data;
  }

  async updateAlert(alertId: number, params: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenableAlert> {
    const r = await this.http.put(`/alerts/${alertId}`, params, { headers: this.headers(opts) });
    return r.data;
  }

  async deleteAlert(alertId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/alerts/${alertId}`, { headers: this.headers(opts) });
  }

  async executeAlert(alertId: number, opts?: TenableRequestOptions): Promise<void> {
    await this.http.post(`/alerts/${alertId}/execute`, {}, { headers: this.headers(opts) });
  }

  // ── Audit Log ──────────────────────────────────────────────────────────────

  async getAuditLog(params: {
    limit?: number;
    offset?: number;
    "f[0][filter]"?: string;
    "f[0][quality]"?: string;
    "f[0][value]"?: string;
  } = {}, opts?: TenableRequestOptions): Promise<TenableAuditLog[]> {
    const r = await this.http.get("/audit-log/v1/events", { headers: this.headers(opts), params });
    return r.data.events ?? [];
  }

  // ── Access Groups ──────────────────────────────────────────────────────────

  async listAccessGroups(opts?: TenableRequestOptions): Promise<TenableAccessGroup[]> {
    const r = await this.http.get("/api/v3/access-groups", { headers: this.headers(opts) });
    return r.data.access_groups ?? [];
  }

  async getAccessGroup(groupId: string, opts?: TenableRequestOptions): Promise<TenableAccessGroup> {
    const r = await this.http.get(`/api/v3/access-groups/${groupId}`, { headers: this.headers(opts) });
    return r.data;
  }

  async createAccessGroup(params: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenableAccessGroup> {
    const r = await this.http.post("/api/v3/access-groups", params, { headers: this.headers(opts) });
    return r.data;
  }

  async updateAccessGroup(groupId: string, params: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenableAccessGroup> {
    const r = await this.http.put(`/api/v3/access-groups/${groupId}`, params, { headers: this.headers(opts) });
    return r.data;
  }

  async deleteAccessGroup(groupId: string, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/api/v3/access-groups/${groupId}`, { headers: this.headers(opts) });
  }

  // ── Remediation Rules ──────────────────────────────────────────────────────

  async listRemediationRules(opts?: TenableRequestOptions): Promise<TenableRemediationRule[]> {
    const r = await this.http.get("/workbenches/user_defined_rules", { headers: this.headers(opts) });
    return r.data.recast_rules ?? [];
  }

  async createRemediationRule(params: {
    rule_type: string;
    description: string;
    target: { type: string; id?: string };
    plugin: { id: number };
    new_severity?: number;
  }, opts?: TenableRequestOptions): Promise<TenableRemediationRule> {
    const r = await this.http.post("/workbenches/user_defined_rules", params, { headers: this.headers(opts) });
    return r.data;
  }

  async deleteRemediationRule(ruleId: string, opts?: TenableRequestOptions): Promise<void> {
    await this.http.delete(`/workbenches/user_defined_rules/${ruleId}`, { headers: this.headers(opts) });
  }

  // ── Container Security ─────────────────────────────────────────────────────

  async listContainerImages(params: { offset?: number; limit?: number } = {}, opts?: TenableRequestOptions): Promise<TenableContainerImage[]> {
    const r = await this.http.get("/container-security/api/v2/images", {
      headers: this.headers(opts),
      params,
    });
    return r.data.items ?? r.data ?? [];
  }

  async getContainerReport(imageId: string, opts?: TenableRequestOptions): Promise<unknown> {
    const r = await this.http.get(`/container-security/api/v2/reports/image`, {
      headers: this.headers(opts),
      params: { image_id: imageId },
    });
    return r.data;
  }

  // ── Server ─────────────────────────────────────────────────────────────────

  async getServerStatus(opts?: TenableRequestOptions): Promise<unknown> {
    const r = await this.http.get("/server/status", { headers: this.headers(opts) });
    return r.data;
  }

  async getServerProperties(opts?: TenableRequestOptions): Promise<unknown> {
    const r = await this.http.get("/server/properties", { headers: this.headers(opts) });
    return r.data;
  }
}

export const tenableCloudClient = new TenableCloudClient();
