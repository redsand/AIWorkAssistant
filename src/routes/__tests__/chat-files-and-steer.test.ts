/**
 * Coverage for the new chat file + steer endpoints.
 *
 * Uses Fastify in-process .inject() so we don't bind to a port. The
 * conversation manager + claimkit + agent-run plumbing is mocked away
 * to keep the test fast; we exercise the route shapes and the path
 * sandboxing only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import fs from "fs";
import os from "os";
import path from "path";

// ── Mocks (must be vi.mock not vi.doMock so they apply on the test's import) ──

vi.mock("../../config/env", () => ({
  env: { ADMIN_USER_IDS: "", CLAIMKIT_ENABLED: false, CONTEXT_PACKET_V2_BUDGET: false },
  resolvePath: (p: string) => p,
}));

const noopExport = { default: {}, isConfigured: () => false, getCurrentBranch: () => "main" };
vi.mock("../../agent", () => ({ getSystemPrompt: () => "sp", aiClient: { isConfigured: () => false } }));
vi.mock("../../agent/tool-registry", () => ({ getToolsForRequest: () => [], getToolsByCategory: () => [], getToolCategories: () => ({}) }));
vi.mock("../../agent/tool-dispatcher", () => ({
  dispatchToolCall: vi.fn(),
  resolveToolName: (n: string) => n,
  recordAndCheckIdenticalCall: () => ({ blocked: false }),
  recordToolResultEmpty: () => ({ nudge: undefined }),
}));
vi.mock("../../agent/todo-manager", () => ({ todoManager: { ...noopExport } }));
vi.mock("../../agent/knowledge-store", () => ({ knowledgeStore: { search: () => [] } }));
vi.mock("../../agent/knowledge-graph", () => ({ knowledgeGraph: { queryNodes: () => [], getNode: () => null, getEdgesForNode: () => [] } }));
vi.mock("../../agent/codebase-indexer", () => ({ codebaseIndexer: { search: () => [], getStats: () => ({}) } }));
vi.mock("../../context-engine", () => ({ shouldUseContextEngine: () => false, assembleContext: async () => ({ messages: [], packet: null }) }));
vi.mock("../../memory/tool-cache", () => ({ toolCallCache: { warmSession: async () => {}, get: () => null, isCacheable: () => false } }));
vi.mock("../../integrations/github/github-client", () => ({ githubClient: { isConfigured: () => false } }));
vi.mock("../../integrations/jitbit/jitbit-client", () => ({ jitbitClient: { isConfigured: () => false } }));
vi.mock("../../integrations/gitlab/gitlab-client", () => ({ gitlabClient: { isConfigured: () => false } }));
vi.mock("../../integrations/jira/jira-client", () => ({ jiraClient: { isConfigured: () => false } }));
vi.mock("../../memory/conversation-manager", () => ({
  conversationManager: {
    getSession: (id: string) => ({ id, messages: [] }),
    addMessage: vi.fn(),
    startSession: () => "s",
    listSessionsForUser: () => [],
    getSessionMessagesForDisplay: () => [],
    deleteSession: vi.fn(),
  },
}));
vi.mock("../../agent-runs/database", () => ({
  agentRunDatabase: {
    startRun: () => ({ id: "r" }),
    failRun: vi.fn(),
    completeRun: vi.fn(),
    cancelRun: vi.fn(),
    addStep: vi.fn(),
    updateToolLoopCount: vi.fn(),
  },
}));
vi.mock("../../agent-runs/reaper", () => ({ setOnReapCallback: vi.fn() }));
vi.mock("../../agent/providers/zai-rate-limiter", () => ({ zaiRateLimiter: { acquire: vi.fn(), release: vi.fn() } }));
vi.mock("../../agent/provider-settings", () => ({ providerSettings: { getCurrent: () => ({ provider: "ollama" }) } }));
vi.mock("../../agent/provider-preflight", () => ({ runProviderPreflight: async () => ({ ok: true }) }));
vi.mock("../../observability/error-log", () => ({ errorLog: { log: vi.fn() } }));
vi.mock("../../context-engine/adapters/claimkit-adapter", () => ({ claimKitAdapter: { isAvailable: () => false } }));
vi.mock("../../agent/embedding-service", () => ({ embeddingService: { isAvailable: async () => false } }));
vi.mock("../../comparison-runs/database", () => ({ comparisonRunDatabase: {} }));
vi.mock("../../memory/entity-memory", () => ({ entityMemory: { findEntities: () => [] } }));
vi.mock("../../context-engine/entity-claims-injector", () => ({ extractEntityIds: () => [] }));
vi.mock("../../config/constants", () => ({ AGENT_MODES: { PRODUCTIVITY: "productivity", ENGINEERING: "engineering" } }));

describe("/chat/sessions/:id/steer", () => {
  let app: FastifyInstance;
  let chatRoutes: typeof import("../chat").chatRoutes;

  beforeEach(async () => {
    vi.resetModules();
    chatRoutes = (await import("../chat")).chatRoutes;
    app = Fastify({ logger: false });
    await app.register(chatRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 400 when message is missing", async () => {
    const res = await app.inject({ method: "POST", url: "/chat/sessions/test-1/steer", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/message/i);
  });

  it("returns 400 when message is too long", async () => {
    const huge = "x".repeat(2001);
    const res = await app.inject({ method: "POST", url: "/chat/sessions/test-1/steer", payload: { message: huge } });
    expect(res.statusCode).toBe(400);
  });

  it("returns 409 when no active run exists for the session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/chat/sessions/no-such-session/steer",
      payload: { message: "pivot" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/no active run/i);
  });
});

describe("/chat/files/download — sandbox", () => {
  let app: FastifyInstance;
  let chatRoutes: typeof import("../chat").chatRoutes;
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-download-"));
    process.chdir(tmpDir);
    vi.resetModules();
    chatRoutes = (await import("../chat")).chatRoutes;
    app = Fastify({ logger: false });
    await app.register(chatRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    process.chdir(originalCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("400 when path is missing", async () => {
    const res = await app.inject({ method: "GET", url: "/chat/files/download" });
    expect(res.statusCode).toBe(400);
  });

  it("400 when path is outside the sandbox", async () => {
    const evil = path.resolve(os.tmpdir(), "definitely-not-the-workspace.txt");
    const res = await app.inject({
      method: "GET",
      url: `/chat/files/download?path=${encodeURIComponent(evil)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/sandbox/i);
  });

  it("403 for .env paths inside the workspace", async () => {
    const env = path.join(tmpDir, ".env");
    fs.writeFileSync(env, "SECRET=1");
    const res = await app.inject({
      method: "GET",
      url: `/chat/files/download?path=${encodeURIComponent(env)}`,
    });
    expect(res.statusCode).toBe(403);
  });

  it("404 when path is valid but file is missing", async () => {
    const missing = path.join(tmpDir, "nope.docx");
    const res = await app.inject({
      method: "GET",
      url: `/chat/files/download?path=${encodeURIComponent(missing)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("streams the file with correct mime + filename for a real workspace file", async () => {
    const f = path.join(tmpDir, "incident_report.docx");
    const body = Buffer.from("fake docx body").toString();
    fs.writeFileSync(f, body);
    const res = await app.inject({
      method: "GET",
      url: `/chat/files/download?path=${encodeURIComponent(f)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/);
    expect(res.headers["content-disposition"]).toMatch(/incident_report\.docx/);
    expect(res.body).toBe(body);
  });
});

describe("/chat/sessions/:id/files — upload sandbox", () => {
  let app: FastifyInstance;
  let chatRoutes: typeof import("../chat").chatRoutes;
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-upload-"));
    process.chdir(tmpDir);
    vi.resetModules();
    chatRoutes = (await import("../chat")).chatRoutes;
    app = Fastify({ logger: false });
    await app.register(chatRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    process.chdir(originalCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("400 when files[] is missing", async () => {
    const res = await app.inject({ method: "POST", url: "/chat/sessions/uuid-1/files", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("400 when more than 50 files", async () => {
    const files = Array.from({ length: 51 }, (_, i) => ({ name: `f${i}.txt`, contentBase64: "AAA=" }));
    const res = await app.inject({ method: "POST", url: "/chat/sessions/uuid-1/files", payload: { files } });
    expect(res.statusCode).toBe(400);
  });

  it("strips directory traversal from filenames", async () => {
    const payload = {
      files: [
        { name: "../../../etc/passwd", contentBase64: Buffer.from("nope").toString("base64") },
      ],
    };
    const res = await app.inject({
      method: "POST",
      url: "/chat/sessions/12345678-1234-1234-1234-1234567890ab/files",
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Either skipped entirely or written with a safe name — never in /etc.
    for (const f of body.files) {
      expect(f.path).not.toMatch(/etc[\\/]passwd/);
      expect(f.path).toMatch(/uploads/);
    }
  });

  it("accepts a normal file and writes it under data/profiles/default/uploads/<session>", async () => {
    const content = "Hello, attachment!";
    const payload = {
      files: [
        { name: "notes.txt", mime: "text/plain", contentBase64: Buffer.from(content).toString("base64") },
      ],
    };
    const sessionId = "12345678-1234-1234-1234-1234567890ab";
    const res = await app.inject({
      method: "POST",
      url: `/chat/sessions/${sessionId}/files`,
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.files).toHaveLength(1);
    expect(body.files[0].name).toBe("notes.txt");
    expect(body.files[0].size).toBe(content.length);
    expect(body.files[0].path).toMatch(/uploads[\\/]12345678/);
    const onDisk = fs.readFileSync(body.files[0].path, "utf-8");
    expect(onDisk).toBe(content);
  });

  it("413 when a file exceeds the 10MB cap", async () => {
    const big = "A".repeat(11 * 1024 * 1024);
    const res = await app.inject({
      method: "POST",
      url: "/chat/sessions/12345678-1234-1234-1234-1234567890ab/files",
      payload: { files: [{ name: "big.bin", contentBase64: Buffer.from(big).toString("base64") }] },
    });
    expect(res.statusCode).toBe(413);
  });
});
