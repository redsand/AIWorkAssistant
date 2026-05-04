import {
  API_BASE,
  currentMode,
  currentSessionId,
  messageHistory,
  historyIndex,
  draftBeforeHistory,
  activeStreamController,
  setCurrentSessionId,
  setHistoryIndex,
  setDraftBeforeHistory,
  setMessageHistory,
  setActiveStreamController,
  updateSessionHash,
} from "./state.js";
import { authHeaders } from "./auth.js";
import { autoResizeTextarea } from "./utils.js";
import {
  addMessage,
  createToolProgress,
  addToolCall,
  completeToolCall,
  showError,
} from "./messages.js";
import { loadRoadmaps } from "./sidebar.js";
import { loadConversations } from "./conversations.js";
import { showLoginOverlay } from "./ui.js";

async function handleStreamResponse(response, progressElRef, onError) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentThinking = "";
  let eventType = "";
  let roadmapTouched = false;
  let contentCount = 0;

  function ensureProgressEl() {
    if (!progressElRef.progressEl) {
      const result = createToolProgress();
      progressElRef.progressEl = result.progressEl;
      document.getElementById("chatMessages").appendChild(result.progressEl);
      document.getElementById("chatMessages").scrollTop =
        document.getElementById("chatMessages").scrollHeight;
    }
    return progressElRef.progressEl;
  }

  function processBuffer(flush) {
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
          if (data.sessionId) {
            setCurrentSessionId(data.sessionId);
            localStorage.setItem("currentSessionId", data.sessionId);
            updateSessionHash(data.sessionId);
          }
          if (eventType === "tool_start") {
            ensureProgressEl();
            addToolCall(data.id, data.name, data.params);
            if (data.name && String(data.name).startsWith("roadmap.")) {
              roadmapTouched = true;
            }
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
          if (data.content && data.content.trim()) {
            addMessage(data.content, "assistant", currentThinking || undefined);
            currentThinking = "";
            contentCount++;
          }
          if (data.message) {
            if (progressElRef.progressEl) progressElRef.progressEl.remove();
            addMessage(
              "Sorry, I encountered an error: " + data.message,
              "assistant",
            );
            return { error: true, roadmapTouched };
          }
        } catch {}
      }
    }
    return { error: false };
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffer.trim()) {
        buffer += "\n";
        const result = processBuffer(true);
        if (result.error) return { error: true, roadmapTouched };
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const result = processBuffer(false);
    if (result.error) return { error: true, roadmapTouched };
  }

  return { error: false, roadmapTouched, contentCount };
}

function addCompletionMarker() {
  const messages = document
    .getElementById("chatMessages")
    .querySelectorAll(".message.assistant");
  const lastMsg = messages[messages.length - 1];
  if (lastMsg) {
    const bubble = lastMsg.querySelector(".message-bubble");
    if (bubble) {
      const marker = document.createElement("div");
      marker.className = "final-marker";
      marker.textContent = "Done";
      bubble.appendChild(marker);
    }
  }
}

export async function initializeChat() {
  try {
    const response = await fetch(`${API_BASE}/chat/health`, {
      headers: authHeaders(),
    });
    const data = await response.json();

    const statusText = document.querySelector(".status-text");
    const statusIndicator = document.querySelector(".status-indicator");

    if (statusText && statusIndicator) {
      if (data.provider?.valid) {
        statusText.textContent = `Connected · ${data.provider.active}`;
        statusIndicator.className = "status-indicator status-ok";
      } else if (data.provider?.configured) {
        statusText.textContent = "Configured · Invalid credentials";
        statusIndicator.className = "status-indicator status-error";
      } else {
        statusText.textContent = "Not configured";
        statusIndicator.className = "status-indicator status-error";
      }
    }
  } catch (error) {
    console.error("Health check failed:", error);
    const statusText = document.querySelector(".status-text");
    const statusIndicator = document.querySelector(".status-indicator");
    if (statusText) statusText.textContent = "Disconnected";
    if (statusIndicator) statusIndicator.className = "status-indicator status-error";
  }

  await loadChatHistory();

  const { subscribeLive } = await import("./live.js?v=8");
  if (currentSessionId) {
    subscribeLive(currentSessionId);
  }
}

