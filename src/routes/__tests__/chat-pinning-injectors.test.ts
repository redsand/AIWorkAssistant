import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock heavy fastify-route dependencies that chat.ts pulls in. The injectors
// themselves don't touch any of these, so empty stubs keep import time fast
// and tests deterministic.
vi.mock("../../agent/opencode-client", () => ({
  aiClient: {
    chat: vi.fn().mockResolvedValue({ content: "Test title", model: "test", done: true }),
    chatStream: vi.fn(),
    providerName: "test",
    isConfigured: () => true,
    getMaxContextTokens: () => 200_000,
    estimateTokens: () => 0,
    pruneMessages: (m: unknown[]) => m,
  },
}));

describe("chat.ts injectors", () => {
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    vi.resetModules();
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-inject-"));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows-friendly cleanup.
    }
  });

  // Small helper that loads a fresh chat.ts + conversation-manager pair so
  // each test gets a clean session storage backend rooted in tempDir.
  async function setup() {
    const cm = await import("../../memory/conversation-manager.js");
    const chat = await import("../chat.js");
    return { cm, chat };
  }

  describe("injectTimeAnchor", () => {
    it("always inserts a CURRENT TIME system message after existing system msgs", async () => {
      const { chat } = await setup();
      const messages = [
        { role: "system" as const, content: "you are an assistant" },
        { role: "user" as const, content: "hi" },
      ];
      const result = chat.injectTimeAnchor(messages, "no-such-session");

      const pinIdx = result.findIndex((m) => m.content?.startsWith?.(chat.TIME_ANCHOR_MARKER));
      expect(pinIdx).toBe(1); // After system[0], before user
      const pin = result[pinIdx];
      expect(pin.role).toBe("system");
      expect(pin.content).toMatch(/UTC: \d{4}-\d{2}-\d{2}T/);
      expect(pin.content).toMatch(/Day \(UTC\): (Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day/);
    });

    it("includes user-local time when timezone is inferable", async () => {
      const { cm, chat } = await setup();
      const mgr = new cm.ConversationManager();
      const sessionId = mgr.startSession("u", "productivity");
      mgr.addMessage(sessionId, { role: "user", content: "the customer is in El Paso TX" });

      const result = chat.injectTimeAnchor([{ role: "user" as const, content: "x" }], sessionId);
      const pin = result.find((m) => m.content?.startsWith?.(chat.TIME_ANCHOR_MARKER));
      expect(pin).toBeDefined();
      expect(pin!.content).toMatch(/User local: \d{4}-\d{2}-\d{2}/);
      expect(pin!.content).toMatch(/M[SD]T/); // El Paso = Mountain time
      mgr.close();
    });

    it("strips any prior CURRENT TIME pin before adding a fresh one", async () => {
      const { chat } = await setup();
      const messages = [
        { role: "system" as const, content: "you are an assistant" },
        { role: "system" as const, content: `${chat.TIME_ANCHOR_MARKER}\nstale data` },
        { role: "user" as const, content: "hi" },
      ];
      const result = chat.injectTimeAnchor(messages, null);
      const timePins = result.filter((m) => m.content?.startsWith?.(chat.TIME_ANCHOR_MARKER));
      expect(timePins).toHaveLength(1);
      expect(timePins[0].content).not.toContain("stale data");
    });
  });

  describe("injectUserDirectives", () => {
    it("emits a pin containing every non-trivial user message", async () => {
      const { cm, chat } = await setup();
      const mgr = new cm.ConversationManager();
      const sessionId = mgr.startSession("u", "productivity");
      mgr.addMessage(sessionId, { role: "user", content: "search for IP 10.0.0.1 within last 24 hours" });
      mgr.addMessage(sessionId, { role: "user", content: "continue" });
      mgr.addMessage(sessionId, { role: "user", content: "use the payload field when name is unknown" });

      const result = chat.injectUserDirectives(
        [{ role: "system" as const, content: "be helpful" }, { role: "user" as const, content: "x" }],
        sessionId,
      );
      const pin = result.find((m) => m.content?.startsWith?.(chat.USER_DIRECTIVES_MARKER));
      expect(pin).toBeDefined();
      expect(pin!.content).toContain("IP 10.0.0.1");
      expect(pin!.content).toContain("payload field");
      expect(pin!.content).not.toContain("continue");
      mgr.close();
    });

    it("is a no-op when the session has no non-trivial directives", async () => {
      const { cm, chat } = await setup();
      const mgr = new cm.ConversationManager();
      const sessionId = mgr.startSession("u", "productivity");
      mgr.addMessage(sessionId, { role: "user", content: "continue" });

      const original = [{ role: "user" as const, content: "x" }];
      const result = chat.injectUserDirectives(original, sessionId);
      expect(result.some((m) => m.content?.startsWith?.(chat.USER_DIRECTIVES_MARKER))).toBe(false);
      mgr.close();
    });
  });

  describe("injectEvidenceDiscipline", () => {
    it("fires when the most recent user message asks for a report", async () => {
      const { cm, chat } = await setup();
      const mgr = new cm.ConversationManager();
      const sessionId = mgr.startSession("u", "productivity");
      mgr.addMessage(sessionId, { role: "user", content: "give me a comprehensive report on the incident" });

      const result = chat.injectEvidenceDiscipline([{ role: "user" as const, content: "x" }], sessionId);
      const pin = result.find((m) => m.content?.startsWith?.(chat.EVIDENCE_DISCIPLINE_MARKER));
      expect(pin).toBeDefined();
      expect(pin!.content).toMatch(/UNVERIFIED/);
      expect(pin!.content).toMatch(/tc-xxx/);
      mgr.close();
    });

    it("does NOT fire on normal investigative messages", async () => {
      const { cm, chat } = await setup();
      const mgr = new cm.ConversationManager();
      const sessionId = mgr.startSession("u", "productivity");
      mgr.addMessage(sessionId, { role: "user", content: "search for the malicious IP in the logs" });

      const result = chat.injectEvidenceDiscipline([{ role: "user" as const, content: "x" }], sessionId);
      expect(result.some((m) => m.content?.startsWith?.(chat.EVIDENCE_DISCIPLINE_MARKER))).toBe(false);
      mgr.close();
    });

    it("fires on 'summarize' / 'walk through' / 'timeline' intents", async () => {
      const { cm, chat } = await setup();
      const mgr = new cm.ConversationManager();
      const sessionId = mgr.startSession("u", "productivity");

      for (const intent of [
        "summarize what you found",
        "can you write up the findings",
        "give me a timeline report",
        "walk through the events",
      ]) {
        mgr.addMessage(sessionId, { role: "user", content: intent });
        const result = chat.injectEvidenceDiscipline([{ role: "user" as const, content: "x" }], sessionId);
        const pin = result.find((m) => m.content?.startsWith?.(chat.EVIDENCE_DISCIPLINE_MARKER));
        expect(pin, `intent="${intent}"`).toBeDefined();
      }
      mgr.close();
    });
  });

  describe("injectEstablishedFacts", () => {
    it("pins assistant claims that the user confirmed", async () => {
      const { cm, chat } = await setup();
      const mgr = new cm.ConversationManager();
      const sessionId = mgr.startSession("u", "productivity");
      mgr.addMessage(sessionId, { role: "user", content: "what is the source IP" });
      mgr.addMessage(sessionId, {
        role: "assistant",
        content: "The malicious IP is 2603:8080::1 from Charter Communications.",
      });
      mgr.addMessage(sessionId, { role: "user", content: "yes that is correct" });

      const result = chat.injectEstablishedFacts(
        [{ role: "system" as const, content: "be helpful" }, { role: "user" as const, content: "x" }],
        sessionId,
      );
      const pin = result.find((m) => m.content?.startsWith?.(chat.ESTABLISHED_FACTS_MARKER));
      expect(pin).toBeDefined();
      expect(pin!.content).toMatch(/2603:8080|Charter/);
      mgr.close();
    });
  });

  describe("injectUserLocation", () => {
    it("pins user-stated timezone/location facts", async () => {
      const { cm, chat } = await setup();
      const mgr = new cm.ConversationManager();
      const sessionId = mgr.startSession("u", "productivity");
      mgr.addMessage(sessionId, { role: "user", content: "the customer is in El Paso TX" });
      mgr.addMessage(sessionId, { role: "user", content: "the timezone should be MDT" });

      const result = chat.injectUserLocation([{ role: "user" as const, content: "x" }], sessionId);
      const pin = result.find((m) => m.content?.startsWith?.(chat.USER_LOCATION_MARKER));
      expect(pin).toBeDefined();
      expect(pin!.content).toContain("El Paso");
      expect(pin!.content).toContain("MDT");
      mgr.close();
    });
  });

  describe("ordering across multiple injectors", () => {
    it("places all pins after original system, before first non-system", async () => {
      const { cm, chat } = await setup();
      const mgr = new cm.ConversationManager();
      const sessionId = mgr.startSession("u", "productivity");
      mgr.addMessage(sessionId, { role: "user", content: "the customer is in El Paso TX" });
      mgr.addMessage(sessionId, { role: "user", content: "use the payload field when name not found" });
      mgr.addMessage(sessionId, {
        role: "assistant",
        content: "The malicious IP is 2603:8080::1 from Charter.",
      });
      mgr.addMessage(sessionId, { role: "user", content: "yes confirmed" });
      // Last message is the report-intent so evidence discipline fires.
      mgr.addMessage(sessionId, { role: "user", content: "write a comprehensive report of findings" });

      let messages: { role: string; content: string }[] = [
        { role: "system", content: "original prompt" },
        { role: "user", content: "next turn" },
      ];

      // Apply the injectors in the same order as the chat route does.
      messages = chat.injectUserDirectives(messages as any, sessionId) as any;
      messages = chat.injectEstablishedFacts(messages as any, sessionId) as any;
      messages = chat.injectEvidenceDiscipline(messages as any, sessionId) as any;
      messages = chat.injectUserLocation(messages as any, sessionId) as any;
      messages = chat.injectTimeAnchor(messages as any, sessionId) as any;

      // System[0] unchanged, all 5 pins follow, then user
      expect(messages[0].content).toBe("original prompt");
      const lastIdx = messages.length - 1;
      expect(messages[lastIdx].role).toBe("user");

      const pinMarkers = [
        chat.TIME_ANCHOR_MARKER,
        chat.USER_LOCATION_MARKER,
        chat.EVIDENCE_DISCIPLINE_MARKER,
        chat.ESTABLISHED_FACTS_MARKER,
        chat.USER_DIRECTIVES_MARKER,
      ];
      for (const marker of pinMarkers) {
        const idx = messages.findIndex((m) => m.content?.startsWith?.(marker));
        expect(idx, `marker ${marker}`).toBeGreaterThan(0);
        expect(idx, `marker ${marker} before user`).toBeLessThan(lastIdx);
      }
      mgr.close();
    });
  });
});
