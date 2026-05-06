import axios, { AxiosError, AxiosInstance } from "axios";
import WebSocket from "ws";
import { env } from "../../config/env";
import type {
  HawkCase,
  HawkCaseSummary,
  HawkCasesParams,
  HawkExploreSearchParams,
  HawkExploreResult,
  HawkHistogramBucket,
  HawkSavedSearch,
  HawkAssetsParams,
  HawkAssetsResult,
  HawkAssetSummary,
  HawkIdentitiesParams,
  HawkIdentitiesResult,
  HawkIdentitySummary,
  HawkArtefact,
  HawkArtefactsParams,
  HawkDashboard,
  HawkDashboardRunResult,
} from "./types";

export interface HawkNode {
  id: string;
  group: string;
  hostname: string | null;
  address: string | null;
  platform: string | null;
  type: string | null;
  tags: string[];
  approval: boolean;
  lastSeen: string;
  availableTasks: any[];
  hybridTools?: any;
  hybridCatalogVersion?: string | null;
  [key: string]: unknown;
}

export interface HawkHybridResult {
  route: string;
  cmd?: string;
  status: boolean;
  data: unknown;
  details: string;
  [key: string]: unknown;
}

const WS_TIMEOUT_MS = 30_000;

export class HawkIrClient {
  private http: AxiosInstance;
  private baseUrl: string;
  private accessToken: string;
  private secretKey: string;
  private enabled: boolean;
  private sessionCookie: string | null = null;
  private maxRetries = 3;

  constructor() {
    this.baseUrl = this.normalizeBaseUrl(env.HAWK_IR_BASE_URL);
    this.accessToken = env.HAWK_IR_ACCESS_TOKEN;
    this.secretKey = env.HAWK_IR_SECRET_KEY;
    this.enabled = env.HAWK_IR_ENABLED && !!(this.baseUrl && this.accessToken && this.secretKey);

    this.http = axios.create({
      baseURL: this.baseUrl || undefined,
      timeout: 60_000,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    });

    this.http.interceptors.response.use(undefined, async (error: AxiosError) => {
      const config = error.config as any;
      if (!config) return Promise.reject(error);

      const status = error.response?.status;

      if (status === 401 && !config.__retryAuth) {
        config.__retryAuth = true;
        this.sessionCookie = null;
        await this.authenticate();
        if (this.sessionCookie) {
          config.headers = config.headers || {};
          config.headers["Cookie"] = this.sessionCookie;
        }
        return this.http.request(config);
      }

      if (status && status >= 400 && status < 500 && status !== 429) return Promise.reject(error);

      config.__retryCount = config.__retryCount || 0;
      if (config.__retryCount >= this.maxRetries) return Promise.reject(error);

      const delay = Math.min(1000 * Math.pow(2, config.__retryCount), 30_000);
      config.__retryCount += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.http.request(config);
    });
  }

  isConfigured(): boolean {
    return this.enabled;
  }

