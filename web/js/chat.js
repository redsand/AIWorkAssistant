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
import {
  handleReportSlashCommand,
  installReportDownloadInterceptor,
} from "./reports-client.js";
import { startIngestionBadgePolling } from "./ingestion-badge.js";
import { handleKgSlashCommand } from "./kg-client.js";
import { installKgTypeahead } from "./kg-typeahead.js";
import {
  installFileAttachmentUI,
  installDownloadInterceptor,
  applyAttachmentsToMessage,
} from "./file-attachments.js";
import { installSteerButton, sendSteer } from "./chat-steer.js";

/**
 * Update the send button's label between "Send" (idle) and "Steer"
 * (job in flight). Called whenever activeStreamController flips so the
 * user knows that pressing Enter mid-stream injects into the running
 * chat instead of starting a fresh turn. Keeping the label on the same
 * button (rather than a separate Steer control) is what the user asked
 * for — one input, one action button, contextual behavior.
 */
function updateSendButtonLabel() {
  const btn = document.getElementById("sendBtn");
  if (!btn) return;
  if (activeStreamController) {
    btn.textContent = "Steer";
    btn.title = "Inject a steer into the running chat (Enter)";
    btn.dataset.mode = "steer";
    // is-steer triggers the amber palette that used to live on the
    // dedicated #steerBtn — same visual cue, now applied to the main
    // send button so the user can see at a glance that the next
    // keystroke is a steer, not a fresh turn.
    btn.classList.add("is-steer");
  } else {
    btn.textContent = "Send";
    btn.title = "Send message (Enter)";
    btn.dataset.mode = "send";
    btn.classList.remove("is-steer");
  }
}

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


// Providers that have user-saved remote endpoints. The host pill is hidden
// for everything else so the chat header stays uncluttered.
const REMOTEABLE_PROVIDERS = new Set(["ollama"]);

// In-memory cache of the saved host list, populated by loadHostsForProvider.
// Kept around so the gear button knows which row to edit without re-fetching.
let _hostCache = [];

