import axios from "axios";
import { EventEmitter } from "events";

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  /**
   * Optional async provider for a dynamic Authorization header, resolved
   * fresh before every request. Used for OAuth-backed servers (e.g. Canva)
   * whose bearer token expires and must be refreshed transparently. Takes
   * precedence over any static Authorization in `headers`. Return null to
   * send no Authorization header (e.g. not yet authorized).
   */
  getAuthHeader?: () => Promise<string | null>;
}

export interface MCPServerStatus {
  connected: boolean;
  toolCount: number;
  url: string;
  enabled: boolean;
  error?: string;
}

interface MCPRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Registry entry for a single tool exposed by a connected MCP server.
 *
 * Tools are keyed in the `tools` map by their PREFIXED name
 * (`{serverName}.{toolName}`) so that two servers can expose a tool of the
 * same bare name without colliding. `originalName` is the bare name the owning
 * server actually expects in a `tools/call` request, and `tool.name` is the
 * prefixed name surfaced to callers/LLMs.
 */
interface ToolEntry {
  server: string;
  originalName: string;
  tool: MCPTool;
}

/**
 * Low-level MCP JSON-RPC client and tool registry.
 *
 * Handles the connection primitives (initialize / tools/list / tools/call) and
 * an aggregated, prefixed tool registry across all registered servers. Dynamic
 * lifecycle (loading config from disk, hot-reload, diffing) lives in
 * {@link McpServerManager}, which drives this client via
 * {@link addServer}/{@link removeServer}.
 */
export class MCPClient extends EventEmitter {
  private servers: Map<string, MCPServerConfig> = new Map();
  private tools: Map<string, ToolEntry> = new Map();
  private requestId = 0;
  private initialized: Set<string> = new Set();
  private serverErrors: Map<string, string> = new Map();

  registerServer(config: MCPServerConfig) {
    this.servers.set(config.name, {
      ...config,
      enabled: config.enabled !== false,
    });
  }

  async initializeAll(): Promise<{
    totalServers: number;
    totalTools: number;
    servers: Record<
      string,
      { connected: boolean; toolCount: number; error?: string }
    >;
  }> {
    const results: Record<
      string,
      { connected: boolean; toolCount: number; error?: string }
    > = {};

    for (const [name, config] of this.servers) {
      if (!config.enabled) {
        this.serverErrors.set(name, "disabled");
        results[name] = { connected: false, toolCount: 0, error: "disabled" };
        continue;
      }

      // Already connected via addServer() — don't reconnect.
      if (this.initialized.has(name)) {
        const toolCount = this.countServerTools(name);
        results[name] = { connected: true, toolCount };
        continue;
      }

      try {
        const toolCount = await this.connectServer(name);
        results[name] = { connected: true, toolCount };
        this.emit("server_connected", { name, toolCount });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        this.serverErrors.set(name, msg);
        results[name] = { connected: false, toolCount: 0, error: msg };
        this.emit("server_error", { name, error: msg });
      }
    }

    return {
      totalServers: this.servers.size,
      totalTools: this.tools.size,
      servers: results,
    };
  }

  /**
   * Dynamically add (or replace) a server at runtime: register the config,
   * connect, and register its tools. Any previously-registered server of the
   * same name is removed first so this is safe to call for reconfiguration.
   */
  async addServer(
    config: MCPServerConfig,
  ): Promise<{ connected: boolean; toolCount: number; error?: string }> {
    // Replace any existing server/tools of the same name for a clean re-add.
    this.removeServer(config.name);
    this.registerServer(config);

    const server = this.servers.get(config.name);
    if (!server || !server.enabled) {
      this.serverErrors.set(config.name, "disabled");
      return { connected: false, toolCount: 0, error: "disabled" };
    }

    try {
      const toolCount = await this.connectServer(config.name);
      this.emit("server_connected", { name: config.name, toolCount });
      return { connected: true, toolCount };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      this.serverErrors.set(config.name, msg);
      this.emit("server_error", { name: config.name, error: msg });
      return { connected: false, toolCount: 0, error: msg };
    }
  }

