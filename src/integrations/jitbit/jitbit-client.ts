import axios, { AxiosError, AxiosInstance } from "axios";
import { env } from "../../config/env";
import type {
  JitbitCategory,
  JitbitComment,
  JitbitCompany,
  JitbitListCompaniesParams,
  JitbitListTicketsParams,
  JitbitListUsersParams,
  JitbitPriority,
  JitbitSearchTicketsParams,
  JitbitStatus,
  JitbitTicket,
  JitbitTicketUpdatePatch,
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