  async validateConfig(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      await this.getCaseCount();
      return true;
    } catch {
      return false;
    }
  }

  // === Auth ===

  private async authenticate(): Promise<void> {
    const resp = await axios.post(
      `${this.baseUrl}/api/auth`,
      { access_token: this.accessToken, secret_key: this.secretKey },
      { timeout: 15_000 },
    );
    if (!resp.data?.status) {
      throw new Error(`HAWK IR auth failed: ${resp.data?.details ?? "unknown"}`);
    }
    const setCookie = resp.headers["set-cookie"];
    if (setCookie) {
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      this.sessionCookie = cookies.map((c: string) => c.split(";")[0]).join("; ");
    }
  }

  private async sessionHeaders(): Promise<Record<string, string>> {
    if (!this.sessionCookie) await this.authenticate();
    return this.sessionCookie ? { Cookie: this.sessionCookie } : {};
  }

  private async httpGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    this.ensureConfigured();
    const headers = await this.sessionHeaders();
    const resp = await this.http.get<T>(path, { params, headers });
    return resp.data;
  }

  private async httpPost<T>(path: string, data?: unknown): Promise<T> {
    this.ensureConfigured();
    const headers = await this.sessionHeaders();
    const resp = await this.http.post<T>(path, data, { headers });
    return resp.data;
  }

  // === WebSocket helper (request-response) ===

  /**
   * Sends a WebSocket message and waits for the first response that matches
   * the same `route`. Used for WebSocket-only HAWK APIs (artefacts, nodes).
   */
  private wsRequest(message: Record<string, unknown>, timeoutMs = WS_TIMEOUT_MS): Promise<any> {
    this.ensureConfigured();
    if (!this.sessionCookie) {
      return this.authenticate().then(() => this.wsRequest(message, timeoutMs));
    }

    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/websocket";
    const id = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const msg = { ...message, id };

    return new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: { Cookie: this.sessionCookie! } });
      let timer: ReturnType<typeof setTimeout>;

      const done = (result: unknown, err?: Error) => {
        clearTimeout(timer);
        try { ws.close(); } catch { /* ignore */ }
        if (err) reject(err);
        else resolve(result);
      };

      timer = setTimeout(() => done(null, new Error(`HAWK IR WS timeout for route=${message.route}`)), timeoutMs);

      ws.on("open", () => ws.send(JSON.stringify(msg)));

      ws.on("message", (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());
          // Skip server hello/pong messages that arrive before the actual response
          if (!parsed.route) return;
          if (parsed.route === message.route) done(parsed.data ?? parsed);
        } catch { /* skip malformed frames */ }
      });

      ws.on("error", (err) => done(null, err));
      ws.on("close", () => clearTimeout(timer));
    });
  }

  /**
   * Sends a hybrid execute message and waits for an async result from the node.
   * Returns the first message received after the dispatch acknowledgment.
   * Timeout defaults to 60 s since nodes may take time to respond.
   */
  async executeHybrid(params: {
    groupId: string;
    cmd: string;
    data?: unknown;
    targetNodeId?: string;
  }, timeoutMs = 60_000): Promise<HawkHybridResult> {
    this.ensureConfigured();
    if (!this.sessionCookie) await this.authenticate();

    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/websocket";
    const id = `hybrid-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const msg: Record<string, unknown> = {
      route: "execute",
      cmd: params.cmd,
      group_id: params.groupId,
      id,
      data: params.data,
    };
    if (params.targetNodeId) msg.target_node_id = params.targetNodeId;

    return new Promise<HawkHybridResult>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: { Cookie: this.sessionCookie! } });
      let dispatched = false;
      let timer: ReturnType<typeof setTimeout>;

      const done = (result: unknown, err?: Error) => {
        clearTimeout(timer);
        try { ws.close(); } catch { /* ignore */ }
        if (err) reject(err);
        else resolve(result as HawkHybridResult);
      };

      timer = setTimeout(() => done(null, new Error(`HAWK IR hybrid timeout cmd=${params.cmd}`)), timeoutMs);

      ws.on("open", () => ws.send(JSON.stringify(msg)));

      ws.on("message", (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());
          // Skip server hello/pong messages
          if (!parsed.route) return;
          if (!dispatched && parsed.route === "execute" && parsed.status) {
            dispatched = true;
            return;
          }
          if (dispatched) done(parsed);
        } catch { /* skip malformed */ }
      });

      ws.on("error", (err) => done(null, err));
    });
  }

  // === Cases (REST) ===

  async getCases(params: HawkCasesParams = {}): Promise<HawkCase[]> {
    const q: Record<string, unknown> = {};
    if (params.startDate) q.start_date = params.startDate;
    if (params.stopDate) q.stop_date = params.stopDate;
    if (params.groupId) q.group_id = params.groupId;
    if (params.limit !== undefined) q.limit = params.limit;
    if (params.offset !== undefined) q.offset = params.offset;
    const result = await this.httpGet<HawkCase[] | { data: HawkCase[] }>("/api/cases", q);
    return Array.isArray(result) ? result : (result as any).data ?? [];
  }

  async getCase(caseId: string): Promise<HawkCase | null> {
    const id = caseId.replace(/^#/, "");
    const result = await this.httpGet<HawkCase | HawkCase[]>(`/api/case/${id}`);
    return Array.isArray(result) ? (result[0] ?? null) : (result ?? null);
  }

  async getCaseSummary(caseId: string): Promise<HawkCaseSummary | null> {
    const id = caseId.replace(/^#/, "");
    const result = await this.httpGet<HawkCaseSummary | HawkCaseSummary[]>(`/api/case/${id}/summary`);
    return Array.isArray(result) ? (result[0] ?? null) : (result ?? null);
  }

  async getCaseCount(): Promise<number> {
    const result = await this.httpGet<any>("/api/cases/getUserCount");
    if (typeof result === "number") return result;
    return result?.data ?? 0;
  }

  async getCategories(): Promise<any[]> {
    const result = await this.httpGet<any[]>("/api/cases/categories");
    return Array.isArray(result) ? result : [];
  }

  async deescalateCase(caseId: string, reason: string, note?: string): Promise<any> {
    return this.httpPost(`/api/cases/deescalate/${caseId.replace(/^#/, "")}`, { reason, note });
  }

  // === Case Management (WebSocket) ===

  async addCaseNote(caseId: string, body: string): Promise<any> {
    this.ensureConfigured();
    const id = caseId.replace(/^#/, "");
    return this.wsRequest({ cmd: "cases", route: "addNote", data: { id: "#" + id, note: body } });
  }

  async updateCaseStatus(caseId: string, status: string): Promise<any> {
    this.ensureConfigured();
    const id = caseId.replace(/^#/, "");
    return this.wsRequest({ cmd: "cases", route: "setStatus", case: "#" + id, data: status });
  }

  async updateCaseRisk(caseId: string, riskLevel: string): Promise<any> {
    this.ensureConfigured();
    const id = caseId.replace(/^#/, "");
    return this.wsRequest({ cmd: "cases", route: "setRisk", case: "#" + id, data: riskLevel });
  }

  // === Explore (REST) ===

  async search(params: HawkExploreSearchParams): Promise<HawkExploreResult[]> {
    const result = await this.httpGet<HawkExploreResult[]>(
      `/api/explore/search/${encodeURIComponent(params.q)}`,
      { idx: params.idx, from: params.from, to: params.to, offset: params.offset, size: params.size, sort: params.sort },
    );
    return Array.isArray(result) ? result : [];
  }

  async histogram(params: HawkExploreSearchParams): Promise<HawkHistogramBucket[]> {
    const result = await this.httpGet<HawkHistogramBucket[]>(
      `/api/explore/histogram/${encodeURIComponent(params.q)}`,
      { idx: params.idx, from: params.from, to: params.to, interval: params.interval },
    );
    return Array.isArray(result) ? result : [];
  }

  async getAvailableIndexes(): Promise<string[]> {
    const result = await this.httpGet<string[]>("/api/explore/indices");
    return Array.isArray(result) ? result : [];
  }

  async getSavedSearches(): Promise<HawkSavedSearch[]> {
    const result = await this.httpGet<HawkSavedSearch[]>("/api/explore/save");
    return Array.isArray(result) ? result : [];
  }

  // === Assets (REST) ===

  async getAssets(params: HawkAssetsParams = {}): Promise<HawkAssetsResult> {
    const result = await this.httpGet<HawkAssetsResult | any[]>("/api/assets", params as any);
    if (Array.isArray(result)) return { rows: result, pagination: null, summary: null };
    return result as HawkAssetsResult;
  }

  async getAssetSummary(): Promise<HawkAssetSummary> {
    return this.httpGet<HawkAssetSummary>("/api/assets/summary");
  }

  // === Identities (REST) ===

  async getIdentities(params: HawkIdentitiesParams = {}): Promise<HawkIdentitiesResult> {
    const result = await this.httpGet<HawkIdentitiesResult | any[]>("/api/identities", params as any);
    if (Array.isArray(result)) return { rows: result, pagination: null, summary: null };
    return result as HawkIdentitiesResult;
  }

  async getIdentitySummary(): Promise<HawkIdentitySummary> {
    return this.httpGet<HawkIdentitySummary>("/api/identities/summary");
  }

  // === Artefacts (WebSocket) ===

  async getArtefacts(params: HawkArtefactsParams = {}): Promise<HawkArtefact[]> {
    const result = await this.wsRequest({ cmd: "artefacts", route: "get", data: params });
    return Array.isArray(result) ? result : [];
  }

  // === Nodes (WebSocket — Admin/SysOp only) ===

  async listNodes(groupIds?: string[]): Promise<HawkNode[]> {
    const result = await this.wsRequest({ cmd: "nodes", route: "get", data: groupIds });
    return Array.isArray(result) ? result : [];
  }

  // === Dashboards (REST) ===

  async listDashboards(): Promise<HawkDashboard[]> {
    const result = await this.httpGet<HawkDashboard[]>("/api/dashboards");
    return Array.isArray(result) ? result : [];
  }

  async runDashboardWidget(dashboardId: string, body: Record<string, unknown> = {}): Promise<HawkDashboardRunResult> {
    return this.httpPost<HawkDashboardRunResult>(`/api/dashboards/${dashboardId}/run`, body);
  }

  // === Private ===

  private ensureConfigured(): void {
    if (!this.isConfigured()) {
      throw new Error("HAWK IR client not configured — check HAWK_IR_* env vars");
    }
  }

  private normalizeBaseUrl(url: string | undefined): string {
    if (!url) return "";
    return url.trim().replace(/\/$/, "");
  }
}

export const hawkIrClient = new HawkIrClient();