function setProviderControlsDisabled(disabled) {
  const providerSelect = document.getElementById("providerSelect");
  const modelSelect = document.getElementById("modelSelect");
  const hostSelect = document.getElementById("hostSelect");
  if (providerSelect) providerSelect.disabled = disabled;
  if (modelSelect) modelSelect.disabled = disabled;
  if (hostSelect) hostSelect.disabled = disabled;
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

/**
 * Push the (provider, model, hostId) tuple to the server. hostId is opt-in:
 *   - undefined → keep whatever's currently persisted for this provider
 *   - null      → explicitly clear (back to server env defaults)
 *   - "abc..."  → switch to that saved host (will override OLLAMA_API_URL etc.)
 */
async function setRuntimeProvider(provider, model, hostId) {
  setProviderControlsDisabled(true);
  try {
    const payload = { provider, model: model || undefined };
    if (hostId !== undefined) payload.hostId = hostId;
    const response = await fetch(`${API_BASE}/chat/provider`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
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

// ─── Host pill (saved provider hosts, e.g. LAN Ollama box) ─────────────────

const HOST_SENTINEL_ADD = "__add_new__";

/**
 * Populate the host pill for the active provider. Hidden when the provider
 * doesn't expose remote hosts (everything but ollama today). The last option
 * is always "+ Add new host…" so users can create one inline without
 * leaving the chat.
 */
async function loadHostsForProvider(provider, selectedHostId) {
  const hostSelect = document.getElementById("hostSelect");
  const hostManageBtn = document.getElementById("hostManageBtn");
  if (!hostSelect || !hostManageBtn) return;
  // host-modal.js may not be loaded (tests, pages that don't need it).
  // Bail quietly rather than crashing the whole provider-controls init.
  if (!window.HostModal) {
    hostSelect.hidden = true;
    hostManageBtn.hidden = true;
    return;
  }

  if (!REMOTEABLE_PROVIDERS.has(provider)) {
    hostSelect.hidden = true;
    hostManageBtn.hidden = true;
    _hostCache = [];
    return;
  }
  hostSelect.hidden = false;
  hostManageBtn.hidden = false;
  // setProviderControlsDisabled(true) at init blanket-disabled all three
  // controls and only re-enables providerSelect + modelSelect explicitly.
  // Re-enable hostSelect here so the user can actually pick a saved host;
  // otherwise it's stuck disabled after every initializeProviderControls()
  // call.
  hostSelect.disabled = false;

  try {
    _hostCache = await window.HostModal.list(provider);
  } catch (err) {
    console.warn("Failed to load provider hosts:", err);
    _hostCache = [];
  }

  hostSelect.innerHTML = "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "Default (server env)";
  hostSelect.appendChild(def);
  for (const h of _hostCache) {
    const opt = document.createElement("option");
    opt.value = h.id;
    opt.textContent = h.name;
    opt.title = `${h.baseUrl}${h.notes ? " — " + h.notes : ""}`;
    hostSelect.appendChild(opt);
  }
  // If the server says this host is active but the GET /api/provider-hosts
  // call returned without it (intermittent fetch failure, race during
  // tsx-watch restart, etc.), insert a placeholder option so the native
  // <select> can hold the value. Without this, .value = <missing-id>
  // silently fails and the select snaps back to "Default" — which the
  // user perceives as the host selection not sticking.
  if (selectedHostId && !_hostCache.some((h) => h.id === selectedHostId)) {
    const ghost = document.createElement("option");
    ghost.value = selectedHostId;
    ghost.textContent = `(saved host — refresh to see name)`;
    ghost.style.fontStyle = "italic";
    hostSelect.appendChild(ghost);
  }
  const addOpt = document.createElement("option");
  addOpt.value = HOST_SENTINEL_ADD;
  addOpt.textContent = "+ Add new host…";
  hostSelect.appendChild(addOpt);

  hostSelect.value = selectedHostId || "";
  // Gear always enabled. When a host is selected → edit/delete that host.
  // When "Default" is selected → opens add-mode (the same as picking the
  // "+ Add new host…" sentinel from the dropdown). Tooltip reflects which
  // mode it'll open in.
  if (hostManageBtn) {
    const hasSelection = !!hostSelect.value && hostSelect.value !== HOST_SENTINEL_ADD;
    hostManageBtn.disabled = false;
    hostManageBtn.title = hasSelection
      ? "Edit / delete the selected host"
      : "Add a new provider host";
  }
}

function getActiveProvider() {
  const sel = document.getElementById("providerSelect");
  return sel?.value || "";
}

function getActiveHostId() {
  const sel = document.getElementById("hostSelect");
  return sel?.value && sel.value !== HOST_SENTINEL_ADD ? sel.value : "";
}

async function onHostSelectChange(e) {
  const value = e.target.value;
  if (value === HOST_SENTINEL_ADD) {
    // Restore the previous selection visually until the modal saves something
    e.target.value = "";
    window.HostModal.open({
      provider: getActiveProvider(),
      onSaved: async (saved) => {
        await loadHostsForProvider(getActiveProvider(), saved.id);
        // Switch the chat runtime to the new host immediately
        await setRuntimeProvider(getActiveProvider(), undefined, saved.id);
      },
    });
    return;
  }
  // Switching to a saved host (or back to default) — server will pick the
  // first model from the new host's list automatically when model=undefined.
  await setRuntimeProvider(getActiveProvider(), undefined, value || null);
}

function onHostManageClick() {
  const currentId = getActiveHostId();
  if (!currentId) {
    // No host selected — gear shouldn't have been clickable, but in case
    // someone bypasses the disabled state, route to add-new instead of
    // doing nothing.
    onHostAddClick();
    return;
  }
  const host = _hostCache.find((h) => h.id === currentId) || null;
  window.HostModal.open({
    provider: getActiveProvider(),
    host,
    onSaved: async (saved) => {
      await loadHostsForProvider(getActiveProvider(), saved.id);
      await setRuntimeProvider(getActiveProvider(), undefined, saved.id);
    },
    onDeleted: async (deletedId) => {
      await loadHostsForProvider(
        getActiveProvider(),
        currentId === deletedId ? "" : currentId,
      );
      if (currentId === deletedId) {
        // We just deleted the active host; revert to env defaults.
        await setRuntimeProvider(getActiveProvider(), undefined, null);
      }
    },
  });
}

/** Always opens the modal in add mode regardless of selection state. */
function onHostAddClick() {
  window.HostModal.open({
    provider: getActiveProvider(),
    host: null,
    onSaved: async (saved) => {
      await loadHostsForProvider(getActiveProvider(), saved.id);
      await setRuntimeProvider(getActiveProvider(), undefined, saved.id);
    },
  });
}

async function initializeProviderControls(refreshHealth = true) {
  const providerSelect = document.getElementById("providerSelect");
  const modelSelect = document.getElementById("modelSelect");
  const hostSelect = document.getElementById("hostSelect");
  const hostManageBtn = document.getElementById("hostManageBtn");
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
    // Saved hosts are provider-scoped; server-side setProvider already
    // clears the persisted hostId when the provider changes, so we omit
    // hostId here rather than sending an explicit null (keeps the existing
    // provider-controls tests happy).
    const models = await loadModelsForProvider(providerSelect.value);
    await setRuntimeProvider(providerSelect.value, models[0] || "");
  };
  modelSelect.onchange = async () => {
    await setRuntimeProvider(providerSelect.value, modelSelect.value);
  };

  // Host pill: populated only for providers that support remote hosts.
  // hostSelect handler is reassigned on every init so the closure captures the
  // current cache; idempotent across multiple init() passes.
  if (hostSelect) {
    await loadHostsForProvider(data.active, data.hostId);
    hostSelect.onchange = onHostSelectChange;
  }
  if (hostManageBtn) hostManageBtn.onclick = onHostManageClick;

  if (refreshHealth) await updateProviderHealth();
}

function updateTokenUsageDisplay(totalTokens) {
  const el = document.getElementById("tokenUsage");
  if (!el) return;
  el.textContent = `${totalTokens.toLocaleString()} tokens`;
  el.style.display = totalTokens > 0 ? "inline" : "none";
}

async function fetchTokenUsage() {
  if (!currentSessionId) return;
  try {
    const response = await fetch(`${API_BASE}/chat/usage?sessionId=${encodeURIComponent(currentSessionId)}`, {
      headers: authHeaders(),
    });
    if (!response.ok) return;
    const data = await response.json();
    updateTokenUsageDisplay(data.totalTokens);
  } catch (e) { /* silent fail -- usage display is non-critical */ }
}

// Fetch usage on load and poll while the page is open
fetchTokenUsage();
setInterval(fetchTokenUsage, 10_000);

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

let reportInterceptorInstalled = false;

// Listen once for stream-controller changes and refresh the Send/Steer
// label in one place. Putting the listener at module scope (not inside
// initializeChat) means it survives soft reinitializations and is
// installed exactly once per page lifetime.
if (typeof window !== "undefined") {
  window.addEventListener("activeStreamControllerChange", () => {
    updateSendButtonLabel();
  });
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
  if (!reportInterceptorInstalled) {
    installReportDownloadInterceptor();
    reportInterceptorInstalled = true;
  }
  // Poll cold-start ingestion progress until isReady=true.
  startIngestionBadgePolling();
  // KG type-ahead: install once on the chat input. Cache warms on this call.
  const messageInput = document.getElementById("messageInput");
  if (messageInput) installKgTypeahead(messageInput);
  // File attachment (multi-upload) + download interceptor + chat steer
  installFileAttachmentUI();
  installDownloadInterceptor();
  installSteerButton();

  // Reflect the initial idle state on the send button — the listener at
  // module scope handles every subsequent transition.
  updateSendButtonLabel();

  const { subscribeLive } = await import("./live.js");
  if (currentSessionId) {
    subscribeLive(currentSessionId);
  }
}

async function loadChatHistory() {
  // No auto-pinning to the most-recent session. If currentSessionId isn't
  // already set (from URL hash or a prior switchConversation), start in
  // clean New-Chat mode — the sidebar still lets the user pick an old
  // session explicitly. Previously this routine grabbed sessions[0] and
  // pinned the user to it, which made later "+ New Chat" → type → submit
  // sequences land in the silently-restored old chat under races.
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
  updateTokenUsageDisplay(0);

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
    fetchTokenUsage();

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
  let message = input.value.trim();
  if (!message) return;

  // Mid-stream: the chat is processing, so this submission is a steer.
  // Read activeStreamController via the live ES-module binding so we
  // pick up the latest value even if executeSend just set it. The
  // textarea clears before the network call so the user can immediately
  // queue a second steer; rollback on failure happens inside sendSteer.
  if (activeStreamController) {
    const hist = [...messageHistory];
    if (hist[hist.length - 1] !== message) hist.push(message);
    setMessageHistory(hist);
    setHistoryIndex(-1);
    setDraftBeforeHistory("");
    input.value = "";
    autoResizeTextarea(input);
    await sendSteer(message);
    return;
  }

  // Prepend any queued file attachments as a structured preamble so the
  // model sees the paths and can open them via local.read_file.
  message = applyAttachmentsToMessage(message);

  const hist = [...messageHistory];
  if (hist[hist.length - 1] !== message) hist.push(message);
  setMessageHistory(hist);
  setHistoryIndex(-1);
  setDraftBeforeHistory("");
  input.value = "";
  autoResizeTextarea(input);

  // /report — generate a report for the current session without going through
  // the model. The handler returns true if it consumed the command.
  if (await handleReportSlashCommand(message)) return;

  // /kg — instant knowledge-graph search. Bypasses the LLM entirely; results
  // come from the in-memory cache (or REST when the cache misses).
  if (await handleKgSlashCommand(message)) return;

  // /clear — drop the current session and start fresh. Mirrors the
  // Clear Chat button so users have a keyboard-only path.
  if (message.trim() === "/clear") {
    await clearChat();
    return;
  }

  // /compact — ask the server to summarize the current session, replace
  // the message history with the summary, and re-render. Saves context
  // budget on long conversations without losing topic continuity.
  if (message.trim() === "/compact") {
    await compactChat();
    return;
  }

  await executeSend(message, { resend: false });
}

/**
 * Trigger server-side summarization of the current session and replace
 * the in-memory message list with the single summary stub. Re-fetches
 * messages so the visual chat matches what the model will see next turn.
 */
async function compactChat() {
  if (!currentSessionId) {
    addMessage("No active chat to compact. Send a message first.", "assistant");
    return;
  }
  addMessage("Compacting conversation… this can take 10–30s on a long session.", "assistant");
  try {
    const res = await fetch(`${API_BASE}/chat/sessions/${currentSessionId}/compact`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      addMessage(
        "Compact failed: " + (body?.error || res.statusText),
        "assistant",
      );
      return;
    }
    const data = await res.json();
    // Replace the visible chat history with greeting + summary so the
    // user sees what the model will now see. Subsequent messages append
    // beneath as normal.
    const chatMessages = document.getElementById("chatMessages");
    chatMessages.innerHTML = "";
    addMessage(
      "✓ Conversation compacted. " +
        `${data.originalCount ?? "previous"} messages → 1 summary ` +
        `(${data.summary?.length ?? "?"} chars). Continue chatting; the summary ` +
        "now anchors the model's context.",
      "assistant",
    );
    if (data.summary) {
      addMessage("**Session summary**\n\n" + data.summary, "assistant");
    }
  } catch (err) {
    addMessage(
      "Compact failed: " + (err instanceof Error ? err.message : String(err)),
      "assistant",
    );
  }
}

export async function resendMessage(message) {
  const hist = [...messageHistory];
  if (hist[hist.length - 1] !== message) hist.push(message);
  setMessageHistory(hist);
  setHistoryIndex(-1);

  await executeSend(message, { resend: true });
}
