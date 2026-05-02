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

class MCPClient extends EventEmitter {
  private servers: Map<string, MCPServerConfig> = new Map();
  private tools: Map<string, { server: string; tool: MCPTool }> = new Map();
  private requestId = 0;
  private initialized: Set<string> = new Set();

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
        results[name] = { connected: false, toolCount: 0, error: "disabled" };
        continue;
      }

      try {
        await this.initializeServer(name);
        const serverTools = await this.listTools(name);
        results[name] = { connected: true, toolCount: serverTools.length };

        for (const tool of serverTools) {
          this.tools.set(tool.name, { server: name, tool });
        }

        this.initialized.add(name);
        this.emit("server_connected", { name, toolCount: serverTools.length });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
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

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const entry = this.tools.get(toolName);
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
        params: { name: toolName, arguments: args },
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

  getAvailableTools(): MCPTool[] {
    return Array.from(this.tools.values()).map((e) => e.tool);
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
        actionType: `mcp.${entry.server}.${name}`,
        riskLevel: "low" as const,
      };
    });
  }

  getServerStatus(): Record<
    string,
    { connected: boolean; toolCount: number; url: string }
  > {
    const status: Record<
      string,
      { connected: boolean; toolCount: number; url: string }
    > = {};
    for (const [name, config] of this.servers) {
      const connected = this.initialized.has(name);
      const toolCount = Array.from(this.tools.values()).filter(
        (e) => e.server === name,
      ).length;
      status[name] = { connected, toolCount, url: config.url };
    }
    return status;
  }

  isToolAvailable(toolName: string): boolean {
    return this.tools.has(toolName);
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

  private async listTools(serverName: string): Promise<MCPTool[]> {
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
      ...server.headers,
    };

    const response = await axios.post(server.url, request, {
      headers,
      timeout: 30000,
    });

    return response.data as MCPResponse;
  }
}

export const mcpClient = new MCPClient();
