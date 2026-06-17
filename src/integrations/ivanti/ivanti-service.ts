import { IvantiClient } from "./ivanti-client";
import type {
  IvantiLookupParams,
  IvantiODataParams,
  IvantiPatchParams,
  IvantiBotRunBody,
  IvantiCvesToPatchGroupBody,
  IvantiCatalogBody,
  IvantiDistributionBody,
  IvantiOnDemandInstallBody,
} from "./types";

export class IvantiService {
  constructor(private client: IvantiClient = ivantiClient) {}

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  // ── Inventory ──────────────────────────────────────────────────────────────

  async lookup(params: IvantiLookupParams = {}) {
    return this.client.lookup(params);
  }

  async listDevices(params: IvantiODataParams & { allPages?: boolean } = {}) {
    return this.client.listDevices(params);
  }

  async getDevice(id?: string, hostname?: string, name?: string) {
    return this.client.getDevice(id, hostname, name);
  }

  async listPeople(params: IvantiODataParams & { allPages?: boolean } = {}) {
    return this.client.listPeople(params);
  }

  async getPerson(id?: string, email?: string, user?: string, name?: string) {
    return this.client.getPerson(id, email, user, name);
  }

  async getDevicesMetadata() {
    return this.client.getDevicesMetadata();
  }

  async getPeopleMetadata() {
    return this.client.getPeopleMetadata();
  }

  // ── Bots ───────────────────────────────────────────────────────────────────

  async listBots() {
    return this.client.listBots();
  }

  async getBotInputs(botDefinitionId: string) {
    return this.client.getBotInputs(botDefinitionId);
  }

  async runBot(body: IvantiBotRunBody) {
    return this.client.runBot(body);
  }

  async getBotResults(workflowInvocationId: string) {
    return this.client.getBotResults(workflowInvocationId);
  }

  async getBotLogMessages(workflowInvocationId: string, deviceId: string) {
    return this.client.getBotLogMessages(workflowInvocationId, deviceId);
  }

  // ── Patch ──────────────────────────────────────────────────────────────────

  async listPatches(params: IvantiPatchParams & { allPages?: boolean } = {}) {
    return this.client.listPatches(params);
  }

  async listPatchGroups(params: IvantiPatchParams & { allPages?: boolean } = {}) {
    return this.client.listPatchGroups(params);
  }

  async listCves(params: IvantiPatchParams = {}) {
    return this.client.listCves(params);
  }

  async listEndpointVulnerabilities(params: IvantiPatchParams = {}) {
    return this.client.listEndpointVulnerabilities(params);
  }

  async listDeploymentHistory(params: IvantiPatchParams = {}) {
    return this.client.listDeploymentHistory(params);
  }

  async listNotifications(params: IvantiPatchParams = {}) {
    return this.client.listNotifications(params);
  }

  async createPatchGroupFromCves(body: IvantiCvesToPatchGroupBody, onBehalfOf?: string) {
    return this.client.createPatchGroupFromCves(body, onBehalfOf);
  }

  async updatePatchGroupFromCves(patchGroupId: string, body: IvantiCvesToPatchGroupBody, onBehalfOf?: string) {
    return this.client.updatePatchGroupFromCves(patchGroupId, body, onBehalfOf);
  }

  async getPatchGroupMapping(patchGroupId: string) {
    return this.client.getPatchGroupMapping(patchGroupId);
  }

  async listPatchGroupAudit(params: IvantiPatchParams & { allPages?: boolean } = {}) {
    return this.client.listPatchGroupAudit(params);
  }

  // ── App Distribution ───────────────────────────────────────────────────────

  async listAppCatalog(params: Record<string, unknown> & { allPages?: boolean } = {}) {
    return this.client.listAppCatalog(params);
  }

  async listDevicePackageStatus(params: Record<string, unknown> & { allPages?: boolean } = {}) {
    return this.client.listDevicePackageStatus(params);
  }

  async createCatalog(body: IvantiCatalogBody) {
    return this.client.createCatalog(body);
  }

  async updateCatalog(packageId: string, body: Partial<IvantiCatalogBody>) {
    return this.client.updateCatalog(packageId, body);
  }

  async deleteCatalog(packageId: string) {
    return this.client.deleteCatalog(packageId);
  }

  async createDistribution(body: IvantiDistributionBody) {
    return this.client.createDistribution(body);
  }

  async updateDistribution(distributionId: string, body: Partial<IvantiDistributionBody>) {
    return this.client.updateDistribution(distributionId, body);
  }

  async getDistributions(packageId: string) {
    return this.client.getDistributions(packageId);
  }

  async onDemandInstall(body: IvantiOnDemandInstallBody) {
    return this.client.onDemandInstall(body);
  }

  // ── Proxy ──────────────────────────────────────────────────────────────────

  async proxy(
    module: "inventory" | "bots" | "patch" | "appdist",
    method: string,
    path: string,
    params?: Record<string, unknown>,
    body?: unknown,
  ) {
    return this.client.proxy(module, method, path, params, body);
  }
}

export const ivantiClient = new IvantiClient();
export const ivantiService = new IvantiService(ivantiClient);
