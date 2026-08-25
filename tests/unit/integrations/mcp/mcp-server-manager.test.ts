// tests/unit/integrations/mcp/mcp-server-manager.test.ts
//
// Unit coverage for the dynamic MCP server manager: config loading (file +
// env fallback, array + {servers} shapes, invalid-entry skipping), add/remove
// lifecycle, authToken → Authorization header mapping, and hot-reload diffing.
// A lightweight fake client stands in for the real MCPClient so no network
// connections are opened.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  McpServerManager,
  mcpServerFileConfigSchema,
} from "../../../../src/integrations/mcp/mcp-server-manager";
import type {
  McpConnectionClient,
  McpServerFileConfig,
} from "../../../../src/integrations/mcp/mcp-server-manager";
import type {
  MCPServerConfig,
  MCPServerStatus,
} from "../../../../src/integrations/mcp/mcp-client";

/** In-memory stand-in for MCPClient that records what the manager asks of it. */
class FakeClient implements McpConnectionClient {
  added: MCPServerConfig[] = [];
  removed: string[] = [];
  servers: Map<string, MCPServerConfig> = new Map();
  // Optional map: server name -> tool names it owns, for getServerForTool.
  toolOwners: Map<string, string> = new Map();
  failOn: Set<string> = new Set();

  async addServer(config: MCPServerConfig) {
    this.added.push(config);
    if (this.failOn.has(config.name)) {
      throw new Error(`boom:${config.name}`);
    }
    this.servers.set(config.name, config);
    return { connected: config.enabled !== false, toolCount: 1 };
  }

  removeServer(name: string): void {
    this.removed.push(name);
    this.servers.delete(name);
  }

  getServerForTool(toolName: string): string | undefined {
    return this.toolOwners.get(toolName);
  }

  getServerStatus(): Record<string, MCPServerStatus> {
    const status: Record<string, MCPServerStatus> = {};
    for (const [name, config] of this.servers) {
      status[name] = {
        connected: config.enabled !== false,
        toolCount: 1,
        url: config.url,
        enabled: config.enabled !== false,
      };
    }
    return status;
  }
}

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mgr-"));
  configPath = path.join(tmpDir, "mcp-servers.json");
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

function writeConfig(data: unknown): void {
  fs.writeFileSync(configPath, JSON.stringify(data), "utf-8");
}

function newManager(overrides: {
  client?: FakeClient;
  envFallback?: string;
  configPath?: string;
} = {}): { manager: McpServerManager; client: FakeClient } {
  const client = overrides.client ?? new FakeClient();
  const manager = new McpServerManager({
    client,
    configPath: overrides.configPath ?? configPath,
    envFallback: overrides.envFallback ?? "",
  });
  return { manager, client };
}

