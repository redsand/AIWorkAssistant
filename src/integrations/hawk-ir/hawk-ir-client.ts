import axios, { AxiosError, AxiosInstance } from "axios";
import WebSocket from "ws";
import { env } from "../../config/env";
import type {
  HawkCase,
  HawkCaseEvent,
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
  CreateCaseRequest,
  CreateCaseResponse,
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

/**
 * /api/cases latency grows steeply with the queried range (~3s for 1 day,
 * ~2min for 10 days), so ranges are fetched in windows of at most this many
 * milliseconds, newest first, stopping once the requested limit is filled.
 */
const CASES_WINDOW_MS = 24 * 60 * 60 * 1000;
const CASES_DEFAULT_LIMIT = 100;
/** Safety cap on auto-pagination: 20 pages ≈ 10,000 cases at the default limit. */
const CASES_MAX_PAGES = 20;

/** Pagination bookkeeping attached to an auto-paginated getCases() result. */
export interface HawkCasesPagination {
  /** Number of pages actually fetched (1 when no extra pages were needed). */
  pagesFetched: number;
  /** Total cases in the returned array. */
  totalCases: number;
  /** True when the maxPages safety cap was hit while pages were still full. */
  truncated: boolean;
}

const CASES_PAGINATION = Symbol("hawkCasesPagination");

/**
 * Reads the pagination metadata that {@link HawkIrClient.getCases} attaches to
 * an auto-paginated result. Returns undefined for single-page (non-paginated)
 * results so callers can cheaply tell the two apart.
 */
export function getCasesPagination(cases: HawkCase[]): HawkCasesPagination | undefined {
  return (cases as any)?.[CASES_PAGINATION];
}

function coerceBoolean(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw.toLowerCase() === "true" || raw === "1";
  if (typeof raw === "number") return raw !== 0;
  return false;
}

function normalizeHawkCaseEvent(raw: any): HawkCaseEvent {
  if (!raw || typeof raw !== "object") return raw;
  return {
    ...raw,
    dateAdded: raw.date_added ?? raw.dateAdded ?? "",
    priority: Number(raw.priority ?? 0),
    weight: Number(raw.weight ?? 0),
    alertName: raw.alert_name ?? raw.alertName ?? "",
    alertsTypeName: raw.alerts_type_name ?? raw.alertsTypeName ?? "",
    count: Number(raw.count ?? 0),
    blocked: coerceBoolean(raw.blocked),
    eventId: raw.event_id ?? raw.eventId ?? "",
  };
}

/**
 * Maps a raw HAWK IR case record (snake_case, OrientDB-style `@rid`) to the
 * canonical camelCase {@link HawkCase}. Raw fields are preserved via spread.
 * Accepts legacy camelCase records too, so it is safe on either wire shape.
 */
export function normalizeHawkCase(raw: any): HawkCase {
  if (!raw || typeof raw !== "object") return raw;
  const rid = String(raw["@rid"] ?? raw.rid ?? "").replace(/^#/, "");
  const riskLevel = String(raw.risk_level ?? raw.riskLevel ?? "low").toLowerCase() as HawkCase["riskLevel"];
  const progressStatus = String(raw.progress_status ?? raw.progressStatus ?? "new")
    .toLowerCase()
    .replace(/\s+/g, "_") as HawkCase["progressStatus"];
  return {
    ...raw,
    rid,
    name: raw.name ?? "",
    groupId: raw.group_id ?? raw.groupId ?? "",
    riskLevel,
    progressStatus,
    category: raw.category ?? null,
    owner: raw.owner ?? null,
    ownerName: raw.owner_name ?? raw.ownerName ?? (typeof raw.owner === "string" ? raw.owner : null),
    escalated: coerceBoolean(raw.escalated),
    escalationTicket: raw.escalation_ticket ?? raw.escalationTicket ?? null,
    escalationModule: raw.escalation_module ?? raw.escalationModule ?? null,
    escalationId: raw.escalation_id ?? raw.escalationId ?? null,
    escalationTimestamp: raw.escalation_timestamp ?? raw.escalationTimestamp ?? null,
    firstSeen: raw.first_seen ?? raw.firstSeen ?? "",
    lastSeen: raw.last_seen ?? raw.lastSeen ?? "",
    dateCreated: raw.date_created ?? raw.dateCreated ?? null,
    ipSrcs: raw.ip_srcs ?? raw.ipSrcs ?? [],
    ipDsts: raw.ip_dsts ?? raw.ipDsts ?? [],
    alertNames: raw.alert_names ?? raw.alertNames ?? [],
    analytics: raw.analytics ?? [],
    assets: raw.assets ?? [],
    users: raw.users ?? [],
    mitre: raw.mitre ?? [],
    tags: raw.tags ?? [],
    avgScore: raw.avg_score ?? raw.avgScore ?? null,
    blockedCount: raw.blocked_count ?? raw.blockedCount ?? null,
    summary: raw.summary ?? null,
    rootCause: raw.root_cause ?? raw.rootCause ?? null,
    feedback: raw.feedback ?? null,
    feedbackDetails: raw.feedback_details ?? raw.feedbackDetails ?? null,
    actions: raw.actions ?? [],
    notes: raw.notes ?? [],
    events: Array.isArray(raw.events) ? raw.events.map(normalizeHawkCaseEvent) : [],
    linkedCount: Number(raw.linked_count ?? raw.linkedCount ?? 0),
  };
}

function unwrapData<T>(result: any): T {
  return result && typeof result === "object" && !Array.isArray(result) && "data" in result
    ? result.data
    : result;
}

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

  private async httpDelete<T>(path: string): Promise<T> {
    this.ensureConfigured();
    const headers = await this.sessionHeaders();
    const resp = await this.http.delete<T>(path, { headers });
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

  /**
   * Fetches cases for a date range.
   *
   * By default a single page of at most `limit` rows (starting at `offset`) is
   * returned. When {@link HawkCasesParams.autoPaginate} is set, successive pages
   * are fetched (offset += limit) until a page comes back with fewer than
   * `limit` rows or the {@link CASES_MAX_PAGES} safety cap is reached, and the
   * combined array is returned. Auto-paginated results carry pagination
   * bookkeeping readable via {@link getCasesPagination}.
   *
   * A single page is itself fetched in windows of at most one day, newest first
   * (see {@link fetchCasesPage}): /api/cases latency scales with the range
   * (~2min for 10 days) and would otherwise exceed the HTTP timeout.
   */
  async getCases(params: HawkCasesParams = {}): Promise<HawkCase[]> {
    const limit = params.limit ?? CASES_DEFAULT_LIMIT;
    const baseOffset = params.offset ?? 0;

    if (!params.autoPaginate) {
      return this.fetchCasesPage(params, limit, baseOffset);
    }

    const maxPages = params.maxPages ?? CASES_MAX_PAGES;
    const all: HawkCase[] = [];
    const seen = new Set<string>();
    let offset = baseOffset;
    let pagesFetched = 0;
    let truncated = false;

    while (true) {
      if (pagesFetched >= maxPages) {
        truncated = true;
        break;
      }

      let page: HawkCase[];
      try {
        page = await this.fetchCasesPage(params, limit, offset);
      } catch (err) {
        // Never lose what we already have: return the partial set with a warning.
        console.warn(
          `[HawkIR] getCases auto-pagination failed on page ${pagesFetched + 1} ` +
          `(offset ${offset}); returning ${all.length} case(s) collected so far.`,
          err,
        );
        break;
      }

      pagesFetched += 1;
      for (const c of page) {
        if (c.rid && seen.has(c.rid)) continue;
        if (c.rid) seen.add(c.rid);
        all.push(c);
      }

      // A short page means we've reached the end of the result set.
      if (page.length < limit) break;
      offset += limit;
    }

    if (pagesFetched > 1) {
      console.info(
        `[HawkIR] getCases auto-paginated: fetched ${pagesFetched} page(s), ` +
        `${all.length} total case(s)${truncated ? " (hit page cap; more may exist)" : ""}.`,
      );
    }

    Object.defineProperty(all, CASES_PAGINATION, {
      value: { pagesFetched, totalCases: all.length, truncated } as HawkCasesPagination,
      enumerable: false,
    });
    return all;
  }

  /**
   * Fetches a single page of up to `limit` cases starting at `offset` by
   * querying /api/cases in windows of at most one day, newest first, until the
   * requested slice (offset + limit) is filled or the date range is exhausted.
   */
  private async fetchCasesPage(params: HawkCasesParams, limit: number, offset: number): Promise<HawkCase[]> {
    const wanted = offset + limit;
    const stop = params.stopDate ? new Date(params.stopDate) : new Date();
    const start = params.startDate ? new Date(params.startDate) : new Date(stop.getTime() - CASES_WINDOW_MS);

    const collected: HawkCase[] = [];
    const seen = new Set<string>();
    let windowEnd = stop;

    while (windowEnd > start && collected.length < wanted) {
      const windowStart = new Date(Math.max(start.getTime(), windowEnd.getTime() - CASES_WINDOW_MS));
      const q: Record<string, unknown> = {
        start_date: windowStart.toISOString(),
        stop_date: windowEnd.toISOString(),
        limit: wanted - collected.length,
      };
      if (params.groupId) q.group_id = params.groupId;

      const result = await this.httpGet<{ data: any[] } | any[]>("/api/cases", q);
      const rows = unwrapData<any[]>(result);
      for (const row of Array.isArray(rows) ? rows : []) {
        const normalized = normalizeHawkCase(row);
        if (normalized.rid && seen.has(normalized.rid)) continue;
        if (normalized.rid) seen.add(normalized.rid);
        collected.push(normalized);
      }
      windowEnd = windowStart;
    }

    return collected.slice(offset, offset + limit);
  }

  async getCase(caseId: string): Promise<HawkCase | null> {
    const id = caseId.replace(/^#/, "");
    const result = await this.httpGet<any>(`/api/case/${id}`);
    const data = unwrapData<any>(result);
    const row = Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
    return row ? normalizeHawkCase(row) : null;
  }

  async getCaseSummary(caseId: string): Promise<HawkCaseSummary | null> {
    const id = caseId.replace(/^#/, "");
    const result = await this.httpGet<any>(`/api/case/${id}/summary`);
    const data = unwrapData<any>(result);
    return Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
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

  async getCaseCategories(): Promise<any[]> {
    return this.getCategories();
  }

  async getCaseLabels(): Promise<{ categories: any[]; ignoreLabels: any[] }> {
    const [categories, ignoreLabels] = await Promise.all([
      this.httpGet<any[]>("/api/cases/labels/category"),
      this.httpGet<any[]>("/api/cases/labels/ignore"),
    ]);
    return {
      categories: Array.isArray(categories) ? categories : [],
      ignoreLabels: Array.isArray(ignoreLabels) ? ignoreLabels : [],
    };
  }

  async addIgnoreLabel(label: string, category?: string): Promise<any> {
    const data: Record<string, unknown> = { label };
    if (category) data.category = category;
    return this.httpPost("/api/cases/labels/ignore", data);
  }

  async deleteIgnoreLabel(labelId: string): Promise<any> {
    return this.httpDelete(`/api/cases/labels/ignore/${encodeURIComponent(labelId)}`);
  }

  async deescalateCase(caseId: string, reason: string, note?: string): Promise<any> {
    return this.httpPost(`/api/cases/deescalate/${caseId.replace(/^#/, "")}`, { reason, note });
  }

  async createCase(request: CreateCaseRequest): Promise<CreateCaseResponse> {
    if (!request.name || request.name.trim().length === 0) {
      throw new Error("Case name is required");
    }
    if (!request.events || request.events.length === 0) {
      throw new Error("At least one event is required");
    }
    if (request.events.some((e) => !e.alert_name)) {
      throw new Error("Each event must have an alert_name");
    }

    return this.httpPost<CreateCaseResponse>("/api/cases", request);
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

  async escalateCase(caseId: string, type: string, vendor?: string, ticketId?: string): Promise<any> {
    this.ensureConfigured();
    const id = caseId.replace(/^#/, "");
    const data: Record<string, unknown> = { id: "#" + id, type, module: "manual" };
    if (vendor) data.vendor = vendor;
    if (ticketId) data.ticketId = ticketId;
    return this.wsRequest({ cmd: "cases", route: "setEscalated", data });
  }

  async assignCase(caseId: string, ownerId: string): Promise<any> {
    this.ensureConfigured();
    const id = caseId.replace(/^#/, "");
    return this.wsRequest({ cmd: "cases", route: "setOwner", case: "#" + id, data: ownerId });
  }

  async mergeCases(sourceCaseId: string, targetCaseId: string): Promise<any> {
    this.ensureConfigured();
    const source = "#" + sourceCaseId.replace(/^#/, "");
    const target = "#" + targetCaseId.replace(/^#/, "");
    return this.wsRequest({ cmd: "cases", route: "mergeCase", source, target });
  }

  async renameCase(caseId: string, name: string): Promise<any> {
    this.ensureConfigured();
    const id = caseId.replace(/^#/, "");
    return this.wsRequest({ cmd: "cases", route: "setName", case: "#" + id, data: name });
  }

  async updateCaseDetails(caseId: string, details: string): Promise<any> {
    this.ensureConfigured();
    const id = caseId.replace(/^#/, "");
    return this.wsRequest({ cmd: "cases", route: "setDetails", case: "#" + id, data: details });
  }

  async setCaseCategories(caseId: string, categories: string[]): Promise<any> {
    this.ensureConfigured();
    const id = caseId.replace(/^#/, "");
    return this.wsRequest({ cmd: "cases", route: "setCategory", case: "#" + id, data: categories });
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

  async getFields(idx: string): Promise<string[]> {
    const result = await this.httpGet<string[]>("/api/explore/fields", { idx });
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

  // === Quarantine (WebSocket) ===

  async quarantineHost(caseId: string, target: string, options?: { type?: string; expires?: string }): Promise<any> {
    this.ensureConfigured();
    const id = caseId.replace(/^#/, "");
    return this.wsRequest({
      cmd: "quarantine",
      route: "add",
      data: {
        type: options?.type ?? "ip",
        object: target,
        module: "manual",
        case_id: "#" + id,
        object_highlight: target,
        expires: options?.expires ?? "-1",
      },
    });
  }

  async getQuarantineRecords(): Promise<any[]> {
    this.ensureConfigured();
    const result = await this.wsRequest({ cmd: "quarantine", route: "get" });
    return Array.isArray(result) ? result : [];
  }

  async unquarantineHost(rid: string, caseId: string, objectHighlight: string): Promise<any> {
    this.ensureConfigured();
    return this.wsRequest({
      cmd: "quarantine",
      route: "revert",
      data: {
        "@rid": rid,
        case_id: caseId,
        module: "manual",
        object_highlight: objectHighlight,
      },
    });
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
