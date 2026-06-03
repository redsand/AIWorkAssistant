import { API_BASE, currentSessionId, setCurrentSessionId } from "./state.js";
import { authHeaders } from "./auth.js";
import {
  addMessage,
  createToolProgress,
  finalizeToolProgress,
  addToolCall,
  completeToolCall,
  showTyping,
  scrollChatToBottom,
  ensureScrollListener,
  finalizeStreamingMessage,
} from "./messages.js";
import { loadRoadmaps } from "./sidebar.js";
import { loadConversations } from "./conversations.js";

let activeReader = null;
let activeAbortController = null;

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 1000;
let reconnectAttempts = 0;

export function disconnectLive() {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
  if (activeReader) {
    activeReader.cancel().catch(() => {});
    activeReader = null;
  }
}

export function subscribeLive(sessionId) {
  disconnectLive();
  reconnectAttempts = 0;

  if (!sessionId) return;

  ensureScrollListener();

  const url = `${API_BASE}/chat/sessions/${sessionId}/stream`;
  const headers = authHeaders();
  const abortController = new AbortController();
  activeAbortController = abortController;

  function attempt() {
  fetch(url, { headers, signal: abortController.signal })
    .then((response) => {
      if (abortController.signal.aborted) return;

      if (!response.ok) {
        if (!abortController.signal.aborted) {
          document.getElementById("processingIndicator").classList.remove("active");
          showTyping(false);
        }
        if (response.status === 404) {
          setCurrentSessionId(null);
          localStorage.removeItem("currentSessionId");
        }
        return;
      }

      const reader = response.body.getReader();
      activeReader = reader;
      reconnectAttempts = 0;
      const decoder = new TextDecoder();
      let buffer = "";
      let eventType = "";
      let hasActiveJob = false;
      let progressEl = null;
      let contentCount = 0;
      let shouldReconnect = true;
      let streamingMessageId = null;
      let accumulatedContent = "";
      let currentThinking = "";

      const cleanup = () => {
        if (activeReader === reader) activeReader = null;
        if (activeAbortController === abortController) activeAbortController = null;
        const processingEl = document.getElementById("processingIndicator");
        processingEl.classList.remove("active");
        showTyping(false);
        if (progressEl) {
          finalizeToolProgress();
          progressEl = null;
        }
        if (contentCount > 0) {
          const messages = document
            .getElementById("chatMessages")
            .querySelectorAll(".message.assistant");
          const lastMsg = messages[messages.length - 1];
          if (lastMsg) {
            const bubble = lastMsg.querySelector(".message-bubble");
            if (bubble && !bubble.querySelector(".final-marker")) {
              const marker = document.createElement("div");
              marker.className = "final-marker";
              marker.textContent = "Done";
              bubble.appendChild(marker);
            }
          }
        }
        loadConversations();
      };

      function processChunk(text, flush) {
        buffer += text;
        const lines = buffer.split("\n");
        buffer = flush ? "" : lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
            continue;
          }
          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") continue;
            try {
              const data = JSON.parse(dataStr);

              if (eventType === "state" && data.processing === false) {
                shouldReconnect = false;
                const procEl = document.getElementById("processingIndicator");
                procEl.classList.remove("active");
                showTyping(false);
                return { stop: true };
              }

              if (eventType === "processing") {
                const processingEl = document.getElementById("processingIndicator");
                if (processingEl) processingEl.classList.add("active");
                showTyping(true);
              }

              if (eventType === "session" && data.sessionId) {
                setCurrentSessionId(data.sessionId);
                localStorage.setItem("currentSessionId", data.sessionId);
              }

              if (eventType === "response_start") {
                // New response turn — finalize any in-progress streaming message and reset
                if (streamingMessageId !== null) {
                  finalizeStreamingMessage(streamingMessageId);
                  streamingMessageId = null;
                }
                accumulatedContent = "";
              }

              if (eventType === "tool_start") {
                if (!hasActiveJob) {
                  hasActiveJob = true;
                  const processingEl = document.getElementById("processingIndicator");
                  processingEl.classList.add("active");
                  progressEl = createToolProgress().progressEl;
                  document.getElementById("chatMessages").appendChild(progressEl);
                }
                addToolCall(data.id, data.name, data.params);
              }

              if (eventType === "tool_result") {
                completeToolCall(data.id, data.result);
              }

              if (eventType === "todo_changed") {
                if (document.getElementById("todoPanel").style.display !== "none") {
                  import("./sidebar.js").then(({ loadTodos }) => loadTodos());
                }
              }

              if (eventType === "thinking" && data.thinking) {
                currentThinking += data.thinking;
              }

              if (eventType === "token" && data.token !== undefined) {
                accumulatedContent += data.token;
                if (!hasActiveJob) {
                  hasActiveJob = true;
                  const processingEl = document.getElementById("processingIndicator");
                  processingEl.classList.add("active");
                  progressEl = createToolProgress().progressEl;
                  document.getElementById("chatMessages").appendChild(progressEl);
                }
                if (streamingMessageId === null) {
                  streamingMessageId = addMessage(accumulatedContent, "assistant", currentThinking || undefined, { streaming: true });
                  currentThinking = "";
                } else {
                  addMessage(accumulatedContent, "assistant", undefined, { messageId: streamingMessageId, streaming: true });
                }
                contentCount++;
              }

              // Legacy content event (non-streaming providers)
              if (eventType === "content" && data.content && data.content.trim() && contentCount === 0) {
                if (!hasActiveJob) {
                  hasActiveJob = true;
                  const processingEl = document.getElementById("processingIndicator");
                  processingEl.classList.add("active");
                  progressEl = createToolProgress().progressEl;
                  document.getElementById("chatMessages").appendChild(progressEl);
                }
                addMessage(data.content, "assistant", currentThinking || undefined);
                currentThinking = "";
                contentCount++;
              }

              if (eventType === "error" && data.message) {
                finalizeStreamingMessage(streamingMessageId);
                streamingMessageId = null;
                if (progressEl) {
                  const headerText = progressEl.querySelector(".tool-progress-header-left");
                  if (headerText) {
                    headerText.innerHTML = `<span class="tool-call-status error"></span> Error occurred`;
                  }
                }
                addMessage("Sorry, I encountered an error: " + data.message, "assistant");
                cleanup();
                return { stop: true };
              }

              if (eventType === "done") {
                finalizeStreamingMessage(streamingMessageId);
                streamingMessageId = null;
                cleanup();
                return { stop: true };
              }

              if (eventType === "error") {
                finalizeStreamingMessage(streamingMessageId);
                streamingMessageId = null;
                cleanup();
                return { stop: true };
              }
            } catch {}
          }
        }
        return { stop: false };
      }

      const pump = async () => {
        while (true) {
          if (abortController.signal.aborted) break;
          let result;
          try {
            result = await reader.read();
          } catch (err) {
            if (!abortController.signal.aborted) cleanup();
            break;
          }
          const { done, value } = result;
          if (done) {
            if (buffer.trim()) {
              processChunk("\n", true);
            }
            cleanup();
            if (shouldReconnect && sessionId && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
              reconnectAttempts++;
              const delay = RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1);
              console.log(`[SSE] Stream ended, reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
              setTimeout(() => attempt(), delay);
            }
            break;
          }
          const chunkResult = processChunk(
            decoder.decode(value, { stream: true }),
            false,
          );
          if (chunkResult.stop) break;
        }
      };

      pump();
    })
    .catch(() => {
      if (!abortController.signal.aborted) {
        document.getElementById("processingIndicator").classList.remove("active");
        showTyping(false);
      }
    });
  }

  attempt();
}