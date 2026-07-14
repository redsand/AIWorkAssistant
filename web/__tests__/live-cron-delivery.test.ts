/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ sessionId: "sess-cron" as string | null }));

vi.mock("../js/state.js", () => ({
  API_BASE: "",
  get currentSessionId() {
    return state.sessionId;
  },
  setCurrentSessionId: vi.fn((id: string | null) => {
    state.sessionId = id;
  }),
}));

vi.mock("../js/auth.js", () => ({
  authHeaders: () => ({ Authorization: "Bearer test-token" }),
}));

vi.mock("../js/messages.js", () => ({
  addMessage: vi.fn(() => "msg-1"),
  addCronResultMessage: vi.fn(),
  createToolProgress: vi.fn(() => ({ progressEl: document.createElement("div") })),
  reuseOrCreateToolProgress: vi.fn(() => ({
    progressEl: document.createElement("div"),
    reused: false,
  })),
  finalizeToolProgress: vi.fn(),
  addToolCall: vi.fn(),
  completeToolCall: vi.fn(),
  showTyping: vi.fn(),
  scrollChatToBottom: vi.fn(),
  ensureScrollListener: vi.fn(),
  finalizeStreamingMessage: vi.fn(),
  markProgressAsGenerating: vi.fn(),
  updateMessageThinking: vi.fn(),
}));

vi.mock("../js/sidebar.js", () => ({
  loadRoadmaps: vi.fn(),
  loadTodos: vi.fn(),
}));

vi.mock("../js/conversations.js", () => ({
  loadConversations: vi.fn(),
}));

function installDom() {
  document.body.innerHTML = `
    <div id="chatMessages"></div>
    <div id="processingIndicator"></div>
    <div id="typingIndicator"></div>
    <span id="processingStatusText"></span>
  `;
}

// A stream we can push additional SSE chunks into over time, without ever
// closing it — this mirrors the server keeping the connection open
// indefinitely to deliver idle-time async events like cron_result.
function makeControllableStream() {
  let controllerRef: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
  });
  return {
    stream,
    push(text: string) {
      controllerRef.enqueue(new TextEncoder().encode(text));
    },
  };
}

describe("subscribeLive — persistent SSE stream for async cron delivery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.sessionId = "sess-cron";
    installDom();
  });

  it("keeps reading after a state/processing:false event instead of tearing down the stream, and still delivers a cron_result", async () => {
    const { addCronResultMessage } = await import("../js/messages.js");
    const { subscribeLive } = await import("../js/live.js");

    const { stream, push } = makeControllableStream();
    const fetchMock = vi.fn(async () => new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    subscribeLive("sess-cron");
    await Promise.resolve();

    // Job finishes — historically this set shouldReconnect=false and
    // returned {stop:true}, abandoning the pump loop entirely.
    push('event: state\ndata: {"processing":false}\n\n');
    await vi.waitFor(() => {
      const procEl = document.getElementById("processingIndicator")!;
      expect(procEl.classList.contains("active")).toBe(false);
    });

    // The connection must still be alive to receive this — if the pump
    // had stopped, this event would never be processed.
    push(
      'event: cron_result\ndata: {"jobName":"nightly-report","timestamp":"2026-07-13T10:00:00Z","output":"All good","success":true}\n\n',
    );
    await vi.waitFor(() => {
      expect(addCronResultMessage).toHaveBeenCalledWith(
        "nightly-report",
        "2026-07-13T10:00:00Z",
        "All good",
        true,
      );
    });

    // A second cron_result later in the same idle connection also arrives
    // — proving cron_result's own {stop:false} return doesn't stop the
    // loop either.
    push(
      'event: cron_result\ndata: {"jobName":"second-job","timestamp":"2026-07-13T11:00:00Z","output":"Also fine","success":false}\n\n',
    );
    await vi.waitFor(() => {
      expect(addCronResultMessage).toHaveBeenCalledTimes(2);
    });
    expect(addCronResultMessage).toHaveBeenLastCalledWith(
      "second-job",
      "2026-07-13T11:00:00Z",
      "Also fine",
      false,
    );

    // Only one fetch — no reconnect happened, because the stream was never
    // torn down in the first place.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still stops the pump loop on a genuine done event (unaffected by the reconnect fix)", async () => {
    const { addMessage } = await import("../js/messages.js");
    const { subscribeLive } = await import("../js/live.js");

    const { stream, push } = makeControllableStream();
    const fetchMock = vi.fn(async () => new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    subscribeLive("sess-cron");
    await Promise.resolve();

    push('event: token\ndata: {"token":"hi"}\n\n');
    await vi.waitFor(() => expect(addMessage).toHaveBeenCalled());

    push('event: done\ndata: {"done":true}\n\n');

    const { loadConversations } = await import("../js/conversations.js");
    await vi.waitFor(() => expect(loadConversations).toHaveBeenCalled());

    // Pushing further data after "done" must not be observed — the reader
    // has already stopped consuming and this stream instance is retired.
    push('event: cron_result\ndata: {"jobName":"late","output":"x","success":true}\n\n');
    const { addCronResultMessage } = await import("../js/messages.js");
    await new Promise((r) => setTimeout(r, 20));
    expect(addCronResultMessage).not.toHaveBeenCalled();
  });
});
