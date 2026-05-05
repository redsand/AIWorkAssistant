import axios, { AxiosError, AxiosInstance } from "axios";
import { env } from "../../config/env";
import type {
  JitbitAddAttachmentParams,
  JitbitAddTimeEntryParams,
  JitbitAsset,
  JitbitAttachment,
  JitbitAutomationRule,
  JitbitCategory,
  JitbitComment,
  JitbitCompany,
  JitbitCreateAssetParams,
  JitbitCreateTicketParams,
  JitbitCustomField,
  JitbitCustomFieldValue,
  JitbitForwardTicketParams,
  JitbitListAssetsParams,
  JitbitListCompaniesParams,
  JitbitListTicketsParams,
  JitbitListUsersParams,
  JitbitMergeTicketsParams,
  JitbitPriority,
  JitbitSearchTicketsParams,
  JitbitSection,
  JitbitStatus,
  JitbitTag,
  JitbitTicket,
  JitbitTimeEntry,
  JitbitTicketUpdatePatch,
  JitbitUpdateAssetParams,
  JitbitUser,
} from "./types";

export class JitbitClient {
  private client: AxiosInstance;
  private baseUrl: string;
  private apiToken: string;
  private enabled: boolean;
  private maxRetries = 3;

  constructor() {
    this.baseUrl = this.normalizeBaseUrl(env.JITBIT_BASE_URL);
    this.apiToken = env.JITBIT_API_TOKEN;
    this.enabled = env.JITBIT_ENABLED;

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    if (this.apiToken) {
      headers.Authorization = `Bearer ${this.apiToken}`;
    }

    this.client = axios.create({
      baseURL: this.baseUrl || undefined,
      headers,
      timeout: 30000,
    });

    this.client.interceptors.response.use(undefined, async (error: AxiosError) => {
      const config = error.config as any;
      if (!config) return Promise.reject(error);

      config.__retryCount = config.__retryCount || 0;
      const status = error.response?.status;

      if (status && status >= 400 && status < 500 && status !== 429) {
        return Promise.reject(error);
      }

      if (config.__retryCount >= this.maxRetries) {
        return Promise.reject(error);
      }

      const retryAfter = error.response?.headers?.["retry-after"];
      const delay = retryAfter
        ? Number(retryAfter) * 1000
        : Math.min(1000 * Math.pow(2, config.__retryCount), 30000);
      config.__retryCount += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.client.request(config);
    });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  isConfigured(): boolean {
    return this.enabled && !!this.baseUrl && !!this.apiToken;
  }

  async validateConfig(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      await this.listTickets({ count: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async listTickets(params: JitbitListTicketsParams = {}): Promise<JitbitTicket[]> {
    this.ensureConfigured();
    const response = await this.client.get("/Tickets", { params });
    return response.data;
  }

  async getTicket(ticketId: number | string): Promise<JitbitTicket> {
    this.ensureConfigured();
    const response = await this.client.get("/ticket", {
      params: { id: ticketId },
    });
    return response.data;
  }

  async searchTickets(
    query: string,
    params: JitbitSearchTicketsParams = {},
  ): Promise<JitbitTicket[]> {
    this.ensureConfigured();
    const response = await this.client.get("/Search", {
      params: { query, ...params },
    });
    return response.data;
  }

  async listTicketComments(ticketId: number | string): Promise<JitbitComment[]> {
    this.ensureConfigured();
    const response = await this.client.get("/comments", {
      params: { id: ticketId },
    });
    return response.data;
  }

  async addTicketComment(
    ticketId: number | string,
    body: string,
    options: { forTechsOnly?: boolean; isSystem?: boolean } = {},
  ): Promise<unknown> {
    this.ensureConfigured();
    const payload = new URLSearchParams();
    payload.set("id", String(ticketId));
    payload.set("body", body);
    if (options.forTechsOnly !== undefined) {
      payload.set("forTechsOnly", String(options.forTechsOnly));
    }
    if (options.isSystem !== undefined) {
      payload.set("isSystem", String(options.isSystem));
    }
    const response = await this.client.post("/comment", payload, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return response.data;
  }

  async updateTicket(
    ticketId: number | string,
    patch: JitbitTicketUpdatePatch,
  ): Promise<unknown> {
    this.ensureConfigured();
    const payload = new URLSearchParams();
    payload.set("id", String(ticketId));
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      payload.set(key, value === null ? "" : String(value));
    }
    const response = await this.client.post("/UpdateTicket", payload, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return response.data;
  }

  async listUsers(params: JitbitListUsersParams = {}): Promise<JitbitUser[]> {
    this.ensureConfigured();
    const response = await this.client.get("/Users", { params });
    return response.data;
  }

  async getUser(userId: number | string): Promise<JitbitUser | null> {
    this.ensureConfigured();
    const users = await this.listUsers({ count: 500 });
    return users.find((user) => String(user.UserID) === String(userId)) || null;
  }

  async searchUsers(query: string): Promise<JitbitUser[]> {
    this.ensureConfigured();
    const needle = query.toLowerCase();
    const users = await this.listUsers({ count: 500 });
    return users.filter((user) =>
      [
        user.Username,
        user.Email,
        user.FirstName,
        user.LastName,
        user.CompanyName,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }

  async listCompanies(
    params: JitbitListCompaniesParams = {},
  ): Promise<JitbitCompany[]> {
    this.ensureConfigured();
    const response = await this.client.get("/Companies", { params });
    return response.data;
  }

  async getCompany(companyId: number | string): Promise<JitbitCompany | null> {
    this.ensureConfigured();
    const companies = await this.listCompanies({ count: 500 });
    return (
      companies.find(
        (company) =>
          String(company.CompanyID ?? company.CompanyId ?? company.ID) ===
          String(companyId),
      ) || null
    );
  }

  async searchCompanies(query: string): Promise<JitbitCompany[]> {
    this.ensureConfigured();
    const needle = query.toLowerCase();
    const companies = await this.listCompanies({ count: 500 });
    return companies.filter((company) =>
      [company.Name, company.CompanyName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }

  async listCategories(): Promise<JitbitCategory[]> {
    this.ensureConfigured();
    const response = await this.client.get("/categories");
    return response.data;
  }

  async listStatuses(): Promise<JitbitStatus[]> {
    this.ensureConfigured();
    const response = await this.client.get("/Statuses");
    return response.data;
  }

  async listPriorities(): Promise<JitbitPriority[]> {
    this.ensureConfigured();
    const response = await this.client.get("/Priorities");
    return response.data;
  }

  // === Ticket Lifecycle ===

  async createTicket(params: JitbitCreateTicketParams): Promise<JitbitTicket> {
    this.ensureConfigured();
    const payload = new URLSearchParams();
    payload.set("categoryId", String(params.categoryId));
    payload.set("subject", params.subject);
    if (params.body !== undefined) payload.set("body", params.body);
    if (params.priorityId !== undefined) payload.set("priorityId", String(params.priorityId));
    if (params.userId !== undefined) payload.set("userId", String(params.userId));
    if (params.assignedToUserId !== undefined) payload.set("assignedToUserId", String(params.assignedToUserId));
    if (params.forTechsOnly !== undefined) payload.set("forTechsOnly", String(params.forTechsOnly));
    if (params.tags !== undefined) payload.set("tags", params.tags);
    if (params.companyId !== undefined) payload.set("companyId", String(params.companyId));
    if (params.dueDate !== undefined) payload.set("dueDate", params.dueDate);
    if (params.cc !== undefined) payload.set("cc", params.cc);
    if (params.source !== undefined) payload.set("origin", params.source === "email" ? "0" : params.source === "widget" ? "1" : "2");
    if (params.parentId !== undefined) payload.set("parentId", String(params.parentId));
    if (params.customFields) {
      for (const [key, value] of Object.entries(params.customFields)) {
        payload.set(key, value);
      }
    }
    const response = await this.client.post("/Ticket", payload, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return response.data;
  }

  async deleteTicket(ticketId: number): Promise<unknown> {
    this.ensureConfigured();
    const response = await this.client.delete("/Ticket", {
      params: { id: ticketId },
    });
    return response.data;
  }

  async mergeTickets(params: JitbitMergeTicketsParams): Promise<unknown> {
    this.ensureConfigured();
    const response = await this.client.post("/MergeTickets", params);
    return response.data;
  }

  async forwardTicket(
    ticketId: number,
    params: JitbitForwardTicketParams,
  ): Promise<unknown> {
    this.ensureConfigured();
    const payload = new URLSearchParams();
    payload.set("id", String(ticketId));
    payload.set("to", params.toEmail);
    if (params.ccEmails?.length) payload.set("cc", params.ccEmails.join(","));
    if (params.body !== undefined) payload.set("body", params.body);
    const response = await this.client.post("/ForwardTicket", payload, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return response.data;
  }

  async subscribeToTicket(ticketId: number, userId?: number): Promise<unknown> {
    this.ensureConfigured();
    const params: Record<string, unknown> = { id: ticketId };
    if (userId !== undefined) params.userId = userId;
    const response = await this.client.post("/Subscribe", null, { params });
    return response.data;
  }

  async unsubscribeFromTicket(ticketId: number, userId?: number): Promise<unknown> {
    this.ensureConfigured();
    const params: Record<string, unknown> = { id: ticketId };
    if (userId !== undefined) params.userId = userId;
    const response = await this.client.delete("/Subscribe", { params });
    return response.data;
  }

  // === Attachments ===

  async listAttachments(ticketId: number): Promise<JitbitAttachment[]> {
    this.ensureConfigured();
    const response = await this.client.get(`/Ticket/${ticketId}/Attachments`);
    return response.data;
  }

  async getAttachment(attachmentId: number): Promise<unknown> {
    this.ensureConfigured();
    const response = await this.client.get(`/Attachment/${attachmentId}`, {
      responseType: "arraybuffer",
    });
    return response.data;
  }

  async addAttachment(
    ticketId: number,
    params: JitbitAddAttachmentParams,
  ): Promise<unknown> {
    this.ensureConfigured();
    const formData = new FormData();
    formData.append("file", new Blob([params.data]), params.fileName);
    if (params.commentBody) formData.append("commentBody", params.commentBody);
    const response = await this.client.post(
      `/Ticket/${ticketId}/Attachments`,
      formData,
    );
    return response.data;
  }

  async deleteAttachment(attachmentId: number): Promise<unknown> {
    this.ensureConfigured();
    const response = await this.client.delete(`/Attachment/${attachmentId}`);
    return response.data;
  }

  // === Assets ===

  async listAssets(params: JitbitListAssetsParams = {}): Promise<JitbitAsset[]> {
    this.ensureConfigured();
    const response = await this.client.get("/Assets", { params });
    return response.data;
  }

  async getAsset(assetId: number): Promise<JitbitAsset> {
    this.ensureConfigured();
    const response = await this.client.get(`/Assets/${assetId}`);
    return response.data;
  }

  async createAsset(params: JitbitCreateAssetParams): Promise<JitbitAsset> {
    this.ensureConfigured();
    const response = await this.client.post("/Assets", params);
    return response.data;
  }

  async updateAsset(
    assetId: number,
    params: JitbitUpdateAssetParams,
  ): Promise<JitbitAsset> {
    this.ensureConfigured();
    const response = await this.client.put(`/Assets/${assetId}`, params);
    return response.data;
  }

  async deleteAsset(assetId: number): Promise<unknown> {
    this.ensureConfigured();
    const response = await this.client.delete(`/Assets/${assetId}`);
    return response.data;
  }

  async getAssetTickets(assetId: number): Promise<JitbitTicket[]> {
    this.ensureConfigured();
    const response = await this.client.get(`/Assets/${assetId}/Tickets`);
    return response.data;
  }

  // === Custom Fields ===

  async listCustomFields(params?: { categoryId?: number }): Promise<JitbitCustomField[]> {
    this.ensureConfigured();
    const response = await this.client.get("/CustomFields", { params });
    return response.data;
  }

  async setCustomFieldValue(
    ticketId: number,
    fieldId: number,
    value: string,
  ): Promise<unknown> {
    this.ensureConfigured();
    const payload = new URLSearchParams();
    payload.set("id", String(ticketId));
    payload.set("value", value);
    const response = await this.client.post(
      `/CustomFields/${fieldId}/Value`,
      payload,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    return response.data;
  }

  async getCustomFieldValues(ticketId: number): Promise<JitbitCustomFieldValue[]> {
    this.ensureConfigured();
    const response = await this.client.get("/CustomFields/Values", {
      params: { id: ticketId },
    });
    return response.data;
  }

  // === Tags ===

  async listTags(): Promise<JitbitTag[]> {
    this.ensureConfigured();
    const response = await this.client.get("/Tags");
    return response.data;
  }

  async addTag(ticketId: number, tagName: string): Promise<unknown> {
    this.ensureConfigured();
    const response = await this.client.post("/Tag", null, {
      params: { id: ticketId, name: tagName },
    });
    return response.data;
  }

  async removeTag(ticketId: number, tagName: string): Promise<unknown> {
    this.ensureConfigured();
    const response = await this.client.delete("/Tag", {
      params: { id: ticketId, name: tagName },
    });
    return response.data;
  }

  // === Sections ===

  async listSections(categoryId?: number): Promise<JitbitSection[]> {
    this.ensureConfigured();
    const response = await this.client.get("/Sections", {
      params: categoryId ? { categoryId } : undefined,
    });
    return response.data;
  }

  // === Time Tracking ===

  async getTimeEntries(ticketId: number): Promise<JitbitTimeEntry[]> {
    this.ensureConfigured();
    const response = await this.client.get(`/Ticket/${ticketId}/TimeTracking`);
    return response.data;
  }

  async addTimeEntry(
    ticketId: number,
    params: JitbitAddTimeEntryParams,
  ): Promise<unknown> {
    this.ensureConfigured();
    const response = await this.client.post(
      `/Ticket/${ticketId}/TimeTracking`,
      params,
    );
    return response.data;
  }

  async deleteTimeEntry(entryId: number): Promise<unknown> {
    this.ensureConfigured();
    const response = await this.client.delete(`/TimeTracking/${entryId}`);
    return response.data;
  }

  // === Automation ===

  async listAutomationRules(categoryId?: number): Promise<JitbitAutomationRule[]> {
    this.ensureConfigured();
    const response = await this.client.get("/AutomationRules", {
      params: categoryId ? { categoryId } : undefined,
    });
    return response.data;
  }

  async triggerAutomation(ticketId: number, ruleId: number): Promise<unknown> {
    this.ensureConfigured();
    const response = await this.client.post(
      `/AutomationRules/${ruleId}/Execute`,
      null,
      { params: { id: ticketId } },
    );
    return response.data;
  }

  private ensureConfigured(): void {
    if (!this.isConfigured()) {
      throw new Error("Jitbit client not configured");
    }
  }

  private normalizeBaseUrl(url: string): string {
    const trimmed = url.trim().replace(/\/$/, "");
    if (!trimmed) return "";
    return trimmed.toLowerCase().endsWith("/api") ? trimmed : `${trimmed}/api`;
  }
}

export const jitbitClient = new JitbitClient();
