import axios, { AxiosInstance } from "axios";
import { env } from "../../config/env";
import type {
  IvantiClientConfig,
  IvantiRequestOptions,
  IvantiHttpResponse,
} from "./types";

function parseBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const s = String(value || "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    code?: string;
    response?: { status?: number };
    message?: string;
  };
  if (e.response?.status != null && e.response.status >= 500) return true;
  const retryableCodes = new Set([
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EPIPE",
    "ECONNABORTED",
    "ERR_NETWORK",
  ]);
  if (e.code && retryableCodes.has(e.code)) return true;
  const msg = String(e.message || "").toLowerCase();
  if (msg.includes("timeout") || msg.includes("econnreset") || msg.includes("socket")) return true;
  return false;
}

function buildErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const e = error as {
    response?: { status: number; data: unknown };
    request?: unknown;
    message?: string;
  };
  if (e.response) {
    const status = e.response.status;
    const body = e.response.data;
    if (typeof body === "string") return `Ivanti Neurons API error (${status}): ${body}`;
    if (body && typeof body === "object") {
      const errBody = body as { error?: unknown; message?: string };
      if (errBody.error) return `Ivanti Neurons API error (${status}): ${JSON.stringify(errBody.error)}`;
      if (errBody.message) return `Ivanti Neurons API error (${status}): ${errBody.message}`;
      return `Ivanti Neurons API error (${status}): ${JSON.stringify(body)}`;
    }
    return `Ivanti Neurons API error (${status})`;
  }
  if (e.request) return `Ivanti Neurons API no response: ${e.message || ""}`;
  return `Ivanti Neurons request error: ${e.message || String(error)}`;
}

interface TokenEntry {
  token: string;
  expiresAt: number;
}

export class IvantiAuthManager {
  private hostname: string;
  private tenantId: string;
  private clientId: string;
  private clientSecret: string;
  private scope?: string;
  private authUrl: string;
  private inventoryTokenUrl: string;
  private mdmHost: string;
  private mdmUsername: string;
  private mdmPassword: string;
  private mdmPartitionId: string;
  private nztaHost: string;
  private nztaDsid: string;
  private debug: boolean;
  private http: AxiosInstance;
  private oauthToken?: TokenEntry;
  private inventoryToken?: TokenEntry;
  private resolvedMdmPartitionId?: string;

  constructor(config?: Partial<IvantiClientConfig>) {
    this.hostname = config?.hostname ?? env.IVANTI_HOST;
    this.tenantId = config?.tenantId ?? env.IVANTI_TENANT_ID_OR_PATH;
    this.clientId = config?.clientId ?? env.IVANTI_CLIENT_ID;
    this.clientSecret = config?.clientSecret ?? env.IVANTI_CLIENT_SECRET;
    this.scope = config?.scope ?? env.IVANTI_SCOPE ?? undefined;
    this.authUrl =
      config?.authUrl ||
      env.IVANTI_AUTH_URL ||
      `https://${this.hostname}/${this.tenantId}/connect/token`;
    this.inventoryTokenUrl = `https://${this.hostname}/api/apigatewaydataservices/v1/token`;
    this.mdmHost = config?.mdmHost ?? env.IVANTI_MDM_HOST ?? this.hostname;
    this.mdmUsername = config?.mdmUsername ?? env.IVANTI_MDM_USERNAME ?? "";
    this.mdmPassword = config?.mdmPassword ?? env.IVANTI_MDM_PASSWORD ?? "";
    this.mdmPartitionId = config?.mdmPartitionId ?? env.IVANTI_MDM_PARTITION_ID ?? "";
    this.nztaHost = config?.nztaHost ?? env.IVANTI_NZTA_HOST ?? this.hostname;
    this.nztaDsid = config?.nztaDsid ?? env.IVANTI_NZTA_DSID ?? "";
    this.debug = config?.debug ?? parseBool(env.IVANTI_DEBUG);

    this.http = axios.create({
      timeout: config?.timeout ?? Number(env.IVANTI_TIMEOUT) ?? 60_000,
      headers: { Accept: "application/json" },
    });
  }

  isConfigured(): boolean {
    return !!(
      this.hostname &&
      this.tenantId &&
      this.clientId &&
      this.clientSecret
    );
  }

  private log(...args: unknown[]): void {
    if (this.debug) console.error("[ivanti]", ...args);
  }

