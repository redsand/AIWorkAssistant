/**
 * Canva OAuth 2.0 manager for the Canva MCP server (https://mcp.canva.com/mcp).
 *
 * Canva's MCP endpoint is an OAuth-protected resource (RFC 9728). Its auth
 * server supports Dynamic Client Registration (RFC 7591), PKCE (S256), and the
 * "none" token-endpoint auth method — so we can run a fully self-contained
 * public-client Authorization Code + PKCE flow with NO pre-registered app and
 * NO client secret. The user just authorizes once in a browser; we then hold a
 * refreshable bearer token that the MCP client sends on every request.
 *
 * Discovery is done once against the well-known metadata so endpoint changes
 * don't require a code change. Everything is persisted to
 * data/canva-oauth.json.
 */
import axios from "axios";
import * as crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "../../config/env";

const MCP_RESOURCE = "https://mcp.canva.com/mcp";
const PROTECTED_RESOURCE_METADATA =
  "https://mcp.canva.com/.well-known/oauth-protected-resource/mcp";

// Scopes needed for design (flyer) editing + asset upload. profile:read lets
// us confirm who authorized. Trimmed to what the assistant actually uses.
const DEFAULT_SCOPES = [
  "profile:read",
  "design:meta:read",
  "design:content:read",
  "design:content:write",
  "asset:read",
  "asset:write",
  "folder:read",
  "folder:write",
  "brandtemplate:meta:read",
  "brandtemplate:content:read",
];

interface AuthServerMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

