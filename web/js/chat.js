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
  sendGeneration,
} from "./state.js";
import { nextSendGeneration } from "./state.js";
import { authHeaders } from "./auth.js";
import { autoResizeTextarea } from "./utils.js";
import {
  addMessage,
  createToolProgress,
  addToolCall,
  completeToolCall,
  showError,
  showTyping,
  finalizeToolProgress,
  scrollChatToBottom,
  ensureScrollListener,
  enableAutoScroll,
  isAutoScrollEnabled,
  setCurrentStreamingMessageId,
  markStreamingMessageInterrupted,
  finalizeStreamingMessage,
  markProgressAsGenerating,
  updateMessageThinking,
} from "./messages.js";
import { loadRoadmaps } from "./sidebar.js";
import { loadConversations } from "./conversations.js";
import { showLoginOverlay } from "./ui.js";

/**
 * Idea 3 + I: render a banner above the messages list when ClaimKit
 * detected cross-source contradictions on entities the user is asking
 * about. The agent gets the same signal in its system prompt; the banner
 * gives the human a visible chance to resolve the conflict before
 * trusting the answer.
 *
 * Each item is a pre-formatted markdown line from the entity-claims
 * injector ("- **IR-82.status**: jira.get_issue says `Done` (2h ago); ...").
 * We strip the leading dash and bold-render the first segment.
 */
