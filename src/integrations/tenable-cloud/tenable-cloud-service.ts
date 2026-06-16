import { tenableCloudClient, TenableCloudClient } from "./tenable-cloud-client";
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

export class TenableCloudService {
  constructor(private client: TenableCloudClient = tenableCloudClient) {}

  isConfigured(opts?: TenableRequestOptions): boolean {
    return this.client.isConfigured(opts);
  }

  // ── Vulnerabilities ──────────────────────────────────────────────────────

  async listVulnerabilities(params: {
    date_range?: number;
    filter_type?: "and" | "or";
    num_assets?: number;
    page?: number;
  } = {}, opts?: TenableRequestOptions): Promise<TenableVulnerability[]> {
    return this.client.listVulnerabilities(params, opts);
  }

  async getVulnerabilityDetails(pluginId: number, opts?: TenableRequestOptions): Promise<unknown> {
    return this.client.getVulnerabilityDetails(pluginId, opts);
  }

  async exportVulnerabilities(filters: TenableVulnExportFilter = {}, opts?: TenableRequestOptions): Promise<{ export_uuid: string }> {
    return this.client.exportVulnerabilities(filters, opts);
  }

  async getVulnExportStatus(exportUuid: string, opts?: TenableRequestOptions): Promise<TenableExportStatus> {
    return this.client.getVulnExportStatus(exportUuid, opts);
  }

  async downloadVulnExportChunk(exportUuid: string, chunkId: number, opts?: TenableRequestOptions): Promise<TenableVulnerability[]> {
    return this.client.downloadVulnExportChunk(exportUuid, chunkId, opts);
  }

  // ── Assets ───────────────────────────────────────────────────────────────

  async listWorkbenchAssets(params: {
    date_range?: number;
    filter_type?: "and" | "or";
    num_assets?: number;
    page?: number;
  } = {}, opts?: TenableRequestOptions): Promise<TenableWorkbenchAsset[]> {
    return this.client.listWorkbenchAssets(params, opts);
  }

  async getAssetVulnerabilities(assetId: string, params: {
    date_range?: number;
  } = {}, opts?: TenableRequestOptions): Promise<TenableVulnerability[]> {
    return this.client.getAssetVulnerabilities(assetId, params, opts);
  }

  async listAssets(
    params: { limit?: number; offset?: number } = {},
    opts?: TenableRequestOptions,
  ): Promise<TenableAsset[]> {
    return this.client.listAssets(params, opts);
  }

  async listAllAssets(opts?: TenableRequestOptions): Promise<TenableAsset[]> {
    return this.client.listAllAssets(opts);
  }

  async getAsset(assetId: string, opts?: TenableRequestOptions): Promise<TenableAsset> {
    return this.client.getAsset(assetId, opts);
  }

  async deleteAsset(assetId: string, opts?: TenableRequestOptions): Promise<void> {
    return this.client.deleteAsset(assetId, opts);
  }

  async importAssets(assets: unknown[], opts?: TenableRequestOptions): Promise<{ task_id: string }> {
    return this.client.importAssets(assets, opts);
  }

  async exportAssets(params: TenableAssetExportFilter = {}, opts?: TenableRequestOptions): Promise<{ export_uuid: string }> {
    return this.client.exportAssets(params, opts);
  }

  async getAssetExportStatus(exportUuid: string, opts?: TenableRequestOptions): Promise<TenableExportStatus> {
    return this.client.getAssetExportStatus(exportUuid, opts);
  }

  async downloadAssetExportChunk(exportUuid: string, chunkId: number, opts?: TenableRequestOptions): Promise<TenableAsset[]> {
    return this.client.downloadAssetExportChunk(exportUuid, chunkId, opts);
  }

  async bulkDeleteAssets(query: unknown, opts?: TenableRequestOptions): Promise<{ task_id: string }> {
    return this.client.bulkDeleteAssets(query, opts);
  }

  // ── Scans ────────────────────────────────────────────────────────────────

  async listScans(params: { folder_id?: number } = {}, opts?: TenableRequestOptions): Promise<TenableScan[]> {
    return this.client.listScans(params, opts);
  }

  async getScan(scanId: number, opts?: TenableRequestOptions): Promise<TenableScanDetails> {
    return this.client.getScan(scanId, opts);
  }