describe("mcpServerFileConfigSchema", () => {
  it("applies defaults for authToken and enabled", () => {
    const parsed = mcpServerFileConfigSchema.parse({
      name: "svc",
      url: "https://example.com/mcp",
    });
    expect(parsed.authToken).toBe("");
    expect(parsed.enabled).toBe(true);
  });

  it("rejects entries without a valid url", () => {
    const result = mcpServerFileConfigSchema.safeParse({
      name: "svc",
      url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });
});

describe("loadServerConfig", () => {
  it("reads a top-level array from the config file", () => {
    writeConfig([
      { name: "a", url: "https://a.example/mcp", authToken: "t", enabled: true },
    ]);
    const { manager } = newManager();
    const configs = manager.loadServerConfig();
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("a");
    expect(configs[0].authToken).toBe("t");
  });

  it("reads a { servers: [...] } wrapper from the config file", () => {
    writeConfig({
      servers: [{ name: "b", url: "https://b.example/mcp" }],
    });
    const { manager } = newManager();
    const configs = manager.loadServerConfig();
    expect(configs.map((c) => c.name)).toEqual(["b"]);
  });

  it("falls back to the env var when the file is absent", () => {
    const envFallback = JSON.stringify([
      { name: "envsvc", url: "https://env.example/mcp" },
    ]);
    const { manager } = newManager({
      configPath: path.join(tmpDir, "does-not-exist.json"),
      envFallback,
    });
    const configs = manager.loadServerConfig();
    expect(configs.map((c) => c.name)).toEqual(["envsvc"]);
  });

  it("returns an empty array when neither file nor env is present", () => {
    const { manager } = newManager({
      configPath: path.join(tmpDir, "missing.json"),
      envFallback: "",
    });
    expect(manager.loadServerConfig()).toEqual([]);
  });

  it("skips invalid entries but keeps valid ones", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeConfig([
      { name: "good", url: "https://good.example/mcp" },
      { name: "bad", url: "not-a-url" },
      { url: "https://noname.example/mcp" },
    ]);
    const { manager } = newManager();
    const configs = manager.loadServerConfig();
    expect(configs.map((c) => c.name)).toEqual(["good"]);
    expect(errSpy).toHaveBeenCalled();
  });

  it("returns an empty array on malformed JSON", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.writeFileSync(configPath, "{ not json", "utf-8");
    const { manager } = newManager();
    expect(manager.loadServerConfig()).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe("addServer / removeServer", () => {
  it("maps authToken to an Authorization bearer header", async () => {
    const { manager, client } = newManager();
    await manager.addServer(
      mcpServerFileConfigSchema.parse({
        name: "svc",
        url: "https://svc.example/mcp",
        authToken: "secret123",
      }),
    );
    expect(client.added).toHaveLength(1);
    expect(client.added[0].headers?.Authorization).toBe("Bearer secret123");
    expect(manager.listServers()).toEqual(["svc"]);
  });

  it("does not override an explicit Authorization header", async () => {
    const { manager, client } = newManager();
    await manager.addServer(
      mcpServerFileConfigSchema.parse({
        name: "svc",
        url: "https://svc.example/mcp",
        authToken: "ignored",
        headers: { Authorization: "Basic abc" },
      }),
    );
    expect(client.added[0].headers?.Authorization).toBe("Basic abc");
  });

  it("omits headers entirely when there is no auth token", async () => {
    const { manager, client } = newManager();
    await manager.addServer(
      mcpServerFileConfigSchema.parse({
        name: "svc",
        url: "https://svc.example/mcp",
      }),
    );
    expect(client.added[0].headers).toBeUndefined();
  });

  it("records the server as applied even when the client throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new FakeClient();
    client.failOn.add("svc");
    const { manager } = newManager({ client });
    const result = await manager.addServer(
      mcpServerFileConfigSchema.parse({
        name: "svc",
        url: "https://svc.example/mcp",
      }),
    );
    expect(result.connected).toBe(false);
    expect(result.error).toContain("boom");
    expect(manager.listServers()).toEqual(["svc"]);
  });

  it("removes a server and forgets it", async () => {
    const { manager, client } = newManager();
    await manager.addServer(
      mcpServerFileConfigSchema.parse({
        name: "svc",
        url: "https://svc.example/mcp",
      }),
    );
    manager.removeServer("svc");
    expect(client.removed).toContain("svc");
    expect(manager.listServers()).toEqual([]);
  });
});

describe("reloadServers", () => {
  it("adds all servers on first load", async () => {
    writeConfig([
      { name: "a", url: "https://a.example/mcp" },
      { name: "b", url: "https://b.example/mcp" },
    ]);
    const { manager } = newManager();
    const diff = await manager.reloadServers();
    expect(diff.added.sort()).toEqual(["a", "b"]);
    expect(diff.removed).toEqual([]);
    expect(manager.listServers().sort()).toEqual(["a", "b"]);
  });

  it("removes servers dropped from the config and keeps unchanged ones", async () => {
    writeConfig([
      { name: "a", url: "https://a.example/mcp" },
      { name: "b", url: "https://b.example/mcp" },
    ]);
    const { manager, client } = newManager();
    await manager.reloadServers();

    // Drop "b", keep "a" unchanged.
    writeConfig([{ name: "a", url: "https://a.example/mcp" }]);
    const diff = await manager.reloadServers();

    expect(diff.removed).toEqual(["b"]);
    expect(diff.unchanged).toEqual(["a"]);
    expect(diff.added).toEqual([]);
    expect(client.removed).toContain("b");
    expect(manager.listServers()).toEqual(["a"]);
  });

  it("re-adds a server whose config changed", async () => {
    writeConfig([
      { name: "a", url: "https://a.example/mcp", authToken: "old" },
    ]);
    const { manager, client } = newManager();
    await manager.reloadServers();
    expect(client.added).toHaveLength(1);

    writeConfig([
      { name: "a", url: "https://a.example/mcp", authToken: "new" },
    ]);
    const diff = await manager.reloadServers();
    expect(diff.added).toEqual(["a"]);
    expect(diff.unchanged).toEqual([]);
    // Re-added with the new token mapped to a fresh Authorization header.
    expect(client.added).toHaveLength(2);
    expect(client.added[1].headers?.Authorization).toBe("Bearer new");
  });
});

describe("getServerForTool / getServerStatus", () => {
  it("delegates tool ownership lookups to the client", () => {
    const client = new FakeClient();
    client.toolOwners.set("hawk-ir.get_cases", "hawk-ir");
    const { manager } = newManager({ client });
    expect(manager.getServerForTool("hawk-ir.get_cases")).toBe("hawk-ir");
    expect(manager.getServerForTool("unknown")).toBeUndefined();
  });

  it("reports live status from the client", async () => {
    const { manager } = newManager();
    await manager.addServer(
      mcpServerFileConfigSchema.parse({
        name: "svc",
        url: "https://svc.example/mcp",
      }),
    );
    const status = manager.getServerStatus();
    expect(status.svc).toMatchObject({ connected: true, toolCount: 1 });
  });
});

describe("initialize + watching", () => {
  it("loads config and can be stopped cleanly", async () => {
    writeConfig([{ name: "a", url: "https://a.example/mcp" }]);
    const { manager } = newManager();
    await manager.initialize();
    expect(manager.listServers()).toEqual(["a"]);
    // startWatching is idempotent and stopWatching is safe to call.
    manager.startWatching();
    expect(() => manager.stopWatching()).not.toThrow();
  });
});