function renderContradictionBanner(items) {
  let host = document.getElementById("contradictionBanner");
  const messagesContainer = document.getElementById("messagesContainer")
    || document.querySelector(".messages")
    || document.body;
  if (!host) {
    host = document.createElement("div");
    host.id = "contradictionBanner";
    host.className = "contradiction-banner";
    messagesContainer.parentElement?.insertBefore(host, messagesContainer);
  }
  host.innerHTML =
    '<div class="contradiction-banner-header">' +
    '<span class="contradiction-banner-icon">⚠️</span>' +
    '<span class="contradiction-banner-title">Cross-source contradiction detected</span>' +
    '<button type="button" class="contradiction-banner-close" aria-label="Dismiss">×</button>' +
    '</div>' +
    '<div class="contradiction-banner-body">' +
    items.map((line) => {
      const stripped = line.replace(/^[\s\-*]+/, "").trim();
      return '<div class="contradiction-banner-item">' +
        stripped
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
          .replace(/`([^`]+)`/g, "<code>$1</code>") +
        '</div>';
    }).join("") +
    '</div>';
  host.style.display = "block";
  host.querySelector(".contradiction-banner-close")?.addEventListener("click", () => {
    host.style.display = "none";
  });
}

async function handleStreamResponse(response, progressElRef, onError) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentThinking = "";
  let eventType = "";
  let roadmapTouched = false;
  let contentCount = 0;
  let streamingMessageId = null;
  let accumulatedContent = "";

  function ensureProgressEl() {
    // Re-create if null or detached from DOM (cleanup from a prior subscribeLive can remove it)
    if (!progressElRef.progressEl || !document.body.contains(progressElRef.progressEl)) {
      const result = createToolProgress();
      progressElRef.progressEl = result.progressEl;
      document.getElementById("chatMessages").appendChild(result.progressEl);
      const processingEl = document.getElementById("processingIndicator");
      processingEl.classList.add("active");
      if (isAutoScrollEnabled()) scrollChatToBottom();
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
          if (eventType === "response_start") {
            const statusEl = document.getElementById("processingStatusText");
            if (statusEl) statusEl.textContent = "Generating response...";
            // Server is starting a new response turn (after tool calls). Reset the
            // streaming message ID so the next token creates a fresh message bubble.
            if (streamingMessageId !== null) {
              finalizeStreamingMessage(streamingMessageId);
              setCurrentStreamingMessageId(null);
              streamingMessageId = null;
            }
            accumulatedContent = "";
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
          if (eventType === "processing") {
            document.getElementById("processingIndicator")?.classList.add("active");
            const statusEl = document.getElementById("processingStatusText");
            if (statusEl) statusEl.textContent = data.message || "Processing your request...";
            showTyping(true);
          }
          if (eventType === "contradictions" && Array.isArray(data.items) && data.items.length > 0) {
            // Idea 3 + I: render a banner above the response when ClaimKit
            // detected cross-source contradictions. The agent gets this same
            // signal in its prompt; the banner gives the human a visible
            // chance to resolve the conflict before trusting the answer.
            renderContradictionBanner(data.items);
          }
          if (eventType === "thinking" && data.thinking) {
            currentThinking += data.thinking;
            if (streamingMessageId === null) {
              // Show thinking immediately — create the bubble now so the user
              // sees the AI reasoning in real-time, even before the first token.
              markProgressAsGenerating();
              streamingMessageId = addMessage("", "assistant", currentThinking, { streaming: true });
              setCurrentStreamingMessageId(streamingMessageId);
            } else {
              updateMessageThinking(streamingMessageId, currentThinking);
            }
          }
          if (eventType === "token" && data.token !== undefined) {
            accumulatedContent += data.token;
            if (streamingMessageId === null) {
              // No thinking was shown — create the bubble on first token.
              markProgressAsGenerating();
              streamingMessageId = addMessage(accumulatedContent, "assistant", undefined, { streaming: true });
              setCurrentStreamingMessageId(streamingMessageId);
            } else {
              addMessage(accumulatedContent, "assistant", undefined, { messageId: streamingMessageId, streaming: true });
            }
            contentCount++;
          }
          // Legacy content event (non-streaming fallback — no token events)
          if (eventType === "content" && data.content && data.content.trim() && contentCount === 0) {
            accumulatedContent += data.content;
            if (streamingMessageId === null) {
              streamingMessageId = addMessage(accumulatedContent, "assistant", currentThinking || undefined);
              setCurrentStreamingMessageId(streamingMessageId);
              currentThinking = "";
            } else {
              addMessage(accumulatedContent, "assistant", undefined, { messageId: streamingMessageId });
            }
            contentCount++;
          }
          if (eventType === "done") {
            // Finalize streaming: do a full markdown render of accumulated content
            finalizeStreamingMessage(streamingMessageId);
            return { error: false, roadmapTouched, contentCount, done: true };
          }
          if (eventType === "error" && data.message) {
            finalizeStreamingMessage(streamingMessageId);
            if (progressElRef.progressEl) {
              const headerText = progressElRef.progressEl.querySelector(".tool-progress-header-left");
              if (headerText) {
                headerText.innerHTML = `<span class="tool-call-status error"></span> Error occurred`;
              }
            }
            setCurrentStreamingMessageId(null);
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
        if (result.error) {
          setCurrentStreamingMessageId(null);
          return { error: true, roadmapTouched };
        }
        if (result.done) break;
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const result = processBuffer(false);
    if (result.error) {
      setCurrentStreamingMessageId(null);
      return { error: true, roadmapTouched };
    }
    // Exit as soon as the server signals done — don't wait for HTTP close
    if (result.done) break;
  }

  setCurrentStreamingMessageId(null);
  return { error: false, roadmapTouched, contentCount };
}


function setProviderControlsDisabled(disabled) {
  const providerSelect = document.getElementById("providerSelect");
  const modelSelect = document.getElementById("modelSelect");
  if (providerSelect) providerSelect.disabled = disabled;
  if (modelSelect) modelSelect.disabled = disabled;
}

function renderOptions(select, values, selectedValue) {
  if (!select) return;
  select.innerHTML = "";
  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = value === selectedValue;
    select.appendChild(option);
  });
}

async function loadModelsForProvider(provider, selectedModel) {
  const modelSelect = document.getElementById("modelSelect");
  if (!modelSelect) return [];
  modelSelect.disabled = true;
  modelSelect.innerHTML = '<option value="">Loading models...</option>';

  const response = await fetch(`${API_BASE}/chat/providers/${encodeURIComponent(provider)}/models`, {
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error(`Unable to load models for ${provider}`);

  const data = await response.json();
  const models = Array.isArray(data.models) ? data.models : [];
  renderOptions(modelSelect, models, selectedModel || models[0] || "");
  modelSelect.disabled = models.length === 0;
  return models;
}

async function setRuntimeProvider(provider, model) {
  setProviderControlsDisabled(true);
  try {
    const response = await fetch(`${API_BASE}/chat/provider`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ provider, model: model || undefined }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Unable to switch provider to ${provider}`);

    renderOptions(document.getElementById("modelSelect"), data.models?.models || [], data.model);
    const providerSelect = document.getElementById("providerSelect");
    if (providerSelect) providerSelect.value = data.provider;
    await initializeProviderControls(false);
    await updateProviderHealth();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    await initializeProviderControls(false);
    await updateProviderHealth();
  } finally {
    setProviderControlsDisabled(false);
  }
}