async function loadChatHistory() {
  if (!currentSessionId) {
    try {
      const res = await fetch(`${API_BASE}/chat/sessions?userId=web-user`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      if (data.sessions && data.sessions.length > 0) {
        setCurrentSessionId(data.sessions[0].id);
        localStorage.setItem("currentSessionId", data.sessions[0].id);
        updateSessionHash(data.sessions[0].id);
      }
    } catch {
      return;
    }
  }

  if (!currentSessionId) return;

  try {
    const response = await fetch(
      `${API_BASE}/chat/sessions/${currentSessionId}/messages`,
      { headers: authHeaders() },
    );

    if (!response.ok) {
      setCurrentSessionId(null);
      localStorage.removeItem("currentSessionId");
      return;
    }

    const data = await response.json();
    if (!data.messages || data.messages.length === 0) return;

    const chatMessages = document.getElementById("chatMessages");
    chatMessages.innerHTML = "";

    for (const msg of data.messages) {
      if (msg.role === "system" || msg.role === "tool") continue;
      if (
        msg.role === "assistant" &&
        (!msg.content || msg.content.trim() === "")
      )
        continue;
      addMessage(msg.content, msg.role);
      if (msg.role === "user" && msg.content) {
        const hist = [...messageHistory];
        hist.push(msg.content);
        setMessageHistory(hist);
      }
    }
  } catch {
    setCurrentSessionId(null);
    localStorage.removeItem("currentSessionId");
  }
}

export async function clearChat() {
  if (!currentSessionId) return;

  try {
    await fetch(`${API_BASE}/chat/sessions/${currentSessionId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
  } catch {}

  setCurrentSessionId(null);
  localStorage.removeItem("currentSessionId");

  const chatMessages = document.getElementById("chatMessages");
  chatMessages.innerHTML = `
    <div class="message assistant">
      <div class="message-bubble">
        Hello! I'm your AI Assistant. I can help you with productivity
        tasks, Jira, GitLab, calendar management, and engineering strategy.
        How can I help you today?
      </div>
    </div>
  `;
}

export async function sendMessage() {
  const input = document.getElementById("messageInput");
  const message = input.value.trim();

  if (!message) return;

  const { disconnectLive } = await import("./live.js?v=8");
  disconnectLive();

  input.value = "";
  autoResizeTextarea(input);
  setHistoryIndex(-1);
  setDraftBeforeHistory("");
  const hist = [...messageHistory];
  if (hist[hist.length - 1] !== message) {
    hist.push(message);
  }
  setMessageHistory(hist);
  addMessage(message, "user");

  const processingEl = document.getElementById("processingIndicator");
  processingEl.classList.add("active");

  const progressElRef = { progressEl: null };

  try {
    if (activeStreamController) {
      activeStreamController.abort();
    }
    const controller = new AbortController();
    setActiveStreamController(controller);

    const response = await fetch(`${API_BASE}/chat/stream`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        message: message,
        mode: currentMode,
        userId: "web-user",
        sessionId: currentSessionId,
        includeMemory: true,
        includeTools: true,
      }),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      processingEl.classList.remove("active");
      showLoginOverlay();
      return;
    }

    if (!response.ok) {
      processingEl.classList.remove("active");
      let errorText = `Server returned ${response.status}`;
      try {
        const errBody = await response.json();
        if (errBody.error || errBody.message) {
          errorText = errBody.error || errBody.message;
        }
      } catch {}
      addMessage("Error: " + errorText, "assistant");
      return;
    }

    const result = await handleStreamResponse(response, progressElRef);

    if (progressElRef.progressEl) progressElRef.progressEl.remove();
    processingEl.classList.remove("active");

    if (result.error) return;

    if (result.contentCount > 0) {
      addCompletionMarker();
    }

    if (result.roadmapTouched) {
      loadRoadmaps();
    }

    loadConversations();
  } catch (error) {
    if (progressElRef.progressEl) progressElRef.progressEl.remove();
    processingEl.classList.remove("active");
    if (error instanceof DOMException && error.name === "AbortError") return;
    console.error("Failed to send message:", error);
    const errMsg = error instanceof Error ? error.message : String(error);
    addMessage(
      "Failed to connect to the agent: " +
        errMsg +
        ". Please check that the server is running and try again.",
      "assistant",
    );
  }
}

export async function resendMessage(message) {
  const { disconnectLive } = await import("./live.js?v=8");
  disconnectLive();

  setHistoryIndex(-1);
  const hist = [...messageHistory];
  if (hist[hist.length - 1] !== message) {
    hist.push(message);
  }
  setMessageHistory(hist);
  const messagesDiv = document.getElementById("chatMessages");

  const userMessages = messagesDiv.querySelectorAll(".message.user");
  let clickedMsg = null;
  for (const um of userMessages) {
    if (um.dataset.originalText === message) {
      clickedMsg = um;
      break;
    }
  }

  if (clickedMsg) {
    // Remove only the assistant responses after the user message,
    // keep the user message itself visible.
    let next = clickedMsg.nextElementSibling;
    while (next) {
      const current = next;
      next = current.nextElementSibling;
      current.remove();
    }
  }

  const processingEl2 = document.getElementById("processingIndicator");
  processingEl2.classList.add("active");

  const progressElRef = { progressEl: null };

  try {
    if (activeStreamController) {
      activeStreamController.abort();
    }
    const controller = new AbortController();
    setActiveStreamController(controller);

    const response = await fetch(`${API_BASE}/chat/stream`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        message: message,
        mode: currentMode,
        userId: "web-user",
        sessionId: currentSessionId,
        includeMemory: true,
        includeTools: true,
      }),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      processingEl2.classList.remove("active");
      showLoginOverlay();
      return;
    }

    if (!response.ok) {
      processingEl2.classList.remove("active");
      let errorText = `Server returned ${response.status}`;
      try {
        const errBody = await response.json();
        if (errBody.error || errBody.message) {
          errorText = errBody.error || errBody.message;
        }
      } catch {}
      addMessage("Error: " + errorText, "assistant");
      return;
    }

    const result = await handleStreamResponse(response, progressElRef);

    if (progressElRef.progressEl) progressElRef.progressEl.remove();
    processingEl2.classList.remove("active");

    if (result.error) return;

    if (result.contentCount > 0) {
      addCompletionMarker();
    }

    if (result.roadmapTouched) {
      loadRoadmaps();
    }

    loadConversations();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    console.error("Failed to send message:", error);
    if (progressElRef.progressEl) progressElRef.progressEl.remove();
    processingEl2.classList.remove("active");
    const errMsg2 = error instanceof Error ? error.message : String(error);
    addMessage(
      "Failed to connect to the agent: " +
        errMsg2 +
        ". Please check that the server is running and try again.",
      "assistant",
    );
  }
}