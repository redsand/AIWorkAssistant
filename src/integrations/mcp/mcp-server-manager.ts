import fs from "fs";
import path from "path";
import { z } from "zod";
import { env } from "../../config/env";
import {
  mcpClient,
  MCPServerConfig,
  MCPServerStatus,
} from "./mcp-client";

/**
 * Zod schema for a single external MCP server entry in
 * config/mcp-servers.json (or the MCP_SERVERS fallback env var).
 *
 * The public shape is { name, url, authToken, enabled }. `headers` is an
 * optional escape hatch for servers that need custom auth headers instead of a
 * simple bearer token.
 */
export const mcpServerFileConfigSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  authToken: z.string().optional().default(""),
  enabled: z.boolean().optional().default(true),
  headers: z.record(z.string()).optional(),
});

export type McpServerFileConfig = z.infer<typeof mcpServerFileConfigSchema>;

/**
 * Structural subset of {@link MCPClient} that the manager drives. Declared as
 * an interface so tests can inject a lightweight fake without constructing a
 * real client (which would open network connections).
 */
export interface McpConnectionClient {
  addServer(
    config: MCPServerConfig,
  ): Promise<{ connected: boolean; toolCount: number; error?: string }>;
  removeServer(name: string): void;
  getServerForTool(toolName: string): string | undefined;
  getServerStatus(): Record<string, MCPServerStatus>;
}

export interface McpServerManagerOptions {
  client?: McpConnectionClient;
  /** Absolute or cwd-relative path to the JSON config file. */
  configPath?: string;
  /** Inline JSON fallback used only when the config file is absent. */
  envFallback?: string;
  /** Debounce (ms) applied to filesystem watch events before reloading. */
  debounceMs?: number;
}

/**
 * Translate a user-facing server config into the low-level client config:
 * an `authToken` becomes an `Authorization: Bearer <token>` header unless the
 * caller already supplied an explicit Authorization header.
 */
function toClientConfig(config: McpServerFileConfig): MCPServerConfig {
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  const hasAuthHeader = Object.keys(headers).some(
    (k) => k.toLowerCase() === "authorization",
  );
  if (config.authToken && !hasAuthHeader) {
    headers.Authorization = `Bearer ${config.authToken}`;
  }
  return {
    name: config.name,
    url: config.url,
    enabled: config.enabled,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  };
}

/** Stable identity key for diffing two configs during hot reload. */
function configKey(config: McpServerFileConfig): string {
  return JSON.stringify({
    name: config.name,
    url: config.url,
    authToken: config.authToken ?? "",
    enabled: config.enabled ?? true,
    headers: config.headers ?? null,
  });
}

/**
 * Manages the lifecycle of external MCP servers: loads them from a JSON config
 * file (falling back to an env var), connects them through the MCP client,
 * watches the file for changes, and hot-reloads by diffing the new config
 * against the currently-applied set.
 */
export class McpServerManager {
  private readonly client: McpConnectionClient;
  private readonly configPath: string;
  private readonly envFallback: string;
  private readonly debounceMs: number;

  /** Configs currently applied to the client, keyed by server name. */
  private current: Map<string, McpServerFileConfig> = new Map();
  private watcher: fs.FSWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Serializes reloads. A reload awaits network I/O (connectServer) that can
   * far exceed the watch debounce, so a file event can fire a second reload
   * while the first is still connecting. Chaining every reload onto this
   * promise guarantees they run one-at-a-time and never mutate `this.current`
   * from interleaved, stale snapshots.
   */
  private reloadChain: Promise<unknown> = Promise.resolve();

  constructor(options: McpServerManagerOptions = {}) {
    this.client = options.client ?? mcpClient;
    this.configPath =
      options.configPath ??
      path.resolve(process.cwd(), env.MCP_SERVERS_CONFIG_PATH);
    this.envFallback = options.envFallback ?? env.MCP_SERVERS;
    this.debounceMs = options.debounceMs ?? 250;
  }

  /**
   * Read and validate the server config. Reads config/mcp-servers.json when it
   * exists; otherwise falls back to the MCP_SERVERS env var. Both accept either
   * a top-level array or a { "servers": [...] } wrapper. Invalid entries are
   * logged and skipped so one bad entry doesn't drop the whole config.
   */
  loadServerConfig(): McpServerFileConfig[] {
    const raw = this.readConfigSource();
    if (!raw || !raw.trim()) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.error(
        `[MCP] Failed to parse server config: ${
          error instanceof Error ? error.message : "invalid JSON"
        }`,
      );
      return [];
    }