async function initializeProviderControls(refreshHealth = true) {
  const providerSelect = document.getElementById("providerSelect");
  const modelSelect = document.getElementById("modelSelect");
  if (!providerSelect || !modelSelect) return;

  setProviderControlsDisabled(true);
  const response = await fetch(`${API_BASE}/chat/providers`, { headers: authHeaders() });
  if (!response.ok) throw new Error("Unable to load AI providers");
  const data = await response.json();
  renderOptions(providerSelect, data.providers || [], data.active);
  renderOptions(modelSelect, data.models?.models || [], data.model);
  providerSelect.disabled = false;
  modelSelect.disabled = !data.models?.models?.length;

  providerSelect.onchange = async () => {
    const models = await loadModelsForProvider(providerSelect.value);
    await setRuntimeProvider(providerSelect.value, models[0] || "");
  };
  modelSelect.onchange = async () => {
    await setRuntimeProvider(providerSelect.value, modelSelect.value);
  };

  if (refreshHealth) await updateProviderHealth();
}

async function updateProviderHealth() {
  const response = await fetch(`${API_BASE}/chat/health`, {
    headers: authHeaders(),
  });
  const data = await response.json();

  const statusText = document.querySelector(".status-text");
  const statusIndicator = document.querySelector(".status-indicator");

  if (statusText && statusIndicator) {
    if (data.provider?.valid) {
      statusText.textContent = `Connected · ${data.provider.active} · ${data.provider.model}`;
      statusIndicator.className = "status-indicator status-ok";
    } else if (data.provider?.configured) {
      statusText.textContent = `Configured · ${data.provider.active} · Invalid credentials`;
      statusIndicator.className = "status-indicator status-error";
    } else {
      statusText.textContent = "Not configured";
      statusIndicator.className = "status-indicator status-error";
    }
  }
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
    await initializeProviderControls();
  } catch (error) {
    console.error("Health check failed:", error);
    const statusText = document.querySelector(".status-text");
    const statusIndicator = document.querySelector(".status-indicator");
    if (statusText) statusText.textContent = "Disconnected";
    if (statusIndicator) statusIndicator.className = "status-indicator status-error";
  }

  await loadChatHistory();
  ensureScrollListener();

  const { subscribeLive } = await import("./live.js");
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

    if (activeStreamController) {
      activeStreamController.abort();
      setActiveStreamController(null);
    }

    const chatMessages = document.getElementById("chatMessages");
    chatMessages.innerHTML = "";

    for (const msg of data.messages) {
      if (msg.role === "system" || msg.role === "tool") continue;
      if (
        msg.role === "assistant" &&
        (!msg.content || msg.content.trim() === "")
      )
        continue;
      addMessage(msg.content, msg.role, msg.thinking || undefined, { scroll: false });
      if (msg.role === "user" && msg.content) {
        const hist = [...messageHistory];
        hist.push(msg.content);
        setMessageHistory(hist);
      }
    }

    requestAnimationFrame(() => {
      ensureScrollListener();
      scrollChatToBottom(true);
    });
  } catch {
    setCurrentSessionId(null);
    localStorage.removeItem("currentSessionId");
  }
}

