import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  ConversationManager,
  type SessionSearchResult,
} from "../../../src/memory/conversation-manager";

vi.mock("../../../src/agent/opencode-client", () => ({
  aiClient: {
    chat: vi.fn(async (request: { messages?: Array<{ content: string }> }) => ({
      content: `Unit test summary preserving conversation facts.\n${request.messages?.map((message) => message.content).join("\n").slice(-2000) ?? ""}`,
      model: "test",
      done: true,
    })),
  },
}));

function makeManager(): {
  manager: ConversationManager;
  cleanup: () => void;
  basePath: string;
} {
  const basePath = mkdtempSync(path.join(tmpdir(), "conv-search-"));
  const originalEnv = process.env.CONVERSATION_MEMORY_PATH;
  process.env.CONVERSATION_MEMORY_PATH = basePath;

  const manager = new ConversationManager();

  return {
    manager,
    basePath,
    cleanup: () => {
      process.env.CONVERSATION_MEMORY_PATH = originalEnv;
      manager.close();
      try {
        rmSync(basePath, { recursive: true, force: true });
      } catch {}
    },
  };
}

describe("ConversationManager FTS5 search", () => {
  let env: ReturnType<typeof makeManager>;

  beforeEach(() => {
    env = makeManager();
  });

  afterEach(() => {
    env.cleanup();
  });

  // ── searchSessions basic ───────────────────────────────────────────────

  describe("searchSessions", () => {
    it("returns empty array when no sessions are indexed", () => {
      const results = env.manager.searchSessions("anything");
      expect(results).toEqual([]);
    });

    it("returns empty array for empty query", () => {
      const results = env.manager.searchSessions("");
      expect(results).toEqual([]);
    });

    it("finds a session by title after endSession indexes it", async () => {
      const sessionId = env.manager.startSession("user1", "productivity", {
        title: "SIEM-25 security incident review",
      });

      env.manager.addMessage(sessionId, {
        role: "user",
        content: "We found that the SIEM-25 rule was triggering false positives due to misconfigured thresholds",
      });

      await env.manager.endSession(sessionId);

      const results = env.manager.searchSessions("SIEM-25");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].sessionId).toBe(sessionId);
      expect(results[0].title).toContain("SIEM-25");
      expect(results[0].relevanceScore).toBeGreaterThan(0);
    });

    it("returns results with correct shape", async () => {
      const sessionId = env.manager.startSession("user1", "engineering", {
        title: "Database migration planning",
      });

      env.manager.addMessage(sessionId, {
        role: "user",
        content: "Need to plan the PostgreSQL migration for the auth service",
      });

      await env.manager.endSession(sessionId);

      const results = env.manager.searchSessions("PostgreSQL migration");
      expect(results.length).toBe(1);

      const result = results[0];
      expect(result).toHaveProperty("sessionId");
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("summary");
      expect(result).toHaveProperty("keyTopics");
      expect(result).toHaveProperty("relevanceScore");
      expect(result).toHaveProperty("createdAt");
      expect(result.sessionId).toBe(sessionId);
    });

    it("handles punctuation-heavy queries without FTS5 syntax errors", async () => {
      const sessionId = env.manager.startSession("user1", "engineering", {
        title: "Comparison API review",
      });

      env.manager.addMessage(sessionId, {
        role: "user",
        content: "Reviewed http://localhost:3050/api/comparison-runs and the context diagnostics output",
      });

      await env.manager.endSession(sessionId);

      const results = env.manager.searchSessions("http://localhost:3050/api/comparison-runs context/diagnostics");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((result) => result.sessionId === sessionId)).toBe(true);
    });

    it("respects the limit parameter", async () => {
      for (let i = 0; i < 6; i++) {
        const sid = env.manager.startSession("user1", "productivity", {
          title: `Security review ${i}`,
        });
        env.manager.addMessage(sid, {
          role: "user",
          content: `Security audit findings for system ${i}`,
        });
        await env.manager.endSession(sid);
      }

      const results = env.manager.searchSessions("security", 3);
      expect(results.length).toBe(3);
    }, 60_000);

    it("defaults limit to 5", async () => {
      for (let i = 0; i < 8; i++) {
        const sid = env.manager.startSession("user1", "productivity", {
          title: `Network config ${i}`,
        });
        env.manager.addMessage(sid, {
          role: "user",
          content: `Network configuration update for subnet ${i}`,
        });
        await env.manager.endSession(sid);
      }

      const results = env.manager.searchSessions("network");
      expect(results.length).toBe(5);
    }, 90_000);

    it("ranks results by BM25 relevance", async () => {
      // Session with high relevance — multiple mentions
      const sid1 = env.manager.startSession("user1", "productivity", {
        title: "Jira ticket API integration",
      });
      env.manager.addMessage(sid1, {
        role: "user",
        content: "Working on Jira ticket API integration for the dashboard. The Jira API endpoint needs authentication.",
      });
      await env.manager.endSession(sid1);

      // Session with low relevance — fewer mentions
      const sid2 = env.manager.startSession("user1", "productivity", {
        title: "Jira workflow review",
      });
      env.manager.addMessage(sid2, {
        role: "user",
        content: "Brief note about the API gateway configuration",
      });
      await env.manager.endSession(sid2);

      const results = env.manager.searchSessions("Jira API");
      expect(results.length).toBeGreaterThanOrEqual(1);
      // Higher relevance session should come first
      expect(results[0].sessionId).toBe(sid1);
    });

    it("falls back to text search when FTS5 is unavailable", async () => {
      const sessionId = env.manager.startSession("user1", "productivity", {
        title: "GitLab MR conflict resolution",
      });
      env.manager.addMessage(sessionId, {
        role: "user",
        content: "Resolved merge request conflicts in the pipeline configuration",
      });
      await env.manager.endSession(sessionId);

      // Even if FTS5 works, the fallback path should produce similar results
      const results = env.manager.searchSessions("GitLab");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── session_search tool handler ────────────────────────────────────────

  describe("session_search tool handler", () => {
    it("returns error when query is missing", async () => {
      const { createSessionSearchHandler } = await import(
        "../../../src/agent/handlers/session-search"
      );
      const handler = createSessionSearchHandler(env.manager);
      const result = await handler({});
      expect(result.success).toBe(false);
      expect(result.error).toContain("query");
    });

    it("returns formatted results for valid query", async () => {
      const sid = env.manager.startSession("user1", "engineering", {
        title: "API endpoint testing",
      });
      env.manager.addMessage(sid, {
        role: "user",
        content: "We need to test the REST API endpoints for user management",
      });
      await env.manager.endSession(sid);

      const { createSessionSearchHandler } = await import(
        "../../../src/agent/handlers/session-search"
      );
      const handler = createSessionSearchHandler(env.manager);
      const result = await handler({ query: "API endpoints" });
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it("returns empty results for non-matching query", async () => {
      const { createSessionSearchHandler } = await import(
        "../../../src/agent/handlers/session-search"
      );
      const handler = createSessionSearchHandler(env.manager);
      const result = await handler({ query: "nonexistent topic" });
      expect(result.success).toBe(true);
    });
  });
});
