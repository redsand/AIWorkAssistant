import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import path from "path";
import { createSessionToken } from "../../src/middleware/auth";

let server: FastifyInstance;
let authToken: string;

async function buildTestServer(): Promise<FastifyInstance> {
  process.env.OPENCODE_API_KEY = "test-e2e-api-key-caps";
  process.env.AUTH_PASSWORD = "test-password";
  process.env.PORT = "0";
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "sqlite::memory:";
  process.env.AUDIT_LOG_FILE = path.join(
    process.cwd(),
    "data",
    "audit",
    `test-caps-${Date.now()}.log`,
  );

  const { buildServer } = await import("../../src/server");
  return buildServer();
}

describe("E2E: Capabilities endpoints", () => {
  beforeAll(async () => {
    server = await buildTestServer();
    await server.ready();
    authToken = createSessionToken("e2e-caps-user");
  });

  afterAll(async () => {
    await server.close();
  });

  // ── Public access (no auth) ──────────────────────────────────────────────

  describe("public access — no auth header", () => {
    it("GET /api/agents returns 200 without authentication", async () => {
      const res = await server.inject({ method: "GET", url: "/api/agents" });
      expect(res.statusCode).toBe(200);
    });

    it("GET /api/tools returns 200 without authentication", async () => {
      const res = await server.inject({ method: "GET", url: "/api/tools" });
      expect(res.statusCode).toBe(200);
    });

    it("GET /api/tools/categories returns 200 without authentication", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/tools/categories",
      });
      expect(res.statusCode).toBe(200);
    });

    it("GET /capabilities returns 200 without authentication", async () => {
      const res = await server.inject({ method: "GET", url: "/capabilities" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
    });
  });

  // ── GET /api/agents ──────────────────────────────────────────────────────

  describe("GET /api/agents", () => {
    it("returns an array of agent capability objects", async () => {
      const res = await server.inject({ method: "GET", url: "/api/agents" });
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
    });

    it("each agent has required fields", async () => {
      const res = await server.inject({ method: "GET", url: "/api/agents" });
      const agents: any[] = res.json();
      for (const agent of agents) {
        expect(agent).toHaveProperty("id");
        expect(agent).toHaveProperty("name");
        expect(agent).toHaveProperty("description");
        expect(agent).toHaveProperty("type");
        expect(["chat_mode", "specialized_api"]).toContain(agent.type);
        expect(agent).toHaveProperty("features");
        expect(Array.isArray(agent.features)).toBe(true);
        expect(agent).toHaveProperty("toolCategories");
        expect(agent).toHaveProperty("toolCount");
        expect(typeof agent.toolCount).toBe("number");
      }
    });

    it("includes formal chat modes (productivity, engineering)", async () => {
      const res = await server.inject({ method: "GET", url: "/api/agents" });
      const agents: any[] = res.json();
      const ids = agents.map((a) => a.id);
      expect(ids).toContain("productivity");
      expect(ids).toContain("engineering");
    });

    it("includes specialized API agents", async () => {
      const res = await server.inject({ method: "GET", url: "/api/agents" });
      const agents: any[] = res.json();
      const ids = agents.map((a) => a.id);
      expect(ids).toContain("cto_daily_command");
      expect(ids).toContain("personal_os");
      expect(ids).toContain("code_review");
      expect(ids).toContain("product_chief_of_staff");
      expect(ids).toContain("customer_intelligence");
      expect(ids).toContain("detection_engineering");
      expect(ids).toContain("weekly_digest");
    });

    it("chat mode agents have a mode field", async () => {
      const res = await server.inject({ method: "GET", url: "/api/agents" });
      const agents: any[] = res.json();
      const chatAgents = agents.filter((a) => a.type === "chat_mode");
      for (const agent of chatAgents) {
        expect(agent).toHaveProperty("mode");
        expect(typeof agent.mode).toBe("string");
      }
    });
  });

  // ── GET /api/tools ───────────────────────────────────────────────────────

  describe("GET /api/tools", () => {
    it("returns total count and tools array", async () => {
      const res = await server.inject({ method: "GET", url: "/api/tools" });
      const body = res.json();
      expect(body).toHaveProperty("total");
      expect(body).toHaveProperty("tools");
      expect(Array.isArray(body.tools)).toBe(true);
      expect(body.total).toBe(body.tools.length);
    });

    it("returns a meaningful number of tools", async () => {
      const res = await server.inject({ method: "GET", url: "/api/tools" });
      const { total } = res.json();
      expect(total).toBeGreaterThan(50);
    });

    it("each tool has required fields", async () => {
      const res = await server.inject({ method: "GET", url: "/api/tools" });
      const { tools }: { tools: any[] } = res.json();
      for (const tool of tools) {
        expect(tool).toHaveProperty("name");
        expect(tool).toHaveProperty("description");
        expect(tool).toHaveProperty("category");
        expect(tool).toHaveProperty("platform");
        expect(tool).toHaveProperty("actionType");
        expect(tool).toHaveProperty("riskLevel");
        expect(["low", "medium", "high"]).toContain(tool.riskLevel);
        expect(tool).toHaveProperty("params");
        expect(Array.isArray(tool.params)).toBe(true);
        expect(tool).toHaveProperty("modes");
        expect(Array.isArray(tool.modes)).toBe(true);
      }
    });

    it("tool names are dot-namespaced", async () => {
      const res = await server.inject({ method: "GET", url: "/api/tools" });
      const { tools }: { tools: any[] } = res.json();
      for (const tool of tools) {
        expect(tool.name).toMatch(/^[a-z_]+\.[a-z_]+$/);
      }
    });

    it("tool list is deduplicated (no duplicate names)", async () => {
      const res = await server.inject({ method: "GET", url: "/api/tools" });
      const { tools }: { tools: any[] } = res.json();
      const names = tools.map((t) => t.name);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    });

    it("expected tool categories are present", async () => {
      const res = await server.inject({ method: "GET", url: "/api/tools" });
      const { tools }: { tools: any[] } = res.json();
      const categories = new Set(tools.map((t) => t.category));
      for (const cat of [
        "calendar",
        "jira",
        "gitlab",
        "github",
        "jitbit",
        "hawk_ir",
      ]) {
        expect(categories.has(cat)).toBe(true);
      }
    });

    it("engineering tools only appear in engineering mode", async () => {
      const res = await server.inject({ method: "GET", url: "/api/tools" });
      const { tools }: { tools: any[] } = res.json();
      const engTools = tools.filter((t) => t.category === "engineering");
      for (const tool of engTools) {
        expect(tool.modes).toContain("engineering");
      }
    });
  });

  // ── GET /api/tools/categories ────────────────────────────────────────────

  describe("GET /api/tools/categories", () => {
    it("returns totalCategories, totalTools, and categories object", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/tools/categories",
      });
      const body = res.json();
      expect(body).toHaveProperty("totalCategories");
      expect(body).toHaveProperty("totalTools");
      expect(body).toHaveProperty("categories");
      expect(typeof body.categories).toBe("object");
    });

    it("total tools matches sum across categories", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/tools/categories",
      });
      const { totalTools, categories } = res.json();
      const sum = Object.values(categories as Record<string, any[]>).reduce(
        (acc, tools) => acc + tools.length,
        0,
      );
      expect(sum).toBe(totalTools);
    });

    it("categories match /api/tools total", async () => {
      const [catRes, toolRes] = await Promise.all([
        server.inject({ method: "GET", url: "/api/tools/categories" }),
        server.inject({ method: "GET", url: "/api/tools" }),
      ]);
      const { totalTools } = catRes.json();
      const { total } = toolRes.json();
      expect(totalTools).toBe(total);
    });

    it("tools within each category share the same category prefix", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/tools/categories",
      });
      const { categories } = res.json();
      for (const [cat, tools] of Object.entries(
        categories as Record<string, any[]>,
      )) {
        for (const tool of tools) {
          expect(tool.name.startsWith(cat + ".")).toBe(true);
        }
      }
    });
  });

  // ── Authenticated access still works ────────────────────────────────────

  describe("authenticated access", () => {
    it("GET /api/tools works with session token", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/tools",
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("GET /api/agents works with session token", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/agents",
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
