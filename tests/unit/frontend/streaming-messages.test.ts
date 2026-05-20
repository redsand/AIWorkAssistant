// @vitest-environment happy-dom

import { describe, it, expect, beforeEach } from "vitest";

// Reimplemented streaming message logic for isolated DOM testing.
// Follows the pattern established in tests/unit/frontend/auto-scroll.test.ts.

function createMessageController() {
  const messagesDiv = document.createElement("div");
  messagesDiv.id = "chatMessages";
  document.body.appendChild(messagesDiv);

  let currentStreamingMessageId: string | null = null;
  let counter = 0;

  function renderMarkdown(content: string): string {
    return `<p>${content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`;
  }

  function addMessage(
    content: string,
    type: string,
    thinking?: string | null,
    options: { scroll?: boolean; messageId?: string | null } = {},
  ): string {
    const { messageId = null } = options;

    if (messageId) {
      const existing = document.getElementById(messageId);
      if (existing) {
        const bubble = existing.querySelector(".message-bubble");
        if (bubble) {
          let contentEl = bubble.querySelector(".message-content") as HTMLElement | null;
          if (!contentEl) {
            contentEl = document.createElement("div");
            contentEl.className = "message-content";
            bubble.appendChild(contentEl);
          }
          contentEl.innerHTML = renderMarkdown(content);
        }
        return messageId;
      }
    }

    const id = `msg-${++counter}`;
    const messageDiv = document.createElement("div");
    messageDiv.id = id;
    messageDiv.className = `message ${type}`;

    const row = document.createElement("div");
    row.className = "message-row";

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";

    if (type === "assistant") {
      if (thinking && thinking.trim()) {
        const thinkingDiv = document.createElement("div");
        thinkingDiv.className = "thinking-section";
        thinkingDiv.textContent = thinking;
        bubble.appendChild(thinkingDiv);
      }
      const contentEl = document.createElement("div");
      contentEl.className = "message-content";
      contentEl.innerHTML = renderMarkdown(content);
      bubble.appendChild(contentEl);
    } else {
      bubble.textContent = content;
    }

    row.appendChild(bubble);
    messageDiv.appendChild(row);
    messagesDiv.appendChild(messageDiv);

    return id;
  }

  function setCurrentStreamingMessageId(id: string | null) {
    currentStreamingMessageId = id;
  }

  function getCurrentStreamingMessageId() {
    return currentStreamingMessageId;
  }

  function markStreamingMessageInterrupted() {
    if (!currentStreamingMessageId) return;
    const el = document.getElementById(currentStreamingMessageId);
    if (el) {
      const bubble = el.querySelector(".message-bubble");
      if (bubble) {
        const marker = document.createElement("div");
        marker.className = "interrupted-marker";
        marker.textContent = "Interrupted";
        bubble.appendChild(marker);
      }
    }
    currentStreamingMessageId = null;
  }

  function simulateStream(chunks: string[], thinking?: string): string | null {
    let streamingId: string | null = null;
    let accumulated = "";

    for (let i = 0; i < chunks.length; i++) {
      accumulated += chunks[i];
      if (streamingId === null) {
        streamingId = addMessage(accumulated, "assistant", i === 0 ? thinking : null);
        setCurrentStreamingMessageId(streamingId);
      } else {
        addMessage(accumulated, "assistant", null, { messageId: streamingId });
      }
    }

    if (streamingId) {
      setCurrentStreamingMessageId(null);
    }

    return streamingId;
  }

  return {
    addMessage,
    setCurrentStreamingMessageId,
    getCurrentStreamingMessageId,
    markStreamingMessageInterrupted,
    simulateStream,
    getMessagesDiv: () => messagesDiv,
  };
}

