import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../agent/opencode-client", () => ({
  aiClient: {
    chat: vi
      .fn()
      .mockResolvedValue({ content: "Test title", model: "test", done: true }),
  },
}));

describe("ConversationManager.getSessionMessagesForDisplay", () => {
  let originalCwd: string;
  let tempDir: string;
  let manager: InstanceType<
    typeof import("../conversation-manager").ConversationManager
  > | null = null;

  beforeEach(() => {
    vi.resetModules();
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-display-"));
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
      // best-effort cleanup
    }
  });

  it("renders empty-content assistant messages with toolCalls as a placeholder", async () => {
    const { ConversationManager } = await import("../conversation-manager.js");
    manager = new ConversationManager();
    const sessionId = manager.startSession("u", "productivity");

    manager.addMessage(sessionId, { role: "user", content: "find recent jira issues" });
    manager.addMessage(sessionId, {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "jira.search_issues", params: {} }],
    });
    manager.addMessage(sessionId, {
      role: "tool",
      content: JSON.stringify({ ok: true }),
      name: "jira.search_issues",
      tool_call_id: "call_1",
    });
    manager.addMessage(sessionId, { role: "assistant", content: "Found 3 issues." });

    const messages = manager.getSessionMessagesForDisplay(sessionId);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: "user", content: "find recent jira issues" });
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toContain("jira.search_issues");
    expect(messages[1].content).toContain("Called");
    expect(messages[2]).toMatchObject({ role: "assistant", content: "Found 3 issues." });
  });

  it("still drops empty-content assistant messages with no toolCalls", async () => {
    const { ConversationManager } = await import("../conversation-manager.js");
    manager = new ConversationManager();
    const sessionId = manager.startSession("u", "productivity");

    manager.addMessage(sessionId, { role: "user", content: "hi" });
    manager.addMessage(sessionId, { role: "assistant", content: "" });
    manager.addMessage(sessionId, { role: "assistant", content: "Hello!" });

    const messages = manager.getSessionMessagesForDisplay(sessionId);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("hi");
    expect(messages[1].content).toBe("Hello!");
  });

  it("returns [] for unknown sessions", async () => {
    const { ConversationManager } = await import("../conversation-manager.js");
    manager = new ConversationManager();
    expect(manager.getSessionMessagesForDisplay("nope-not-real")).toEqual([]);
  });

  it("combines multiple tool calls in a single placeholder", async () => {
    const { ConversationManager } = await import("../conversation-manager.js");
    manager = new ConversationManager();
    const sessionId = manager.startSession("u", "productivity");

    manager.addMessage(sessionId, { role: "user", content: "do two things" });
    manager.addMessage(sessionId, {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c1", name: "jira.search_issues", params: {} },
        { id: "c2", name: "github.list_issues", params: {} },
      ],
    });

    const messages = manager.getSessionMessagesForDisplay(sessionId);
    const placeholder = messages.find((m) => m.role === "assistant");
    expect(placeholder?.content).toContain("jira.search_issues");
    expect(placeholder?.content).toContain("github.list_issues");
  });
});
