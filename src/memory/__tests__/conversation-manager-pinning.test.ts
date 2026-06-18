import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../agent/opencode-client", () => ({
  aiClient: {
    chat: vi.fn().mockResolvedValue({ content: "Test title", model: "test", done: true }),
  },
}));

describe("ConversationManager pinning helpers", () => {
  let originalCwd: string;
  let tempDir: string;
  let manager: InstanceType<typeof import("../conversation-manager").ConversationManager> | null = null;

  beforeEach(() => {
    vi.resetModules();
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-pinning-"));
    process.chdir(tempDir);
    manager = null;
  });

  afterEach(() => {
    if (manager) {
      manager.close();
      manager = null;
    }
    process.chdir(originalCwd);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // SQLite WAL files may be briefly locked on Windows; best-effort cleanup
    }
  });

  describe("getUserDirectives", () => {
    it("filters trivial acknowledgements (continue/yes/ok/k)", async () => {
      const { ConversationManager } = await import("../conversation-manager.js");
      manager = new ConversationManager();
      const sessionId = manager.startSession("u", "productivity");

      manager.addMessage(sessionId, { role: "user", content: "search the logs for IP 10.0.0.1 within the last 24 hours" });
      manager.addMessage(sessionId, { role: "assistant", content: "ok" });
      manager.addMessage(sessionId, { role: "user", content: "continue" });
      manager.addMessage(sessionId, { role: "user", content: "yes" });
      manager.addMessage(sessionId, { role: "user", content: "keep going" });
      manager.addMessage(sessionId, { role: "user", content: "ok" });
      manager.addMessage(sessionId, { role: "user", content: "use the payload field when the named field does not exist" });

      const directives = manager.getUserDirectives(sessionId);
      expect(directives).toHaveLength(2);
      expect(directives[0].content).toContain("IP 10.0.0.1");
      expect(directives[1].content).toContain("use the payload field");
    });

    it("deduplicates near-identical directives, keeping the most recent", async () => {
      const { ConversationManager } = await import("../conversation-manager.js");
      manager = new ConversationManager();
      const sessionId = manager.startSession("u", "productivity");

      // The dedup uses Jaccard on word-bigrams ≥ 0.55, which catches near-exact
      // restatements (typical of users re-pasting their own correction) but
      // not free-form paraphrases (those need semantic similarity).
      const dup1 = "use the payload field when the named field is not found";
      const dup2 = "use the payload field when the named field is not found again";
      const dup3 = "please use the payload field when the named field is not found";
      const unique = "the time must be MDT not MST in June";

      manager.addMessage(sessionId, { role: "user", content: dup1 });
      manager.addMessage(sessionId, { role: "assistant", content: "got it" });
      manager.addMessage(sessionId, { role: "user", content: dup2 });
      manager.addMessage(sessionId, { role: "assistant", content: "ok" });
      manager.addMessage(sessionId, { role: "user", content: unique });
      manager.addMessage(sessionId, { role: "assistant", content: "thanks" });
      manager.addMessage(sessionId, { role: "user", content: dup3 });

      const directives = manager.getUserDirectives(sessionId);
      const payloadDirectives = directives.filter((d) => d.content.toLowerCase().includes("payload"));
      expect(payloadDirectives).toHaveLength(1);
      expect(payloadDirectives[0].content).toBe(dup3);
      expect(directives.some((d) => d.content.includes("MDT"))).toBe(true);
    });

    it("respects char budget by evicting oldest first", async () => {
      const { ConversationManager } = await import("../conversation-manager.js");
      manager = new ConversationManager();
      const sessionId = manager.startSession("u", "productivity");

      // 10 directives of ~100 chars each; budget=300 should keep ~2-3 most recent.
      for (let i = 0; i < 10; i++) {
        manager.addMessage(sessionId, {
          role: "user",
          content: `directive number ${i} ` + "x".repeat(80) + ` unique-${i}`,
        });
        manager.addMessage(sessionId, { role: "assistant", content: "ok" });
      }

      const directives = manager.getUserDirectives(sessionId, { charBudget: 300 });
      expect(directives.length).toBeLessThan(5);
      expect(directives.length).toBeGreaterThanOrEqual(1);
      // Most recent should be retained.
      expect(directives[directives.length - 1].content).toContain("unique-9");
    });
  });

  describe("getLocationFacts", () => {
    it("extracts timezone abbreviations", async () => {
      const { ConversationManager } = await import("../conversation-manager.js");
      manager = new ConversationManager();
      const sessionId = manager.startSession("u", "productivity");

      manager.addMessage(sessionId, { role: "user", content: "hello, search the logs" });
      manager.addMessage(sessionId, { role: "user", content: "the time should be CDT" });
      manager.addMessage(sessionId, { role: "user", content: "actually use MDT for the customer" });

      const facts = manager.getLocationFacts(sessionId);
      expect(facts.length).toBeGreaterThanOrEqual(2);
      expect(facts.some((f) => f.content.includes("CDT"))).toBe(true);
      expect(facts.some((f) => f.content.includes("MDT"))).toBe(true);
    });

    it("extracts city/state names", async () => {
      const { ConversationManager } = await import("../conversation-manager.js");
      manager = new ConversationManager();
      const sessionId = manager.startSession("u", "productivity");

      manager.addMessage(sessionId, {
        role: "user",
        content: "the user is in El Paso TX so use mountain time",
      });
      manager.addMessage(sessionId, { role: "user", content: "we have offices in Houston Texas as well" });

      const facts = manager.getLocationFacts(sessionId);
      expect(facts.length).toBeGreaterThanOrEqual(1);
      expect(facts.some((f) => f.content.includes("El Paso"))).toBe(true);
    });

    it("returns empty when no location/timezone mentions", async () => {
      const { ConversationManager } = await import("../conversation-manager.js");
      manager = new ConversationManager();
      const sessionId = manager.startSession("u", "productivity");

      manager.addMessage(sessionId, { role: "user", content: "search the logs for IP 10.0.0.1" });
      manager.addMessage(sessionId, { role: "user", content: "what fields are available" });

      expect(manager.getLocationFacts(sessionId)).toEqual([]);
    });
  });

  describe("getInferredTimezone", () => {
    it("returns most recent user-stated timezone", async () => {
      const { ConversationManager } = await import("../conversation-manager.js");
      manager = new ConversationManager();
      const sessionId = manager.startSession("u", "productivity");

      manager.addMessage(sessionId, { role: "user", content: "use EST" });
      manager.addMessage(sessionId, { role: "user", content: "actually use CDT" });

      const tz = manager.getInferredTimezone(sessionId);
      // Most-recent should win (CDT during DST months).
      expect(tz).not.toBeNull();
      if (tz) {
        expect(["CDT", "CST"]).toContain(tz.label);
      }
    });

    it("infers MDT from El Paso during DST months", async () => {
      const { ConversationManager } = await import("../conversation-manager.js");
      manager = new ConversationManager();
      const sessionId = manager.startSession("u", "productivity");
      manager.addMessage(sessionId, { role: "user", content: "the customer is in El Paso" });

      const tz = manager.getInferredTimezone(sessionId);
      expect(tz).not.toBeNull();
      // March-November returns DST variant per heuristic.
      const month = new Date().getUTCMonth();
      const inDst = month >= 2 && month <= 10;
      if (tz) {
        expect(tz.label).toBe(inDst ? "MDT" : "MST");
        expect(tz.offsetMinutes).toBe(inDst ? -360 : -420);
      }
    });

    it("returns null when nothing is stated", async () => {
      const { ConversationManager } = await import("../conversation-manager.js");
      manager = new ConversationManager();
      const sessionId = manager.startSession("u", "productivity");
      manager.addMessage(sessionId, { role: "user", content: "look at the logs" });
      expect(manager.getInferredTimezone(sessionId)).toBeNull();
    });
  });

  describe("getEstablishedFacts", () => {
    it("extracts assistant claims that the user confirmed", async () => {
      const { ConversationManager } = await import("../conversation-manager.js");
      manager = new ConversationManager();
      const sessionId = manager.startSession("u", "productivity");

      manager.addMessage(sessionId, { role: "user", content: "what is the malicious IP" });
      manager.addMessage(sessionId, {
        role: "assistant",
        content: "The malicious IP is 2603:8080:9c00:27e4::1 originating from Charter Communications in El Paso. It first appeared at 14:24:37 UTC.",
      });
      manager.addMessage(sessionId, { role: "user", content: "Yes, that is correct." });

      const facts = manager.getEstablishedFacts(sessionId);
      expect(facts).toHaveLength(1);
      expect(facts[0].content).toMatch(/(Charter Communications|2603:8080|14:24:37)/);
    });

    it("ignores user messages that are not confirmations", async () => {
      const { ConversationManager } = await import("../conversation-manager.js");
      manager = new ConversationManager();
      const sessionId = manager.startSession("u", "productivity");

      manager.addMessage(sessionId, { role: "assistant", content: "The token was created at 14:10:45 UTC." });
      manager.addMessage(sessionId, { role: "user", content: "but the time should be MDT not UTC" });

      expect(manager.getEstablishedFacts(sessionId)).toEqual([]);
    });

    it("handles multiple confirmations across the session", async () => {
      const { ConversationManager } = await import("../conversation-manager.js");
      manager = new ConversationManager();
      const sessionId = manager.startSession("u", "productivity");

      manager.addMessage(sessionId, { role: "assistant", content: "Finding A: the bearer token o89vXTR860G6 was issued at 14:10:45 UTC." });
      manager.addMessage(sessionId, { role: "user", content: "yes confirmed" });
      manager.addMessage(sessionId, { role: "assistant", content: "Finding B: the device id is NBJ42D2H4 per the audit log." });
      manager.addMessage(sessionId, { role: "user", content: "exactly right" });

      const facts = manager.getEstablishedFacts(sessionId);
      expect(facts).toHaveLength(2);
      expect(facts[0].content).toMatch(/o89vXTR860G6|14:10:45/);
      expect(facts[1].content).toMatch(/NBJ42D2H4/);
    });
  });

  describe("healToolMessages", () => {
    it("rewrites tool message content by tool_call_id and persists to disk", async () => {
      const { ConversationManager } = await import("../conversation-manager.js");
      manager = new ConversationManager();
      const sessionId = manager.startSession("u", "productivity");

      manager.addMessage(sessionId, { role: "user", content: "fetch logs" });
      manager.addMessage(sessionId, {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc-1", name: "hawk_ir.search_logs", params: {} }],
      });
      manager.addMessage(sessionId, {
        role: "tool",
        content: "{\"truncated\":true}\n...[old shape]",
        name: "hawk_ir.search_logs",
        tool_call_id: "tc-1",
      });

      const heals = new Map<string, string>();
      heals.set("tc-1", "{\"_cached_from_ref\":\"tc-1\",\"_salvaged_from_truncated\":true,\"data\":[{\"hit\":1}]}");
      const healed = manager.healToolMessages(sessionId, heals);

      expect(healed).toBe(1);
      const session = manager.getSession(sessionId)!;
      const toolMsg = session.messages.find((m) => m.tool_call_id === "tc-1");
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toContain("_salvaged_from_truncated");

      // Verify on-disk persistence: a fresh ConversationManager should load
      // the healed content.
      manager.close();
      const { ConversationManager: ConversationManager2 } = await import("../conversation-manager.js");
      const m2 = new ConversationManager2();
      try {
        const reloaded = m2.getSession(sessionId);
        expect(reloaded).toBeDefined();
        const reloadedToolMsg = reloaded!.messages.find((m) => m.tool_call_id === "tc-1");
        expect(reloadedToolMsg!.content).toContain("_salvaged_from_truncated");
      } finally {
        m2.close();
      }
      manager = null; // already closed
    });

    it("returns 0 and is a no-op when no tool_call_id matches", async () => {
      const { ConversationManager } = await import("../conversation-manager.js");
      manager = new ConversationManager();
      const sessionId = manager.startSession("u", "productivity");
      manager.addMessage(sessionId, { role: "user", content: "hello" });

      const heals = new Map<string, string>();
      heals.set("tc-does-not-exist", "anything");
      expect(manager.healToolMessages(sessionId, heals)).toBe(0);
    });

    it("strips <think> blocks and stray closing tags from assistant content", async () => {
      const { ConversationManager } = await import("../conversation-manager.js");
      manager = new ConversationManager();
      const sessionId = manager.startSession("u", "productivity");

      manager.addMessage(sessionId, {
        role: "assistant",
        content: "<think>internal reasoning</think>Here is the actual answer.",
      });
      manager.addMessage(sessionId, {
        role: "assistant",
        content: "Let me think more.</think>And this is the conclusion.",
      });

      const session = manager.getSession(sessionId)!;
      expect(session.messages[0].content).toBe("Here is the actual answer.");
      expect(session.messages[1].content).toBe("Let me think more.And this is the conclusion.");
    });
  });
});