describe("streaming messages", () => {
  let ctrl: ReturnType<typeof createMessageController>;

  beforeEach(() => {
    document.body.innerHTML = "";
    ctrl = createMessageController();
  });

  describe("addMessage — new message creation", () => {
    it("creates a message element and returns a non-empty ID", () => {
      const id = ctrl.addMessage("Hello", "assistant");
      expect(id).toBeTruthy();
      expect(document.getElementById(id)).not.toBeNull();
    });

    it("returns a unique ID for every new message", () => {
      const id1 = ctrl.addMessage("First", "assistant");
      const id2 = ctrl.addMessage("Second", "assistant");
      expect(id1).not.toBe(id2);
    });

    it("assigns both 'message' and type classes to the element", () => {
      const id = ctrl.addMessage("Hello", "assistant");
      const el = document.getElementById(id)!;
      expect(el.classList.contains("message")).toBe(true);
      expect(el.classList.contains("assistant")).toBe(true);
    });

    it("wraps assistant content in .message-content for targeted updates", () => {
      const id = ctrl.addMessage("Hello", "assistant");
      const el = document.getElementById(id)!;
      expect(el.querySelector(".message-content")).not.toBeNull();
    });

    it("includes a .thinking-section when thinking text is provided", () => {
      const id = ctrl.addMessage("Hello", "assistant", "Deliberating…");
      expect(document.getElementById(id)!.querySelector(".thinking-section")).not.toBeNull();
    });

    it("omits the .thinking-section when no thinking text is given", () => {
      const id = ctrl.addMessage("Hello", "assistant");
      expect(document.getElementById(id)!.querySelector(".thinking-section")).toBeNull();
    });

    it("sets user message text directly on the bubble", () => {
      const id = ctrl.addMessage("User message", "user");
      const bubble = document.getElementById(id)!.querySelector(".message-bubble")!;
      expect(bubble.textContent).toBe("User message");
    });

    it("appends new message to the chatMessages container", () => {
      const id = ctrl.addMessage("Hi", "assistant");
      expect(ctrl.getMessagesDiv().querySelector(`#${id}`)).not.toBeNull();
    });
  });

  describe("addMessage — update existing message (messageId provided)", () => {
    it("updates .message-content without adding a new element", () => {
      const id = ctrl.addMessage("Initial", "assistant");
      const before = ctrl.getMessagesDiv().querySelectorAll(".message").length;
      ctrl.addMessage("Updated", "assistant", null, { messageId: id });
      expect(ctrl.getMessagesDiv().querySelectorAll(".message").length).toBe(before);
    });

    it("returns the same ID that was passed in", () => {
      const id = ctrl.addMessage("Initial", "assistant");
      const returned = ctrl.addMessage("Updated", "assistant", null, { messageId: id });
      expect(returned).toBe(id);
    });

    it("reflects the new content in .message-content", () => {
      const id = ctrl.addMessage("Initial content", "assistant");
      ctrl.addMessage("Updated content", "assistant", null, { messageId: id });
      const contentEl = document.getElementById(id)!.querySelector(".message-content")!;
      expect(contentEl.innerHTML).toContain("Updated content");
    });

    it("preserves an existing .thinking-section when content is updated", () => {
      const id = ctrl.addMessage("Initial", "assistant", "Deep thought");
      ctrl.addMessage("Updated content", "assistant", null, { messageId: id });
      const el = document.getElementById(id)!;
      expect(el.querySelector(".thinking-section")).not.toBeNull();
      expect(el.querySelector(".message-content")!.innerHTML).toContain("Updated content");
    });

    it("falls back to creating a new element when messageId is not found", () => {
      const before = ctrl.getMessagesDiv().querySelectorAll(".message").length;
      const id = ctrl.addMessage("Content", "assistant", null, { messageId: "nonexistent" });
      expect(ctrl.getMessagesDiv().querySelectorAll(".message").length).toBe(before + 1);
      expect(id).not.toBe("nonexistent");
    });
  });

  describe("streaming accumulation", () => {
    it("produces exactly one message element for multiple chunks", () => {
      ctrl.simulateStream(["Hello", " world", "!"]);
      expect(ctrl.getMessagesDiv().querySelectorAll(".message.assistant").length).toBe(1);
    });

    it("final element content contains all accumulated chunks joined", () => {
      const id = ctrl.simulateStream(["Hello", " world", "!"]);
      const contentEl = document.getElementById(id!)!.querySelector(".message-content")!;
      expect(contentEl.innerHTML).toContain("Hello world!");
    });

    it("returns the streaming message ID", () => {
      const id = ctrl.simulateStream(["chunk1", "chunk2"]);
      expect(id).toBeTruthy();
      expect(document.getElementById(id!)).not.toBeNull();
    });

    it("clears currentStreamingMessageId after the stream completes", () => {
      ctrl.simulateStream(["Hello", " world"]);
      expect(ctrl.getCurrentStreamingMessageId()).toBeNull();
    });

    it("preserves thinking section across all chunks (added on first chunk only)", () => {
      const id = ctrl.simulateStream(["Part 1", " Part 2"], "Thinking hard");
      const el = document.getElementById(id!)!;
      expect(el.querySelector(".thinking-section")).not.toBeNull();
      expect(el.querySelector(".message-content")!.innerHTML).toContain("Part 1 Part 2");
    });

    it("handles a single-chunk stream correctly", () => {
      const id = ctrl.simulateStream(["Only chunk"]);
      const contentEl = document.getElementById(id!)!.querySelector(".message-content")!;
      expect(contentEl.innerHTML).toContain("Only chunk");
      expect(ctrl.getCurrentStreamingMessageId()).toBeNull();
    });
  });

  describe("markStreamingMessageInterrupted", () => {
    it("appends .interrupted-marker to the streaming message bubble", () => {
      const id = ctrl.addMessage("Partial", "assistant");
      ctrl.setCurrentStreamingMessageId(id);
      ctrl.markStreamingMessageInterrupted();
      expect(document.getElementById(id)!.querySelector(".interrupted-marker")).not.toBeNull();
    });

    it("sets the marker text to 'Interrupted'", () => {
      const id = ctrl.addMessage("Partial", "assistant");
      ctrl.setCurrentStreamingMessageId(id);
      ctrl.markStreamingMessageInterrupted();
      const marker = document.getElementById(id)!.querySelector(".interrupted-marker")!;
      expect(marker.textContent).toBe("Interrupted");
    });

    it("clears currentStreamingMessageId after marking", () => {
      const id = ctrl.addMessage("Partial", "assistant");
      ctrl.setCurrentStreamingMessageId(id);
      ctrl.markStreamingMessageInterrupted();
      expect(ctrl.getCurrentStreamingMessageId()).toBeNull();
    });

    it("is a no-op when no streaming message is active", () => {
      expect(() => ctrl.markStreamingMessageInterrupted()).not.toThrow();
      expect(ctrl.getCurrentStreamingMessageId()).toBeNull();
    });

    it("does not add a marker when currentStreamingMessageId is already null", () => {
      ctrl.setCurrentStreamingMessageId(null);
      ctrl.markStreamingMessageInterrupted();
      expect(ctrl.getMessagesDiv().querySelectorAll(".interrupted-marker").length).toBe(0);
    });
  });

  describe("mid-stream abort", () => {
    it("marks the previous partial message interrupted when abort occurs", () => {
      const firstId = ctrl.addMessage("Partial response…", "assistant");
      ctrl.setCurrentStreamingMessageId(firstId);

      ctrl.markStreamingMessageInterrupted();

      expect(document.getElementById(firstId)!.querySelector(".interrupted-marker")).not.toBeNull();
    });

    it("new stream creates a fresh message after aborting the previous stream", () => {
      const firstId = ctrl.addMessage("Partial", "assistant");
      ctrl.setCurrentStreamingMessageId(firstId);
      ctrl.markStreamingMessageInterrupted();

      const secondId = ctrl.simulateStream(["New response"]);

      const messages = ctrl.getMessagesDiv().querySelectorAll(".message.assistant");
      expect(messages.length).toBe(2);
      expect(document.getElementById(firstId)!.querySelector(".interrupted-marker")).not.toBeNull();
      expect(document.getElementById(secondId!)!.querySelector(".interrupted-marker")).toBeNull();
    });

    it("second stream does not inherit the interrupted marker", () => {
      ctrl.addMessage("First partial", "assistant");
      ctrl.setCurrentStreamingMessageId(
        ctrl.getMessagesDiv().querySelector(".message.assistant")!.id,
      );
      ctrl.markStreamingMessageInterrupted();

      const secondId = ctrl.simulateStream(["Clean response"]);
      expect(document.getElementById(secondId!)!.querySelector(".interrupted-marker")).toBeNull();
    });
  });

  describe("history load (non-streaming addMessage calls)", () => {
    it("creates independent messages for each history entry", () => {
      ctrl.addMessage("First history", "assistant");
      ctrl.addMessage("Second history", "assistant");
      expect(ctrl.getMessagesDiv().querySelectorAll(".message.assistant").length).toBe(2);
    });

    it("history messages do not affect currentStreamingMessageId", () => {
      ctrl.addMessage("History entry", "assistant");
      expect(ctrl.getCurrentStreamingMessageId()).toBeNull();
    });
  });
});