  async createScan(settings: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenableScan> {
    return this.client.createScan(settings, opts);
  }

  async updateScan(scanId: number, settings: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenableScan> {
    return this.client.updateScan(scanId, settings, opts);
  }

  async deleteScan(scanId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.deleteScan(scanId, opts);
  }

  async launchScan(scanId: number, altTargets?: string[], opts?: TenableRequestOptions): Promise<{ scan_uuid: string }> {
    return this.client.launchScan(scanId, altTargets, opts);
  }

  async stopScan(scanId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.stopScan(scanId, opts);
  }

  async pauseScan(scanId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.pauseScan(scanId, opts);
  }

  async resumeScan(scanId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.resumeScan(scanId, opts);
  }

  async copyScan(scanId: number, folderId?: number, opts?: TenableRequestOptions): Promise<TenableScan> {
    return this.client.copyScan(scanId, folderId, opts);
  }

  async exportScan(scanId: number, format?: string, opts?: TenableRequestOptions): Promise<{ file: number; token?: string }> {
    return this.client.exportScan(scanId, format, opts);
  }

  async importScan(file: string, folderId?: number, opts?: TenableRequestOptions): Promise<TenableScan> {
    return this.client.importScan(file, folderId, opts);
  }

  async getScanHistory(scanId: number, opts?: TenableRequestOptions): Promise<TenableScanDetails["history"]> {
    return this.client.getScanHistory(scanId, opts);
  }

  async listScanTemplates(opts?: TenableRequestOptions): Promise<TenableScanTemplate[]> {
    return this.client.listScanTemplates(opts);
  }

  // ── Policies ─────────────────────────────────────────────────────────────

  async listPolicies(opts?: TenableRequestOptions): Promise<TenablePolicy[]> {
    return this.client.listPolicies(opts);
  }

  async getPolicy(policyId: number, opts?: TenableRequestOptions): Promise<TenablePolicy> {
    return this.client.getPolicy(policyId, opts);
  }

  async createPolicy(settings: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenablePolicy> {
    return this.client.createPolicy(settings, opts);
  }

  async updatePolicy(policyId: number, settings: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenablePolicy> {
    return this.client.updatePolicy(policyId, settings, opts);
  }

  async deletePolicy(policyId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.deletePolicy(policyId, opts);
  }

  async copyPolicy(policyId: number, opts?: TenableRequestOptions): Promise<TenablePolicy> {
    return this.client.copyPolicy(policyId, opts);
  }

  // ── Networks ─────────────────────────────────────────────────────────────

  async listNetworks(opts?: TenableRequestOptions): Promise<TenableNetwork[]> {
    return this.client.listNetworks(opts);
  }

  async getNetwork(networkId: string, opts?: TenableRequestOptions): Promise<TenableNetwork> {
    return this.client.getNetwork(networkId, opts);
  }

  async createNetwork(params: { name: string; description?: string; assets_ttl_days?: number }, opts?: TenableRequestOptions): Promise<TenableNetwork> {
    return this.client.createNetwork(params, opts);
  }

  async updateNetwork(networkId: string, params: { name?: string; description?: string; assets_ttl_days?: number }, opts?: TenableRequestOptions): Promise<TenableNetwork> {
    return this.client.updateNetwork(networkId, params, opts);
  }

  async deleteNetwork(networkId: string, opts?: TenableRequestOptions): Promise<void> {
    return this.client.deleteNetwork(networkId, opts);
  }

  async listNetworkScanners(networkId: string, opts?: TenableRequestOptions): Promise<TenableScanner[]> {
    return this.client.listNetworkScanners(networkId, opts);
  }

  async assignScannerToNetwork(networkId: string, scannerId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.assignScannerToNetwork(networkId, scannerId, opts);
  }

  // ── Tags ─────────────────────────────────────────────────────────────────

  async listTagCategories(opts?: TenableRequestOptions): Promise<TenableTagCategory[]> {
    return this.client.listTagCategories(opts);
  }

  async createTagCategory(params: { name: string; description?: string }, opts?: TenableRequestOptions): Promise<TenableTagCategory> {
    return this.client.createTagCategory(params, opts);
  }

  async updateTagCategory(categoryUuid: string, params: { name?: string; description?: string }, opts?: TenableRequestOptions): Promise<TenableTagCategory> {
    return this.client.updateTagCategory(categoryUuid, params, opts);
  }

  async deleteTagCategory(categoryUuid: string, opts?: TenableRequestOptions): Promise<void> {
    return this.client.deleteTagCategory(categoryUuid, opts);
  }

  async listTagValues(categoryUuid?: string, opts?: TenableRequestOptions): Promise<TenableTagValue[]> {
    return this.client.listTagValues(categoryUuid, opts);
  }

  async createTagValue(params: { category_uuid: string; value: string; description?: string }, opts?: TenableRequestOptions): Promise<TenableTagValue> {
    return this.client.createTagValue(params, opts);
  }

  async updateTagValue(valueUuid: string, params: { value?: string; description?: string }, opts?: TenableRequestOptions): Promise<TenableTagValue> {
    return this.client.updateTagValue(valueUuid, params, opts);
  }

  async deleteTagValue(valueUuid: string, opts?: TenableRequestOptions): Promise<void> {
    return this.client.deleteTagValue(valueUuid, opts);
  }

  async assignTagsToAssets(assetUuids: string[], tagUuids: string[], opts?: TenableRequestOptions): Promise<{ job_uuid: string }> {
    return this.client.assignTagsToAssets(assetUuids, tagUuids, opts);
  }

  async removeTagsFromAssets(assetUuids: string[], tagUuids: string[], opts?: TenableRequestOptions): Promise<{ job_uuid: string }> {
    return this.client.removeTagsFromAssets(assetUuids, tagUuids, opts);
  }

  // ── Users ────────────────────────────────────────────────────────────────

  async listUsers(opts?: TenableRequestOptions): Promise<TenableUser[]> {
    return this.client.listUsers(opts);
  }

  async getUser(userId: number, opts?: TenableRequestOptions): Promise<TenableUser> {
    return this.client.getUser(userId, opts);
  }

  async createUser(params: {
    username: string;
    password: string;
    permissions: number;
    name?: string;
    email?: string;
    type?: string;
  }, opts?: TenableRequestOptions): Promise<TenableUser> {
    return this.client.createUser(params, opts);
  }

  async updateUser(userId: number, params: {
    permissions?: number;
    name?: string;
    email?: string;
    enabled?: boolean;
  }, opts?: TenableRequestOptions): Promise<TenableUser> {
    return this.client.updateUser(userId, params, opts);
  }

  async deleteUser(userId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.deleteUser(userId, opts);
  }

  async getUserKeys(userId: number, opts?: TenableRequestOptions): Promise<{ accessKey: string; secretKey: string }> {
    return this.client.getUserKeys(userId, opts);
  }

  async enableUser(userId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.enableUser(userId, opts);
  }

  async disableUser(userId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.disableUser(userId, opts);
  }

  // ── Groups ───────────────────────────────────────────────────────────────

  async listGroups(opts?: TenableRequestOptions): Promise<TenableGroup[]> {
    return this.client.listGroups(opts);
  }

  async createGroup(name: string, opts?: TenableRequestOptions): Promise<TenableGroup> {
    return this.client.createGroup(name, opts);
  }

  async updateGroup(groupId: number, name: string, opts?: TenableRequestOptions): Promise<TenableGroup> {
    return this.client.updateGroup(groupId, name, opts);
  }

  async deleteGroup(groupId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.deleteGroup(groupId, opts);
  }

  async listGroupUsers(groupId: number, opts?: TenableRequestOptions): Promise<TenableUser[]> {
    return this.client.listGroupUsers(groupId, opts);
  }

  async addUserToGroup(groupId: number, userId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.addUserToGroup(groupId, userId, opts);
  }

  async removeUserFromGroup(groupId: number, userId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.removeUserFromGroup(groupId, userId, opts);
  }

  // ── Scanners ─────────────────────────────────────────────────────────────

  async listScanners(opts?: TenableRequestOptions): Promise<TenableScanner[]> {
    return this.client.listScanners(opts);
  }

  async getScanner(scannerId: number, opts?: TenableRequestOptions): Promise<TenableScanner> {
    return this.client.getScanner(scannerId, opts);
  }

  async updateScanner(scannerId: number, params: { name?: string; link_permission?: boolean }, opts?: TenableRequestOptions): Promise<TenableScanner> {
    return this.client.updateScanner(scannerId, params, opts);
  }

  async deleteScanner(scannerId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.deleteScanner(scannerId, opts);
  }

  async toggleScannerLink(scannerId: number, linked: boolean, opts?: TenableRequestOptions): Promise<void> {
    return this.client.toggleScannerLink(scannerId, linked, opts);
  }

  // ── Agents ───────────────────────────────────────────────────────────────

  async listAgents(params: { offset?: number; limit?: number } = {}, opts?: TenableRequestOptions): Promise<{ agents: TenableAgent[]; pagination: unknown }> {
    return this.client.listAgents(params, opts);
  }

  async listAllAgents(opts?: TenableRequestOptions): Promise<TenableAgent[]> {
    return this.client.listAllAgents(opts);
  }

  async getAgent(agentId: number, opts?: TenableRequestOptions): Promise<TenableAgent> {
    return this.client.getAgent(agentId, opts);
  }

  async deleteAgent(scannerId: number, agentId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.deleteAgent(scannerId, agentId, opts);
  }

  async unlinkAgent(scannerId: number, agentId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.unlinkAgent(scannerId, agentId, opts);
  }

  async bulkDeleteAgents(scannerId: number, agentIds: number[], opts?: TenableRequestOptions): Promise<{ task_uuid: string }> {
    return this.client.bulkDeleteAgents(scannerId, agentIds, opts);
  }

  async bulkUnlinkAgents(scannerId: number, agentIds: number[], opts?: TenableRequestOptions): Promise<{ task_uuid: string }> {
    return this.client.bulkUnlinkAgents(scannerId, agentIds, opts);
  }

  async listAgentGroups(scannerId: number, opts?: TenableRequestOptions): Promise<TenableAgentGroup[]> {
    return this.client.listAgentGroups(scannerId, opts);
  }

  async createAgentGroup(scannerId: number, name: string, opts?: TenableRequestOptions): Promise<TenableAgentGroup> {
    return this.client.createAgentGroup(scannerId, name, opts);
  }

  async updateAgentGroup(scannerId: number, groupId: number, name: string, opts?: TenableRequestOptions): Promise<TenableAgentGroup> {
    return this.client.updateAgentGroup(scannerId, groupId, name, opts);
  }

  async deleteAgentGroup(scannerId: number, groupId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.deleteAgentGroup(scannerId, groupId, opts);
  }

  async addAgentToGroup(scannerId: number, groupId: number, agentId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.addAgentToGroup(scannerId, groupId, agentId, opts);
  }

  async removeAgentFromGroup(scannerId: number, groupId: number, agentId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.removeAgentFromGroup(scannerId, groupId, agentId, opts);
  }

  // ── Exclusions ───────────────────────────────────────────────────────────

  async listExclusions(opts?: TenableRequestOptions): Promise<TenableExclusion[]> {
    return this.client.listExclusions(opts);
  }

  async createExclusion(params: {
    name: string;
    members: string;
    description?: string;
    schedule?: unknown;
  }, opts?: TenableRequestOptions): Promise<TenableExclusion> {
    return this.client.createExclusion(params, opts);
  }

  async getExclusion(exclusionId: number, opts?: TenableRequestOptions): Promise<TenableExclusion> {
    return this.client.getExclusion(exclusionId, opts);
  }

  async updateExclusion(exclusionId: number, params: {
    name?: string;
    members?: string;
    description?: string;
    schedule?: unknown;
  }, opts?: TenableRequestOptions): Promise<TenableExclusion> {
    return this.client.updateExclusion(exclusionId, params, opts);
  }

  async deleteExclusion(exclusionId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.deleteExclusion(exclusionId, opts);
  }

  // ── Credentials ──────────────────────────────────────────────────────────

  async listCredentials(opts?: TenableRequestOptions): Promise<TenableCredential[]> {
    return this.client.listCredentials(opts);
  }

  async getCredential(credentialUuid: string, opts?: TenableRequestOptions): Promise<TenableCredential> {
    return this.client.getCredential(credentialUuid, opts);
  }

  async createCredential(params: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenableCredential> {
    return this.client.createCredential(params, opts);
  }

  async updateCredential(credentialUuid: string, params: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenableCredential> {
    return this.client.updateCredential(credentialUuid, params, opts);
  }

  async deleteCredential(credentialUuid: string, opts?: TenableRequestOptions): Promise<void> {
    return this.client.deleteCredential(credentialUuid, opts);
  }

  // ── Plugins ──────────────────────────────────────────────────────────────

  async listPluginFamilies(opts?: TenableRequestOptions): Promise<TenablePluginFamily[]> {
    return this.client.listPluginFamilies(opts);
  }

  async getPluginFamily(familyId: number, opts?: TenableRequestOptions): Promise<{ info: TenablePluginFamily; plugins: TenablePlugin[] }> {
    return this.client.getPluginFamily(familyId, opts);
  }

  async getPlugin(pluginId: number, opts?: TenableRequestOptions): Promise<TenablePlugin> {
    return this.client.getPlugin(pluginId, opts);
  }

  // ── Alerts ───────────────────────────────────────────────────────────────

  async listAlerts(opts?: TenableRequestOptions): Promise<TenableAlert[]> {
    return this.client.listAlerts(opts);
  }

  async getAlert(alertId: number, opts?: TenableRequestOptions): Promise<TenableAlert> {
    return this.client.getAlert(alertId, opts);
  }

  async createAlert(params: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenableAlert> {
    return this.client.createAlert(params, opts);
  }

  async updateAlert(alertId: number, params: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenableAlert> {
    return this.client.updateAlert(alertId, params, opts);
  }

  async deleteAlert(alertId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.deleteAlert(alertId, opts);
  }

  async executeAlert(alertId: number, opts?: TenableRequestOptions): Promise<void> {
    return this.client.executeAlert(alertId, opts);
  }

  // ── Audit Log ─────────────────────────────────────────────────────────────

  async getAuditLog(params: {
    limit?: number;
    offset?: number;
  } = {}, opts?: TenableRequestOptions): Promise<TenableAuditLog[]> {
    return this.client.getAuditLog(params, opts);
  }

  // ── Access Groups ─────────────────────────────────────────────────────────

  async listAccessGroups(opts?: TenableRequestOptions): Promise<TenableAccessGroup[]> {
    return this.client.listAccessGroups(opts);
  }

  async getAccessGroup(groupId: string, opts?: TenableRequestOptions): Promise<TenableAccessGroup> {
    return this.client.getAccessGroup(groupId, opts);
  }

  async createAccessGroup(params: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenableAccessGroup> {
    return this.client.createAccessGroup(params, opts);
  }

  async updateAccessGroup(groupId: string, params: Record<string, unknown>, opts?: TenableRequestOptions): Promise<TenableAccessGroup> {
    return this.client.updateAccessGroup(groupId, params, opts);
  }

  async deleteAccessGroup(groupId: string, opts?: TenableRequestOptions): Promise<void> {
    return this.client.deleteAccessGroup(groupId, opts);
  }

  // ── Remediation Rules ─────────────────────────────────────────────────────

  async listRemediationRules(opts?: TenableRequestOptions): Promise<TenableRemediationRule[]> {
    return this.client.listRemediationRules(opts);
  }

  async createRemediationRule(params: {
    rule_type: string;
    description: string;
    target: { type: string; id?: string };
    plugin: { id: number };
    new_severity?: number;
  }, opts?: TenableRequestOptions): Promise<TenableRemediationRule> {
    return this.client.createRemediationRule(params, opts);
  }

  async deleteRemediationRule(ruleId: string, opts?: TenableRequestOptions): Promise<void> {
    return this.client.deleteRemediationRule(ruleId, opts);
  }

  // ── Container Security ────────────────────────────────────────────────────

  async listContainerImages(params: { offset?: number; limit?: number } = {}, opts?: TenableRequestOptions): Promise<TenableContainerImage[]> {
    return this.client.listContainerImages(params, opts);
  }

  async getContainerReport(imageId: string, opts?: TenableRequestOptions): Promise<unknown> {
    return this.client.getContainerReport(imageId, opts);
  }

  // ── Server ────────────────────────────────────────────────────────────────

  async getServerStatus(opts?: TenableRequestOptions): Promise<unknown> {
    return this.client.getServerStatus(opts);
  }

  async getServerProperties(opts?: TenableRequestOptions): Promise<unknown> {
    return this.client.getServerProperties(opts);
  }
}

export const tenableCloudService = new TenableCloudService();
