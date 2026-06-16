/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  token: "test-token",
  sessionId: "session-usage",
}));

vi.mock("../js/state.js", () => ({
  API_BASE: "/api",
  currentMode: "productivity",
  get currentSessionId() {
    return authState.sessionId;
  },
  setCurrentSessionId: vi.fn((id) => {
    authState.sessionId = id;
  }),
  messageHistory: [],
  historyIndex: -1,
  draftBeforeHistory: "",
  activeStreamController: null,
  sendGeneration: 0,
  setHistoryIndex: vi.fn(),
  setDraftBeforeHistory: vi.fn(),
  setMessageHistory: vi.fn(),
  setActiveStreamController: vi.fn(),
  updateSessionHash: vi.fn(),
  nextSendGeneration: vi.fn(() => 1),
  readSessionHash: vi.fn(),
  setCurrentMode: vi.fn(),
  authToken: authState.token,
  setAuthToken: vi.fn((token) => {
    authState.token = token;
  }),
}));

vi.mock("../js/utils.js", () => ({
  autoResizeTextarea: vi.fn(),
}));

vi.mock("../js/messages.js", () => ({
  addMessage: vi.fn(),
  createToolProgress: vi.fn(() => ({
    progressEl: document.createElement("div"),
  })),
  addToolCall: vi.fn(),
  completeToolCall: vi.fn(),
  showError: vi.fn(),
  showTyping: vi.fn(),
  finalizeToolProgress: vi.fn(),
  scrollChatToBottom: vi.fn(),
  ensureScrollListener: vi.fn(),
  enableAutoScroll: vi.fn(),
  isAutoScrollEnabled: vi.fn(() => false),
  setCurrentStreamingMessageId: vi.fn(),
  markStreamingMessageInterrupted: vi.fn(),
  finalizeStreamingMessage: vi.fn(),
  markProgressAsGenerating: vi.fn(),
  updateMessageThinking: vi.fn(),
}));

vi.mock("../js/sidebar.js", () => ({
  loadRoadmaps: vi.fn(),
}));

vi.mock("../js/conversations.js", () => ({
  loadConversations: vi.fn(),
}));

vi.mock("../js/ui.js", () => ({
  showLoginOverlay: vi.fn(),
}));

vi.mock("../js/live.js", () => ({
  subscribeLive: vi.fn(),
  disconnectLive: vi.fn(),
}));

function installDom() {
  document.body.innerHTML = `
    <div class="status">
      <div class="status-indicator"></div>
      <span class="status-text">Connecting...</span>
      <span class="token-usage" id="tokenUsage" style="display: none;">0 tokens</span>
      <div class="provider-controls">
        <select id="providerSelect"></select>
        <select id="modelSelect"></select>
      </div>
    </div>
    <div id="chatMessages"></div>
    <div id="processingIndicator"></div>
    <textarea id="messageInput"></textarea>
    <button id="sendBtn">Send</button>
  `;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("chat token usage display", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    authState.sessionId = "session-usage";
    installDom();
  });

  it("starts hidden and shows formatted tokens after a response completes", async () => {
    const tokenUsageEl = document.getElementById("tokenUsage") as HTMLSpanElement;
    expect(tokenUsageEl.style.display).toBe("none");
    expect(tokenUsageEl.textContent).toBe("0 tokens");

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode("event: done\ndata: {\"done\":true}\n\n"),
        );
        controller.close();
      },
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/chat/stream") {
        return new Response(stream, { status: 200 });
      }
      if (url === "/api/chat/usage?sessionId=session-usage") {
        return jsonResponse({ totalTokens: 19134 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("setInterval", vi.fn());

    const { sendMessage } = await import("../js/chat.js");
    (document.getElementById("messageInput") as HTMLTextAreaElement).value =
      "hello";

    await sendMessage();

    await vi.waitFor(() =>
      expect(tokenUsageEl.textContent).toBe("19,134 tokens"),
    );
    expect(tokenUsageEl.style.display).not.toBe("none");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat/usage?sessionId=session-usage",
      expect.any(Object),
    );
  });

  it("resets to 0 tokens and hides when the chat is cleared", async () => {
    const tokenUsageEl = document.getElementById("tokenUsage") as HTMLSpanElement;
    tokenUsageEl.textContent = "19,134 tokens";
    tokenUsageEl.style.display = "inline";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/chat/sessions/session-usage") {
        return jsonResponse({ success: true });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("setInterval", vi.fn());

    const { clearChat } = await import("../js/chat.js");
    await clearChat();

    expect(tokenUsageEl.textContent).toBe("0 tokens");
    expect(tokenUsageEl.style.display).toBe("none");
  });
});