  async getOAuthToken(): Promise<string> {
    const now = Date.now();
    if (this.oauthToken && this.oauthToken.expiresAt > now + 60_000) {
      return this.oauthToken.token;
    }

    const body = new URLSearchParams();
    body.append("grant_type", "client_credentials");
    body.append("client_id", this.clientId);
    body.append("client_secret", this.clientSecret);
    if (this.scope) body.append("scope", this.scope);

    this.log("POST", this.authUrl);
    try {
      const resp = await this.http.post<{
        access_token: string;
        expires_in?: number;
      }>(this.authUrl, body.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      const token = resp.data.access_token;
      if (!token) throw new Error("Ivanti token response did not include access_token");
      const expiresIn = (resp.data.expires_in || 3600) * 1000;
      this.oauthToken = { token, expiresAt: now + expiresIn };
      return token;
    } catch (error) {
      throw new Error(buildErrorMessage(error));
    }
  }

  async getInventoryToken(): Promise<string> {
    const now = Date.now();
    if (this.inventoryToken && this.inventoryToken.expiresAt > now + 60_000) {
      return this.inventoryToken.token;
    }

    this.log("GET", this.inventoryTokenUrl);
    try {
      const resp = await this.http.get<unknown>(this.inventoryTokenUrl, {
        headers: {
          "X-ClientSecret": this.clientSecret,
          "X-TenantId": this.tenantId,
          "X-ClientId": this.clientId,
        },
      });
      // Inventory token endpoint returns the access token as a plain string body.
      const token =
        typeof resp.data === "string"
          ? resp.data.trim()
          : (resp.data as { access_token?: string })?.access_token;
      if (!token) throw new Error("Ivanti inventory token response did not include access_token");
      // Inventory tokens are typically short-lived (5 min); cache for 4 min.
      this.inventoryToken = { token, expiresAt: now + 4 * 60 * 1000 };
      return token;
    } catch (error) {
      throw new Error(buildErrorMessage(error));
    }
  }

  mdmConfigured(): boolean {
    return !!(this.mdmHost && this.mdmUsername && this.mdmPassword);
  }

  nztaConfigured(): boolean {
    return !!(this.nztaHost && this.nztaDsid);
  }

  private basicAuthHeader(): string {
    const creds = `${this.mdmUsername}:${this.mdmPassword}`;
    return `Basic ${Buffer.from(creds).toString("base64")}`;
  }

  async getMdmPartitionId(): Promise<string> {
    if (this.mdmPartitionId) return this.mdmPartitionId;
    if (this.resolvedMdmPartitionId) return this.resolvedMdmPartitionId;
    if (!this.mdmConfigured()) throw new Error("Ivanti MDM not configured");

    const url = `https://${this.mdmHost}/api/v1/metadata/tenant`;
    this.log("GET", url);
    try {
      const resp = await this.http.get<unknown>(url, {
        headers: { Authorization: this.basicAuthHeader() },
      });
      const data = resp.data as { dmPartitionId?: string; id?: string; tenantId?: string } | undefined;
      const id = data?.dmPartitionId || data?.id || data?.tenantId;
      if (!id) throw new Error("Ivanti MDM tenant metadata did not include dmPartitionId");
      this.resolvedMdmPartitionId = id;
      return id;
    } catch (error) {
      throw new Error(buildErrorMessage(error));
    }
  }

  async request<T = unknown>(
    method: string,
    path: string,
    baseUrl: string,
    options: IvantiRequestOptions = {},
  ): Promise<IvantiHttpResponse<T>> {
    const authMode =
      options.authMode ||
      (baseUrl.replace(/\/+$/, "") ===
      `https://${this.hostname}/api/apigatewaydataservices/v1`
        ? "inventory"
        : "oauth");

    const root = baseUrl.replace(/\/+$/, "");
    const url = `${root}${path}`;
    const headers: Record<string, string> = { ...options.headers };

    if (authMode === "inventory") {
      headers.Authorization = `Bearer ${await this.getInventoryToken()}`;
    } else if (authMode === "mdm") {
      if (!this.mdmConfigured()) throw new Error("Ivanti MDM not configured");
      headers.Authorization = this.basicAuthHeader();
    } else if (authMode === "nzta") {
      if (!this.nztaConfigured()) throw new Error("Ivanti nZTA not configured");
      headers.Cookie = `DSID=${this.nztaDsid}`;
    } else {
      headers.Authorization = `Bearer ${await this.getOAuthToken()}`;
    }

    if (
      options.data != null &&
      typeof options.data === "object" &&
      !headers["Content-Type"]
    ) {
      headers["Content-Type"] = "application/json";
    }

    const idempotent = ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"].includes(method.toUpperCase());
    const maxAttempts = idempotent ? 3 : 1;
    let lastError: unknown;

    this.log(method, url);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const resp = await this.http.request<T>({
          method,
          url,
          headers,
          params: options.params,
          data: options.data,
        });
        return { data: resp.data, status: resp.status, headers: resp.headers as Record<string, string> };
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts && isRetryableError(error)) {
          const delay = 500 * 2 ** (attempt - 1);
          this.log(`retry ${attempt}/${maxAttempts} after ${delay}ms`, url);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        break;
      }
    }
    throw new Error(buildErrorMessage(lastError));
  }
}