interface CanvaOAuthState {
  clientId?: string;
  accessToken?: string;
  refreshToken?: string;
  /** epoch ms when accessToken expires */
  expiresAt?: number;
  scope?: string;
  /** transient — only set between /auth/canva and the callback */
  pendingVerifier?: string;
  pendingState?: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

class CanvaOAuthManager {
  private statePath = join(process.cwd(), "data", "canva-oauth.json");
  private state: CanvaOAuthState = {};
  private meta: AuthServerMeta | null = null;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.statePath)) {
        this.state = JSON.parse(readFileSync(this.statePath, "utf-8"));
      }
    } catch (err) {
      console.error("[CanvaOAuth] Failed to load state:", err);
      this.state = {};
    }
  }

  private save(): void {
    try {
      const dir = join(process.cwd(), "data");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error("[CanvaOAuth] Failed to save state:", err);
    }
  }

  /**
   * Redirect URI. Canva's authorize endpoint (per RFC 8252 / the MCP OAuth
   * spec for public clients) only accepts LOOPBACK redirects — a public HTTPS
   * domain is accepted at Dynamic Client Registration but rejected at
   * /authorize with "Invalid redirect URI". So default to loopback on the
   * local service port; the user authorizes from a browser on this machine and
   * Canva redirects back to the running app.
   */
  private redirectUri(): string {
    return env.CANVA_REDIRECT_URI || `http://localhost:${env.PORT}/auth/canva/callback`;
  }

  /** Discover (and cache) the authorization-server endpoints. */
  private async discover(): Promise<AuthServerMeta> {
    if (this.meta) return this.meta;
    const prm = await axios.get(PROTECTED_RESOURCE_METADATA, { timeout: 15000 });
    const asBase: string = (prm.data.authorization_servers || [])[0] || "https://mcp.canva.com";
    const asm = await axios.get(`${asBase}/.well-known/oauth-authorization-server`, {
      timeout: 15000,
    });
    this.meta = {
      authorization_endpoint: asm.data.authorization_endpoint,
      token_endpoint: asm.data.token_endpoint,
      registration_endpoint: asm.data.registration_endpoint,
    };
    return this.meta;
  }

  /** Register a public client via DCR once; reuse the stored client_id after. */
  private async ensureClient(): Promise<string> {
    if (this.state.clientId) return this.state.clientId;
    const meta = await this.discover();
    if (!meta.registration_endpoint) {
      throw new Error("Canva auth server does not advertise a registration endpoint");
    }
    const resp = await axios.post(
      meta.registration_endpoint,
      {
        client_name: "AI Work Assistant",
        redirect_uris: [this.redirectUri()],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: DEFAULT_SCOPES.join(" "),
      },
      { timeout: 15000, headers: { "Content-Type": "application/json" } },
    );
    this.state.clientId = resp.data.client_id;
    this.save();
    console.log(`[CanvaOAuth] Registered client ${this.state.clientId}`);
    return this.state.clientId!;
  }

  /** Build the browser authorization URL (starts the flow). */
  async getAuthorizeUrl(): Promise<string> {
    const meta = await this.discover();
    const clientId = await this.ensureClient();

    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
    const stateTok = base64url(crypto.randomBytes(24));
    this.state.pendingVerifier = verifier;
    this.state.pendingState = stateTok;
    this.save();

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: this.redirectUri(),
      scope: DEFAULT_SCOPES.join(" "),
      state: stateTok,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `${meta.authorization_endpoint}?${params.toString()}`;
  }

  /** Exchange the authorization code for tokens (callback handler). */
  async handleCallback(code: string, stateTok: string): Promise<void> {
    if (!this.state.pendingState || stateTok !== this.state.pendingState) {
      throw new Error("OAuth state mismatch — restart the Canva authorization");
    }
    const verifier = this.state.pendingVerifier;
    if (!verifier) throw new Error("Missing PKCE verifier — restart the Canva authorization");
    const meta = await this.discover();
    const clientId = await this.ensureClient();

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri(),
      client_id: clientId,
      code_verifier: verifier,
    });
    const resp = await axios.post(meta.token_endpoint, body.toString(), {
      timeout: 15000,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    this.storeTokenResponse(resp.data);
    this.state.pendingVerifier = undefined;
    this.state.pendingState = undefined;
    this.save();
    console.log("[CanvaOAuth] Authorized — tokens stored");
  }

  private storeTokenResponse(data: any): void {
    this.state.accessToken = data.access_token;
    if (data.refresh_token) this.state.refreshToken = data.refresh_token;
    this.state.scope = data.scope;
    const ttl = typeof data.expires_in === "number" ? data.expires_in : 3600;
    this.state.expiresAt = Date.now() + ttl * 1000;
  }

  private async refresh(): Promise<void> {
    if (!this.state.refreshToken) throw new Error("No Canva refresh token — re-authorize");
    const meta = await this.discover();
    const clientId = await this.ensureClient();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.state.refreshToken,
      client_id: clientId,
    });
    const resp = await axios.post(meta.token_endpoint, body.toString(), {
      timeout: 15000,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    this.storeTokenResponse(resp.data);
    this.save();
  }

  isAuthorized(): boolean {
    return Boolean(this.state.accessToken || this.state.refreshToken);
  }

  status(): { authorized: boolean; scope?: string; expiresAt?: number; clientRegistered: boolean } {
    return {
      authorized: Boolean(this.state.accessToken),
      scope: this.state.scope,
      expiresAt: this.state.expiresAt,
      clientRegistered: Boolean(this.state.clientId),
    };
  }

  logout(): void {
    this.state = { clientId: this.state.clientId };
    this.save();
  }

  /**
   * Return a fresh `Authorization: Bearer <token>` value, refreshing when
   * within 60s of expiry. Returns null when not authorized so the MCP client
   * sends no auth header (and simply stays disconnected until the user
   * authorizes).
   */
  async getAuthHeader(): Promise<string | null> {
    if (!this.isAuthorized()) return null;
    const soon = Date.now() + 60_000;
    if (!this.state.accessToken || (this.state.expiresAt ?? 0) < soon) {
      try {
        await this.refresh();
      } catch (err) {
        console.error("[CanvaOAuth] Token refresh failed:", err instanceof Error ? err.message : err);
        return null;
      }
    }
    return this.state.accessToken ? `Bearer ${this.state.accessToken}` : null;
  }

  resource(): string {
    return MCP_RESOURCE;
  }
}

export const canvaOAuth = new CanvaOAuthManager();
