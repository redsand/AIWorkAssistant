import { API_BASE, currentSessionId, setCurrentSessionId } from "./state.js";
import { authHeaders } from "./auth.js";
import {
  addMessage,
  createToolProgress,
  addToolCall,
  completeToolCall,
} from "./messages.js";
import { loadRoadmaps } from "./sidebar.js";
import { loadConversations } from "./conversations.js";

let liveEventSource = null;

export function disconnectLive() {
  if (liveEventSource) {
    liveEventSource.close();
    liveEventSource = null;
  }
}

export function subscribeLive(sessionId) {
  disconnectLive();

  if (!sessionId) return;

  const url = `${API_BASE}/chat/sessions/${sessionId}/stream`;
  const headers = authHeaders();

  fetch(url, { headers })
    .then((response) => {
      if (!response.ok) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentThinking = "";
      let eventType = "";
      let hasActiveJob = false;
      let progressEl = null;
      let contentCount = 0;

      const cleanup = () => {
        const processingEl = document.getElementById("processingIndicator");
        processingEl.classList.remove("active");
        if (progressEl) {
          progressEl.remove();
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
                return { stop: false };
              }

              if (eventType === "session" && data.sessionId) {
                setCurrentSessionId(data.sessionId);
                localStorage.setItem("currentSessionId", data.sessionId);
              }

              if (eventType === "tool_start") {
                if (!hasActiveJob) {
                  hasActiveJob = true;
                  const processingEl = document.getElementById(
                    "processingIndicator",
                  );
                  processingEl.classList.add("active");
                  const result = createToolProgress();
                  progressEl = result.progressEl;
                  document
                    .getElementById("chatMessages")
                    .appendChild(progressEl);
                }
                addToolCall(data.id, data.name, data.params);
              }

              if (eventType === "tool_result") {
                completeToolCall(data.id, data.result);
              }

              if (eventType === "todo_changed") {
                if (
                  document.getElementById("todoPanel").style.display !== "none"
                ) {
                  import("./sidebar.js").then(({ loadTodos }) => loadTodos());
                }
              }

              if (eventType === "thinking" && data.thinking) {
                currentThinking += data.thinking;
              }

              if (data.content && data.content.trim()) {
                if (!hasActiveJob) {
                  hasActiveJob = true;
                  const processingEl = document.getElementById(
                    "processingIndicator",
                  );
                  processingEl.classList.add("active");
                  const result = createToolProgress();
                  progressEl = result.progressEl;
                  document
                    .getElementById("chatMessages")
                    .appendChild(progressEl);
                }
                addMessage(
                  data.content,
                  "assistant",
                  currentThinking || undefined,
                );
                currentThinking = "";
                contentCount++;
              }

              if (data.message) {
                if (progressEl) progressEl.remove();
                addMessage(
                  "Sorry, I encountered an error: " + data.message,
                  "assistant",
                );
                cleanup();
                return { stop: true };
              }

              if (eventType === "done") {
                cleanup();
                return { stop: true };
              }

              if (eventType === "error") {
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
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim()) {
              processChunk("\n", true);
            }
            cleanup();
            break;
          }
          const result = processChunk(
            decoder.decode(value, { stream: true }),
            false,
          );
          if (result.stop) break;
        }
      };

      pump();
    })
    .catch(() => {});
}
