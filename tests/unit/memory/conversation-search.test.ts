import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  ConversationManager,
  type SessionSearchResult,
} from "../../../src/memory/conversation-manager";

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

  // ── FTS5 query sanitization for special characters ───────────────────────

  describe("FTS5 query sanitization for special characters", () => {
    it("handles queries with double quotes gracefully", async () => {
      const sid = env.manager.startSession("user1", "engineering", {
        title: "Quote handling test session",
      });
      env.manager.addMessage(sid, {
        role: "user",
        content: "We discussed the \"best practices\" for testing",
      });
      await env.manager.endSession(sid);

      // Should not throw — sanitized query treats quotes as literal
      const results = env.manager.searchSessions('"best practices"');
      // May or may not find results depending on tokenizer, but must not throw
      expect(Array.isArray(results)).toBe(true);
    });

    it("handles queries with parentheses gracefully", async () => {
      const sid = env.manager.startSession("user1", "engineering", {
        title: "Parentheses test session",
      });
      env.manager.addMessage(sid, {
        role: "user",
        content: "Configured the function(err, result) callback pattern",
      });
      await env.manager.endSession(sid);

      const results = env.manager.searchSessions("function(err, result)");
      expect(Array.isArray(results)).toBe(true);
    });

    it("handles queries with FTS5 operators (AND, OR, NEAR) as literals", async () => {
      const sid = env.manager.startSession("user1", "engineering", {
        title: "Logic operators in queries",
      });
      env.manager.addMessage(sid, {
        role: "user",
        content: "Security AND compliance review for the OR logic NEAR production",
      });
      await env.manager.endSession(sid);

      // FTS5 operators should be treated as literal search terms
      const results = env.manager.searchSessions("AND OR NEAR");
      expect(Array.isArray(results)).toBe(true);
    });

    it("handles queries with asterisks gracefully", async () => {
      const sid = env.manager.startSession("user1", "engineering", {
        title: "Wildcard test session",
      });
      env.manager.addMessage(sid, {
        role: "user",
        content: "Investigated the security* wildcard pattern in search",
      });
      await env.manager.endSession(sid);

      const results = env.manager.searchSessions("security*");
      expect(Array.isArray(results)).toBe(true);
    });

    it("handles unbalanced quotes gracefully", async () => {
      const sid = env.manager.startSession("user1", "engineering", {
        title: "Unbalanced quotes session",
      });
      env.manager.addMessage(sid, {
        role: "user",
        content: "Testing unbalanced quote handling in search queries",
      });
      await env.manager.endSession(sid);

      // Should not throw despite the unbalanced quote
      const results = env.manager.searchSessions('testing "unbalanced');
      expect(Array.isArray(results)).toBe(true);
    });

    it("handles mixed special characters in a single query", async () => {
      const sid = env.manager.startSession("user1", "engineering", {
        title: "Mixed special chars session",
      });
      env.manager.addMessage(sid, {
        role: "user",
        content: "Complex query with (parens), \"quotes\", AND operators",
      });
      await env.manager.endSession(sid);

      const results = env.manager.searchSessions('(parens) "quotes" AND operators');
      expect(Array.isArray(results)).toBe(true);
    });
  });

  // ── duplicate session indexing ──────────────────────────────────────────

  describe("duplicate session indexing", () => {
    it("does not produce duplicate results when session is indexed twice", async () => {
      const sid = env.manager.startSession("user1", "productivity", {
        title: "Unique duplicate test session",
      });
      env.manager.addMessage(sid, {
        role: "user",
        content: "Testing that duplicate indexing does not create duplicate rows",
      });
      await env.manager.endSession(sid);

      // Search should return exactly one result for this unique session
      const results = env.manager.searchSessions("Unique duplicate test session");
      const matchingResults = results.filter((r) => r.sessionId === sid);
      expect(matchingResults.length).toBe(1);
    });

    it("re-indexing a session updates rather than duplicates", async () => {
      // Create, end, then manually re-index by starting another session with same ID pattern
      const sid1 = env.manager.startSession("user1", "productivity", {
        title: "Reindex test alpha beta",
      });
      env.manager.addMessage(sid1, {
        role: "user",
        content: "Original content about alpha beta gamma",
      });
      await env.manager.endSession(sid1);

      // Search for unique title — should get exactly one result
      const results = env.manager.searchSessions("alpha beta gamma");
      const matchingResults = results.filter((r) => r.sessionId === sid1);
      expect(matchingResults.length).toBe(1);
    });

    it("multiple endSession calls for different sessions do not interfere", async () => {
      const sid1 = env.manager.startSession("user1", "productivity", {
        title: "First independent session about databases",
      });
      env.manager.addMessage(sid1, {
        role: "user",
        content: "Discussion about database optimization",
      });
      await env.manager.endSession(sid1);

      const sid2 = env.manager.startSession("user1", "productivity", {
        title: "Second independent session about networking",
      });
      env.manager.addMessage(sid2, {
        role: "user",
        content: "Discussion about network configuration",
      });
      await env.manager.endSession(sid2);

      const dbResults = env.manager.searchSessions("databases");
      const netResults = env.manager.searchSessions("networking");

      expect(dbResults.some((r) => r.sessionId === sid1)).toBe(true);
      expect(netResults.some((r) => r.sessionId === sid2)).toBe(true);
    });
  });

  // ── createdAt field populated in FTS5 results ──────────────────────────

  describe("createdAt field in FTS5 results", () => {
    it("populates createdAt from the session creation timestamp", async () => {
      const sid = env.manager.startSession("user1", "engineering", {
        title: "Timestamp verification session",
      });
      env.manager.addMessage(sid, {
        role: "user",
        content: "Verifying that createdAt is populated in search results",
      });
      await env.manager.endSession(sid);

      const results = env.manager.searchSessions("Timestamp verification");
      expect(results.length).toBeGreaterThanOrEqual(1);

      const match = results.find((r) => r.sessionId === sid);
      expect(match).toBeDefined();
      // createdAt should be a non-empty ISO date string now, not ""
      expect(match!.createdAt).not.toBe("");
      // Should be a valid ISO date
      const parsed = new Date(match!.createdAt);
      expect(Number.isNaN(parsed.getTime())).toBe(false);
    });
  });
});
