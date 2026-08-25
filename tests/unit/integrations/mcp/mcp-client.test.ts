// tests/unit/integrations/mcp/mcp-client.test.ts
//
// Unit coverage for the low-level MCP client's tool registry and resolution.
// Focus: resolveTool()'s prefixed-vs-bare lookup, and specifically that a bare
// tool name shared by two servers is treated as AMBIGUOUS (refused) rather
// than routed nondeterministically to whichever server Map iteration hits
// first. axios is mocked so no real network connections are opened.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("axios", () => ({
  default: { post: vi.fn() },
}));

import axios from "axios";
import { MCPClient } from "../../../../src/integrations/mcp/mcp-client";

const mockedPost = axios.post as unknown as ReturnType<typeof vi.fn>;

// Bare tool names each server exposes. serverA and serverB both expose "foo"
// (the collision case); "bar" is unique to serverA.
const TOOLS_BY_URL: Record<string, string[]> = {
  "https://a.example/mcp": ["foo", "bar"],
  "https://b.example/mcp": ["foo"],
};

beforeEach(() => {
  mockedPost.mockReset();
  mockedPost.mockImplementation(async (url: string, request: any) => {
    if (request.method === "initialize") {
      return { data: { jsonrpc: "2.0", id: request.id, result: {} } };
    }
    if (request.method === "tools/list") {
      const names = TOOLS_BY_URL[url] ?? [];
      return {
        data: {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            tools: names.map((name) => ({
              name,
              description: `${name} description`,
              inputSchema: { type: "object" },
            })),
          },
        },
      };
    }
    if (request.method === "tools/call") {
      // Echo back which server/tool was targeted so callers can assert routing.
      return {
        data: {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            url,
            name: request.params.name,
            arguments: request.params.arguments,
          },
        },
      };
    }
    throw new Error(`unexpected method ${request.method}`);
  });
});

/** Build a client with serverA (foo, bar) and serverB (foo) connected. */
async function twoServerClient(): Promise<MCPClient> {
  const client = new MCPClient();
  await client.addServer({
    name: "serverA",
    url: "https://a.example/mcp",
    enabled: true,
  });
  await client.addServer({
    name: "serverB",
    url: "https://b.example/mcp",
    enabled: true,
  });
  return client;
}

describe("resolveTool via prefixed names", () => {
  it("resolves each server's tool by its prefixed name", async () => {
    const client = await twoServerClient();
    expect(client.isToolAvailable("serverA.foo")).toBe(true);
    expect(client.isToolAvailable("serverB.foo")).toBe(true);
    expect(client.getServerForTool("serverA.foo")).toBe("serverA");
    expect(client.getServerForTool("serverB.foo")).toBe("serverB");
  });

  it("routes a prefixed callTool to the owning server with the bare name", async () => {
    const client = await twoServerClient();
    const res = await client.callTool("serverB.foo", { x: 1 });
    expect(res.success).toBe(true);
    // Routed to serverB's URL, carrying the bare tool name the server expects.
    expect(res.data).toMatchObject({
      url: "https://b.example/mcp",
      name: "foo",
      arguments: { x: 1 },
    });
  });

  it("exposes prefixed names in the aggregated tool list", async () => {
    const client = await twoServerClient();
    const names = client.listTools().map((t) => t.name).sort();
    expect(names).toEqual(["serverA.bar", "serverA.foo", "serverB.foo"]);
  });
});

describe("resolveTool bare-name ambiguity", () => {
  it("refuses to resolve a bare name exposed by two servers", async () => {
    const client = await twoServerClient();
    // "foo" exists on both servers — a bare lookup cannot pick one.
    expect(client.isToolAvailable("foo")).toBe(false);
    expect(client.getServerForTool("foo")).toBeUndefined();
  });

  it("does not route an ambiguous bare callTool to an arbitrary server", async () => {
    const client = await twoServerClient();
    const res = await client.callTool("foo", {});
    expect(res.success).toBe(false);
    expect(res.error).toContain("not found");
    // The request must never have been dispatched to a server.
    expect(
      mockedPost.mock.calls.some(
        ([, request]: any[]) => request.method === "tools/call",
      ),
    ).toBe(false);
  });

  it("still resolves a bare name that is unique to one server", async () => {
    const client = await twoServerClient();
    // "bar" only exists on serverA, so the bare fallback stays unambiguous.
    expect(client.isToolAvailable("bar")).toBe(true);
    expect(client.getServerForTool("bar")).toBe("serverA");
    const res = await client.callTool("bar", {});
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ url: "https://a.example/mcp", name: "bar" });
  });

  it("bare name becomes resolvable again once the collision is removed", async () => {
    const client = await twoServerClient();
    expect(client.getServerForTool("foo")).toBeUndefined();
    // Drop serverB; now only serverA.foo remains, so "foo" is unambiguous.
    client.removeServer("serverB");
    expect(client.getServerForTool("foo")).toBe("serverA");
    expect(client.isToolAvailable("foo")).toBe(true);
  });
});
