/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  token: "test-token",
}));

vi.mock("../js/state.js", () => ({
  API_BASE: "/api",
  currentMode: "productivity",
  currentSessionId: "session-1",
  messageHistory: [],
  historyIndex: -1,
  draftBeforeHistory: "",
  activeStreamController: null,
  sendGeneration: 0,
  setCurrentSessionId: vi.fn(),
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

vi.mock("../js/live.js?v=9", () => ({
  subscribeLive: vi.fn(),
  disconnectLive: vi.fn(),
}));

function installDom() {
  document.body.innerHTML = `
    <div class="status-indicator"></div>
    <span class="status-text"></span>
    <select id="providerSelect"></select>
    <select id="modelSelect"></select>
    <div id="chatMessages"></div>
    <div id="processingIndicator"></div>
    <textarea id="messageInput"></textarea>
  `;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("chat provider controls", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installDom();
  });

  it("loads provider and model options during chat initialization", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/chat/providers") {
        return jsonResponse({
          active: "openai",
          model: "gpt-4o",
          providers: ["opencode", "openai"],
          models: { models: ["gpt-4o", "gpt-5"] },
        });
      }
      if (url === "/api/chat/health") {
        return jsonResponse({
          provider: {
            active: "openai",
            model: "gpt-4o",
            configured: true,
            valid: true,
          },
        });
      }
      if (url === "/api/chat/sessions?userId=web-user") {
        return jsonResponse({ sessions: [] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { initializeChat } = await import("../js/chat.js");

    await initializeChat();

    const providerSelect = document.getElementById(
      "providerSelect",
    ) as HTMLSelectElement;
    const modelSelect = document.getElementById(
      "modelSelect",
    ) as HTMLSelectElement;
    expect([...providerSelect.options].map((option) => option.value)).toEqual([
      "opencode",
      "openai",
    ]);
    expect(providerSelect.value).toBe("openai");
    expect([...modelSelect.options].map((option) => option.value)).toEqual([
      "gpt-4o",
      "gpt-5",
    ]);
    expect(modelSelect.value).toBe("gpt-4o");
    expect(document.querySelector(".status-text")?.textContent).toBe(
      "Connected · openai · gpt-4o",
    );
  });

  it("queries models and switches runtime provider when provider selection changes", async () => {
    let activeProvider = "openai";
    let activeModel = "gpt-4o";
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/chat/providers") {
          return jsonResponse({
            active: activeProvider,
            model: activeModel,
            providers: ["openai", "ollama"],
            models: {
              models:
                activeProvider === "ollama"
                  ? ["llama3", "mistral"]
                  : ["gpt-4o"],
            },
          });
        }
        if (url === "/api/chat/health") {
          return jsonResponse({
            provider: {
              active: "ollama",
              model: "llama3",
              configured: true,
              valid: true,
            },
          });
        }
        if (url === "/api/chat/sessions?userId=web-user") {
          return jsonResponse({ sessions: [] });
        }
        if (url === "/api/chat/providers/ollama/models") {
          return jsonResponse({ models: ["llama3", "mistral"] });
        }
        if (url === "/api/chat/provider") {
          expect(JSON.parse(String(init?.body))).toEqual({
            provider: "ollama",
            model: "llama3",
          });
          activeProvider = "ollama";
          activeModel = "llama3";
          return jsonResponse({
            provider: "ollama",
            model: "llama3",
            models: { models: ["llama3", "mistral"] },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { initializeChat } = await import("../js/chat.js");
    await initializeChat();

    const providerSelect = document.getElementById(
      "providerSelect",
    ) as HTMLSelectElement;
    providerSelect.value = "ollama";
    providerSelect.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/chat/provider",
        expect.any(Object),
      ),
    );

    const modelSelect = document.getElementById(
      "modelSelect",
    ) as HTMLSelectElement;
    expect(modelSelect.value).toBe("llama3");
  });

  it("switches runtime model when model selection changes", async () => {
    let activeModel = "gpt-4o";
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/chat/providers") {
          return jsonResponse({
            active: "openai",
            model: activeModel,
            providers: ["openai"],
            models: { models: ["gpt-4o", "gpt-5"] },
          });
        }
        if (url === "/api/chat/health") {
          return jsonResponse({
            provider: {
              active: "openai",
              model: activeModel,
              configured: true,
              valid: true,
            },
          });
        }
        if (url === "/api/chat/sessions?userId=web-user") {
          return jsonResponse({ sessions: [] });
        }
        if (url === "/api/chat/provider") {
          expect(JSON.parse(String(init?.body))).toEqual({
            provider: "openai",
            model: "gpt-5",
          });
          activeModel = "gpt-5";
          return jsonResponse({
            provider: "openai",
            model: "gpt-5",
            models: { models: ["gpt-4o", "gpt-5"] },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { initializeChat } = await import("../js/chat.js");
    await initializeChat();

    const modelSelect = document.getElementById(
      "modelSelect",
    ) as HTMLSelectElement;
    modelSelect.value = "gpt-5";
    modelSelect.dispatchEvent(new Event("change"));

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/chat/provider",
        expect.any(Object),
      ),
    );
    expect(modelSelect.value).toBe("gpt-5");
    await vi.waitFor(() =>
      expect(document.querySelector(".status-text")?.textContent).toBe(
        "Connected · openai · gpt-5",
      ),
    );
  });

  it("sends the selected model with chat requests", async () => {
    const modelSelect = document.getElementById(
      "modelSelect",
    ) as HTMLSelectElement;
    modelSelect.innerHTML = '<option value="gpt-5" selected>gpt-5</option>';
    (document.getElementById("messageInput") as HTMLTextAreaElement).value =
      "hello";

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/chat/stream") {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            model: "gpt-5",
            message: "hello",
          });
          return new Response(stream, { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { sendMessage } = await import("../js/chat.js");

    await sendMessage();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat/stream",
      expect.any(Object),
    );
  });
});
