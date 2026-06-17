import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../agent/opencode-client", () => ({
  aiClient: {
    chat: vi.fn().mockResolvedValue({ content: "Test title", model: "test", done: true }),
  },
}));

describe("ConversationManager context messages", () => {
  let originalCwd: string;
  let tempDir: string;
  let manager: InstanceType<typeof import("../conversation-manager").ConversationManager> | null = null;

  beforeEach(() => {
    vi.resetModules();
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-manager-context-"));
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

  it("compacts long engine-mode sessions before returning context", async () => {
    const { ConversationManager } = await import("../conversation-manager.js");
    manager = new ConversationManager();
    const sessionId = manager.startSession("user-1", "productivity");

    for (let i = 0; i < 45; i++) {
      manager.addMessage(sessionId, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i} about Tenable report host-${i}`,
      });
    }

    const messages = await manager.getSessionMessages(sessionId, true, "engine");

    // 45 messages → 15 old summarized + 30 recent = 31 total (1 summary + 30 recent).
    // MIN_RECENT_MESSAGES was raised from 20 to 30 to take advantage of
    // larger model context windows (kimi-k2.6:cloud, GLM-5.1).
    expect(messages.length).toBe(31);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Fallback summary");
    expect(messages.at(-1)?.content).toContain("message 44");

    const summaryPath = path.join(tempDir, "data", "profiles", "default", "memories", "sessions", `${sessionId}.summary.md`);
    expect(fs.existsSync(summaryPath)).toBe(true);
    // Old-message slice is now 45 - 30 = 15.
    expect(fs.readFileSync(summaryPath, "utf-8")).toContain("**Messages:** 15");
  });

  it("refreshes active summaries when the compacted message window advances", async () => {
    const { ConversationManager } = await import("../conversation-manager.js");
    manager = new ConversationManager();
    const sessionId = manager.startSession("user-1", "productivity");

    for (let i = 0; i < 45; i++) {
      manager.addMessage(sessionId, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i} about Jira ticket OPS-${i}`,
      });
    }

    await manager.getSessionMessages(sessionId, true, "engine");
    // Add enough messages to exceed RESUMMARY_THRESHOLD (15) and trigger a refresh.
    for (let i = 45; i < 61; i++) {
      manager.addMessage(sessionId, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i} follow-up`,
      });
    }
    await manager.getSessionMessages(sessionId, true, "engine");

    const summaryPath = path.join(tempDir, "data", "profiles", "default", "memories", "sessions", `${sessionId}.summary.md`);
    // 61 messages → 31 old summarized + 30 recent; summary messageCount = 31
    // (MIN_RECENT_MESSAGES is 30, not 20).
    expect(fs.readFileSync(summaryPath, "utf-8")).toContain("**Messages:** 31");
  });

  it("truncates large tool results in context without mutating stored session history", async () => {
    const { ConversationManager } = await import("../conversation-manager.js");
    manager = new ConversationManager();
    const sessionId = manager.startSession("user-1", "productivity");
    const largeToolResult = JSON.stringify({
      success: true,
      data: "x".repeat(20_000),
    });

    manager.addMessage(sessionId, {
      role: "tool",
      content: largeToolResult,
      tool_call_id: "tool-1",
    });

    const messages = await manager.getSessionMessages(sessionId, true, "engine");
    const session = manager.getSession(sessionId);

    // Tool-result cap was raised from 12K to 50K to fit larger models'
    // contexts (kimi-k2.6:cloud, ~120k token limit). 20K input passes
    // through uncapped now; truncation only kicks in above 50K.
    expect(messages[0].content.length).toBeLessThan(50_000);
    expect(session?.messages[0].content.length).toBe(largeToolResult.length);
  });
});