export async function clearChat() {
  if (!currentSessionId) return;

  // Abort any active stream
  if (activeStreamController) {
    activeStreamController.abort();
    setActiveStreamController(null);
  }

  try {
    await fetch(`${API_BASE}/chat/sessions/${currentSessionId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
  } catch {}

  setCurrentSessionId(null);
  localStorage.removeItem("currentSessionId");

  // Reset processing state
  const processingIndicator = document.getElementById("processingIndicator");
  if (processingIndicator) processingIndicator.classList.remove("active");
  showTyping(false);

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

async function executeSend(message, { resend = false } = {}) {
  const myGeneration = nextSendGeneration();

  enableAutoScroll();
  showTyping(true);
  const progressElRef = { progressEl: null };

  const { disconnectLive } = await import("./live.js");
  disconnectLive();

  // Append user prompt FIRST so the tool-progress panel renders BELOW
  // it. Previously the tool-progress was appended before the user message
  // was added, putting the tools view above the prompt in the chat log.
  if (resend) {
    const messagesDiv = document.getElementById("chatMessages");
    const userMessages = messagesDiv.querySelectorAll(".message.user");
    let clickedMsg = null;
    for (const um of userMessages) {
      if (um.dataset.originalText === message) { clickedMsg = um; break; }
    }
    if (clickedMsg) {
      let next = clickedMsg.nextElementSibling;
      while (next) { const cur = next; next = cur.nextElementSibling; cur.remove(); }
    }
  } else {
    addMessage(message, "user");
  }

  // Now that the user message is in the DOM, append the tool-progress
  // panel beneath it.
  const immediateProgress = createToolProgress();
  progressElRef.progressEl = immediateProgress.progressEl;
  document.getElementById("chatMessages").appendChild(immediateProgress.progressEl);
  document.getElementById("processingIndicator").classList.add("active");
  const statusEl = document.getElementById("processingStatusText");
  if (statusEl) statusEl.textContent = "Processing your request...";
  scrollChatToBottom();

  if (activeStreamController) {
    markStreamingMessageInterrupted();
    activeStreamController.abort();
    setActiveStreamController(null);
  }

  try {
    const controller = new AbortController();
    setActiveStreamController(controller);

    const response = await fetch(`${API_BASE}/chat/stream`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        message,
        mode: currentMode,
        userId: "web-user",
        sessionId: currentSessionId,
        includeMemory: true,
        includeTools: true,
        ...(resend ? { resend: true } : {}),
      }),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      setActiveStreamController(null);
      showTyping(false);
      finalizeToolProgress();
      document.getElementById("processingIndicator")?.classList.remove("active");
      showLoginOverlay();
      return;
    }

    if (!response.ok) {
      setActiveStreamController(null);
      showTyping(false);
      finalizeToolProgress();
      document.getElementById("processingIndicator")?.classList.remove("active");
      let errorText = `Server returned ${response.status}`;
      try {
        const errBody = await response.json();
        if (errBody.error || errBody.message) errorText = errBody.error || errBody.message;
      } catch {}
      addMessage("Error: " + errorText, "assistant");
      return;
    }

    const result = await handleStreamResponse(response, progressElRef);
    setActiveStreamController(null);

    finalizeToolProgress();
    document.getElementById("processingIndicator")?.classList.remove("active");
    showTyping(false);

    if (result.error) return;

    addCompletionMarker();

    if (result.roadmapTouched) loadRoadmaps();

    loadConversations();

    const { subscribeLive } = await import("./live.js");
    if (currentSessionId) subscribeLive(currentSessionId);
  } catch (error) {
    setActiveStreamController(null);
    finalizeToolProgress();
    const processingIndicator = document.getElementById("processingIndicator");
    if (processingIndicator) processingIndicator.classList.remove("active");
    if (myGeneration === sendGeneration) showTyping(false);
    if (error instanceof DOMException && error.name === "AbortError") return;
    console.error("Failed to send message:", error);
    if (myGeneration === sendGeneration) {
      const errMsg = error instanceof Error ? error.message : String(error);
      addMessage(
        "Failed to connect to the agent: " + errMsg + ". Please check that the server is running and try again.",
        "assistant",
      );
    }
    const { subscribeLive } = await import("./live.js");
    if (currentSessionId) subscribeLive(currentSessionId);
  }
}

export async function sendMessage() {
  const input = document.getElementById("messageInput");
  const message = input.value.trim();
  if (!message) return;

  const hist = [...messageHistory];
  if (hist[hist.length - 1] !== message) hist.push(message);
  setMessageHistory(hist);
  setHistoryIndex(-1);
  setDraftBeforeHistory("");
  input.value = "";
  autoResizeTextarea(input);

  await executeSend(message, { resend: false });
}

export async function resendMessage(message) {
  const hist = [...messageHistory];
  if (hist[hist.length - 1] !== message) hist.push(message);
  setMessageHistory(hist);
  setHistoryIndex(-1);

  await executeSend(message, { resend: true });
}