  /**
   * Disconnect a server and deregister all of its tools. Idempotent — removing
   * an unknown server is a no-op.
   */
  removeServer(name: string): void {
    let removed = false;
    for (const [key, entry] of this.tools) {
      if (entry.server === name) {
        this.tools.delete(key);
      }
    }
    if (this.servers.delete(name)) removed = true;
    this.initialized.delete(name);
    this.serverErrors.delete(name);
    if (removed) this.emit("server_removed", { name });
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const entry = this.resolveTool(toolName);
    if (!entry) {
      return { success: false, error: `MCP tool '${toolName}' not found` };
    }

    const server = this.servers.get(entry.server);
    if (!server || !server.enabled) {
      return {
        success: false,
        error: `MCP server '${entry.server}' not available`,
      };
    }

    try {
      const response = await this.sendRequest(server, {
        jsonrpc: "2.0",
        id: ++this.requestId,
        method: "tools/call",
        // Servers expect their own bare tool name, not the prefixed one.
        params: { name: entry.originalName, arguments: args },
      });

      if (response.error) {
        return {
          success: false,
          error: response.error.message,
        };
      }

      return { success: true, data: response.result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /** Aggregated, prefixed tool list across all connected servers. */
  listTools(): MCPTool[] {
    return Array.from(this.tools.values()).map((e) => e.tool);
  }

  /** Alias kept for backward compatibility with existing callers. */
  getAvailableTools(): MCPTool[] {
    return this.listTools();
  }

  /** Name of the server that owns a tool, or undefined if unknown. */
  getServerForTool(toolName: string): string | undefined {
    return this.resolveTool(toolName)?.server;
  }

  getToolsForProvider(): Array<{
    name: string;
    description: string;
    params: Record<
      string,
      { type: string; description: string; required?: boolean }
    >;
    actionType: string;
    riskLevel: "low" | "medium" | "high";
  }> {
    return Array.from(this.tools.entries()).map(([name, entry]) => {
      const schema = entry.tool.inputSchema;
      const properties: Record<
        string,
        { type: string; description: string; required?: boolean }
      > = {};

      if (schema.properties) {
        for (const [key, val] of Object.entries(schema.properties)) {
          const v = val as any;
          properties[key] = {
            type: v.type || "string",
            description: v.description || "",
            required: schema.required?.includes(key),
          };
        }
      }

      return {
        name,
        description: `[MCP/${entry.server}] ${entry.tool.description}`,
        params: properties,
        actionType: `mcp.${entry.server}.${entry.originalName}`,
        riskLevel: "low" as const,
      };
    });
  }

  getServerStatus(): Record<string, MCPServerStatus> {
    const status: Record<string, MCPServerStatus> = {};
    for (const [name, config] of this.servers) {
      const connected = this.initialized.has(name);
      status[name] = {
        connected,
        toolCount: this.countServerTools(name),
        url: config.url,
        enabled: config.enabled !== false,
        error: this.serverErrors.get(name),
      };
    }
    return status;
  }

  isToolAvailable(toolName: string): boolean {
    return this.resolveTool(toolName) !== undefined;
  }

  private countServerTools(name: string): number {
    let count = 0;
    for (const entry of this.tools.values()) {
      if (entry.server === name) count++;
    }
    return count;
  }

  /**
   * Resolve a tool by its prefixed name (`{server}.{tool}`) first, then fall
   * back to a bare tool name for backward compatibility with callers that
   * don't know the prefix.
   *
   * The bare-name fallback is only honored when it is UNAMBIGUOUS. If two
   * servers expose the same bare tool name, a bare lookup can't tell them
   * apart, so we refuse to guess and return undefined — callers must use the
   * prefixed name to disambiguate. Returning an arbitrary (Map insertion
   * order) match would route calls nondeterministically to the wrong server.
   */
  private resolveTool(toolName: string): ToolEntry | undefined {
    const direct = this.tools.get(toolName);
    if (direct) return direct;

    let match: ToolEntry | undefined;
    for (const entry of this.tools.values()) {
      if (entry.originalName === toolName) {
        if (match) return undefined; // ambiguous bare name across servers
        match = entry;
      }
    }
    return match;
  }

  /** Connect a registered server and register its (prefixed) tools. */
  private async connectServer(name: string): Promise<number> {
    await this.initializeServer(name);
    const serverTools = await this.fetchServerTools(name);

    for (const tool of serverTools) {
      const prefixed = `${name}.${tool.name}`;
      this.tools.set(prefixed, {
        server: name,
        originalName: tool.name,
        tool: { ...tool, name: prefixed },
      });
    }

    this.initialized.add(name);
    this.serverErrors.delete(name);
    return serverTools.length;
  }

  private async initializeServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) throw new Error(`Server ${name} not found`);

    await this.sendRequest(server, {
      jsonrpc: "2.0",
      id: ++this.requestId,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "ai-assist-tim",
          version: "0.2.0",
        },
      },
    });
  }

  private async fetchServerTools(serverName: string): Promise<MCPTool[]> {
    const server = this.servers.get(serverName);
    if (!server) return [];

    const response = await this.sendRequest(server, {
      jsonrpc: "2.0",
      id: ++this.requestId,
      method: "tools/list",
    });

    if (response.result && typeof response.result === "object") {
      const result = response.result as any;
      return result.tools || [];
    }

    return [];
  }

  private async sendRequest(
    server: MCPServerConfig,
    request: MCPRequest,
  ): Promise<MCPResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // Streamable-HTTP MCP servers (e.g. Canva) require the client to accept
      // both JSON and SSE even when they answer with a single JSON body.
      Accept: "application/json, text/event-stream",
      ...server.headers,
    };

    // Dynamic OAuth bearer (refreshed per-request) wins over any static one.
    if (server.getAuthHeader) {
      const auth = await server.getAuthHeader();
      if (auth) headers.Authorization = auth;
      else delete headers.Authorization;
    }

    const response = await axios.post(server.url, request, {
      headers,
      timeout: 30000,
    });

    return response.data as MCPResponse;
  }
}

export const mcpClient = new MCPClient();