    const items = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { servers?: unknown }).servers)
        ? (parsed as { servers: unknown[] }).servers
        : [];

    const configs: McpServerFileConfig[] = [];
    for (const item of items) {
      const result = mcpServerFileConfigSchema.safeParse(item);
      if (result.success) {
        configs.push(result.data);
      } else {
        console.error(
          `[MCP] Skipping invalid server config entry: ${result.error.errors
            .map((e) => `${e.path.join(".")} ${e.message}`)
            .join("; ")}`,
        );
      }
    }
    return configs;
  }

  /**
   * Load config, connect every server, then begin watching the config file for
   * runtime changes. Safe to call once at startup.
   */
  async initialize(): Promise<void> {
    await this.reloadServers();
    this.startWatching();
  }

  /** Add (or reconfigure) a single server and remember it as applied. */
  async addServer(
    config: McpServerFileConfig,
  ): Promise<{ connected: boolean; toolCount: number; error?: string }> {
    try {
      const result = await this.client.addServer(toClientConfig(config));
      this.current.set(config.name, config);
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error(`[MCP] Failed to add server '${config.name}': ${msg}`);
      // Still record it as applied so a subsequent reload with an unchanged
      // config doesn't retry the failing connection on every file event.
      this.current.set(config.name, config);
      return { connected: false, toolCount: 0, error: msg };
    }
  }

  /** Remove a single server and forget it. */
  removeServer(name: string): void {
    try {
      this.client.removeServer(name);
    } catch (error) {
      console.error(
        `[MCP] Failed to remove server '${name}': ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
    this.current.delete(name);
  }

  /**
   * Hot-reload: re-read the config file and diff it against the applied set.
   * Servers that disappeared are removed; new or changed servers are re-added.
   * Each operation is isolated so one failure doesn't abort the rest.
   */
  async reloadServers(): Promise<{
    added: string[];
    removed: string[];
    unchanged: string[];
  }> {
    // Queue this reload behind any in-flight one. We swallow the predecessor's
    // result/error (via the `.then(noop, noop)` chain below) purely for
    // sequencing — the caller still gets this reload's own outcome/rejection.
    const result = this.reloadChain
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => this.performReload());
    this.reloadChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** The actual diff-and-apply, always invoked serially via reloadServers(). */
  private async performReload(): Promise<{
    added: string[];
    removed: string[];
    unchanged: string[];
  }> {
    const desired = this.loadServerConfig();
    const desiredByName = new Map(desired.map((c) => [c.name, c]));

    const added: string[] = [];
    const removed: string[] = [];
    const unchanged: string[] = [];

    // Remove servers no longer present in the config.
    for (const name of [...this.current.keys()]) {
      if (!desiredByName.has(name)) {
        this.removeServer(name);
        removed.push(name);
      }
    }

    // Add new servers and re-apply changed ones.
    for (const config of desired) {
      const existing = this.current.get(config.name);
      if (existing && configKey(existing) === configKey(config)) {
        unchanged.push(config.name);
        continue;
      }
      await this.addServer(config);
      added.push(config.name);
    }

    return { added, removed, unchanged };
  }

  /** Name of the server that owns a tool, or undefined if unknown. */
  getServerForTool(toolName: string): string | undefined {
    return this.client.getServerForTool(toolName);
  }

  /** Live connection status for every configured server. */
  getServerStatus(): Record<string, MCPServerStatus> {
    return this.client.getServerStatus();
  }

  /** Names of the servers currently applied to the client. */
  listServers(): string[] {
    return [...this.current.keys()];
  }

  /** Begin watching the config file's directory for changes. Idempotent. */
  startWatching(): void {
    if (this.watcher) return;

    const dir = path.dirname(this.configPath);
    const base = path.basename(this.configPath);

    // Watch the directory rather than the file itself: many editors replace
    // the file atomically (rename), which invalidates a file-level watch.
    if (!fs.existsSync(dir)) return;

    try {
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (!filename || filename === base) {
          this.scheduleReload();
        }
      });
      // Don't let the watcher keep the process (or a test runner) alive.
      this.watcher.unref?.();
    } catch (error) {
      console.error(
        `[MCP] Failed to watch config file: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  /** Stop watching and cancel any pending reload. */
  stopWatching(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      this.reloadServers().catch((error) => {
        console.error(
          `[MCP] Hot-reload failed: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        );
      });
    }, this.debounceMs);
    this.reloadTimer.unref?.();
  }

  private readConfigSource(): string | null {
    try {
      if (fs.existsSync(this.configPath)) {
        return fs.readFileSync(this.configPath, "utf-8");
      }
    } catch (error) {
      console.error(
        `[MCP] Failed to read config file '${this.configPath}': ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }

    // Fall back to the inline env var when the file is absent/unreadable.
    if (this.envFallback && this.envFallback.trim()) {
      return this.envFallback;
    }
    return null;
  }
}

export const mcpServerManager = new McpServerManager();
