import {
  API_BASE,
  currentSessionId,
  messageHistory,
  setCurrentSessionId,
  setMessageHistory,
  activeStreamController,
  setActiveStreamController,
  updateSessionHash,
} from "./state.js";
import { authHeaders } from "./auth.js";
import { addMessage, scrollChatToBottom, ensureScrollListener } from "./messages.js";

import { escapeHtml, escapeAttr } from "./utils.js";
import { readSessionHash } from "./state.js";

export function isMobile() {
  return window.innerWidth <= 768;
}

export function showChatView() {
  if (!isMobile()) return;
  document.querySelector(".chat-section").classList.add("active");
  document.querySelector(".panel-section").classList.add("hidden");
}

export function showPanelView() {
  if (!isMobile()) return;
  document.querySelector(".chat-section").classList.remove("active");
  document.querySelector(".panel-section").classList.remove("hidden");
}

export async function loadConversations() {
  try {
    const response = await fetch(`${API_BASE}/chat/sessions?userId=web-user`, {
      headers: authHeaders(),
    });
    const data = await response.json();
    const list = document.getElementById("conversationList");

    if (data.sessions && data.sessions.length > 0) {
      list.innerHTML = data.sessions
        .map((s) => {
          const isActive = s.id === currentSessionId;
          const date = new Date(s.updatedAt);
          const timeStr =
            date.toLocaleDateString() === new Date().toLocaleDateString()
              ? date.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : date.toLocaleDateString();
          return `
            <div class="conversation-item${isActive ? " active" : ""}" data-session-id="${escapeAttr(s.id)}" onclick="switchConversation('${escapeAttr(s.id)}')">
              <div class="conversation-info">
                <div class="conversation-title">${escapeHtml(s.title || "Untitled")} <span style="font-size: 10px; color: #888;">(${timeStr})</span></div>
                <div class="conversation-preview">${escapeHtml(s.preview || s.mode + " mode")}</div>
              </div>
              <button class="conversation-delete" onclick="event.stopPropagation(); deleteConversation('${escapeAttr(s.id)}')" title="Delete conversation">&#10005;</button>
              <button class="conversation-link" onclick="event.stopPropagation(); copyChatLink('${s.id}')" title="Copy link to this chat">&#128279;</button>
            </div>
          `;
        })
        .join("");

      if (!currentSessionId && data.sessions.length > 0) {
        // Prefer URL hash session ID, then localStorage
        const hashId = readSessionHash();
        const storedId = hashId || localStorage.getItem("currentSessionId");
        if (storedId && data.sessions.find((s) => s.id === storedId)) {
          switchConversation(storedId);
        }
      }
    } else {
      list.innerHTML =
        '<div style="padding: 12px; color: #666;">No conversations yet</div>';
    }
  } catch (error) {
    console.error("Failed to load conversations:", error);
  }
}

export async function switchConversation(sessionId) {
  // Abort any active stream from the previous session before switching
  if (activeStreamController) {
    activeStreamController.abort();
    setActiveStreamController(null);
  }

  setCurrentSessionId(sessionId);
  localStorage.setItem("currentSessionId", sessionId);
  updateSessionHash(sessionId);

  // Reset processing state from previous session
  const processingIndicator = document.getElementById("processingIndicator");
  if (processingIndicator) processingIndicator.classList.remove("active");
  const typingIndicator = document.getElementById("typingIndicator");
  if (typingIndicator) typingIndicator.classList.remove("active");

  const chatMessages = document.getElementById("chatMessages");
  chatMessages.innerHTML = "";

  try {
    const response = await fetch(
      `${API_BASE}/chat/sessions/${sessionId}/messages`,
      { headers: authHeaders() },
    );

    if (!response.ok) {
      setCurrentSessionId(null);
      localStorage.removeItem("currentSessionId");
      chatMessages.innerHTML = `
        <div class="message assistant">
          <div class="message-bubble">Session not found. Start a new conversation.</div>
        </div>
      `;
      loadConversations();
      return;
    }

    const data = await response.json();
    if (data.messages && data.messages.length > 0) {
      for (const msg of data.messages) {
        if (msg.role === "system" || msg.role === "tool") continue;
        if (
          msg.role === "assistant" &&
          (!msg.content || msg.content.trim() === "")
        )
          continue;
        addMessage(msg.content, msg.role, undefined, { scroll: false });
        if (msg.role === "user" && msg.content) {
          const hist = [...messageHistory];
          hist.push(msg.content);
          setMessageHistory(hist);
        }
      }
      requestAnimationFrame(() => {
        scrollChatToBottom(true);
        ensureScrollListener();
      });
    } else {
      chatMessages.innerHTML = `
        <div class="message assistant">
          <div class="message-bubble">Hello! How can I help you?</div>
        </div>
      `;
    }
  } catch {
    chatMessages.innerHTML = `
      <div class="message assistant">
        <div class="message-bubble">Failed to load conversation.</div>
      </div>
    `;
  }

  showChatView();
  loadConversations();

  const { subscribeLive } = await import("./live.js?v=8");
  subscribeLive(sessionId);
}

export async function newChat() {
  // Abort any active stream from the previous session
  if (activeStreamController) {
    activeStreamController.abort();
    setActiveStreamController(null);
  }

  setCurrentSessionId(null);
  localStorage.removeItem("currentSessionId");
  updateSessionHash(null);

  // Reset processing state from previous session
  const processingIndicator = document.getElementById("processingIndicator");
  if (processingIndicator) processingIndicator.classList.remove("active");
  const typingIndicator = document.getElementById("typingIndicator");
  if (typingIndicator) typingIndicator.classList.remove("active");

  const chatMessages = document.getElementById("chatMessages");
  chatMessages.innerHTML = `
    <div class="message assistant">
      <div class="message-bubble">
        Hello! I'm your AI Assistant. I can help you with productivity
        planning, engineering tasks, roadmap management, and much more.
        How can I assist you today?
      </div>
    </div>
  `;
  showChatView();
  loadConversations();

  const { disconnectLive } = await import("./live.js?v=8");
  disconnectLive();
}

export async function deleteConversation(sessionId) {
  const { autoAcceptDeletes, setAutoAcceptDeletes } =
    await import("./state.js");

  if (autoAcceptDeletes) {
    await performDeleteConversation(sessionId);
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.innerHTML = `
    <div class="confirm-dialog">
      <h3>Delete Conversation?</h3>
      <p>This will permanently delete this conversation and all its messages. This cannot be undone.</p>
      <label class="confirm-auto-accept">
        <input type="checkbox" id="autoAcceptCheck" />
        Don't ask again (hands-off mode)
      </label>
      <div class="confirm-actions">
        <button class="confirm-cancel" onclick="this.closest('.confirm-overlay').remove()">Cancel</button>
        <button class="confirm-danger" id="confirmDeleteBtn">Delete</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  overlay
    .querySelector("#confirmDeleteBtn")
    .addEventListener("click", async () => {
      if (overlay.querySelector("#autoAcceptCheck").checked) {
        setAutoAcceptDeletes(true);
      }
      overlay.remove();
      await performDeleteConversation(sessionId);
    });
}

async function performDeleteConversation(sessionId) {
  // Abort any active stream if deleting the current session
  if (activeStreamController) {
    activeStreamController.abort();
    setActiveStreamController(null);
  }

  try {
    await fetch(`${API_BASE}/chat/sessions/${sessionId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
  } catch {}

  if (currentSessionId === sessionId) {
    setCurrentSessionId(null);
    localStorage.removeItem("currentSessionId");

    // Reset processing state
    const processingIndicator = document.getElementById("processingIndicator");
    if (processingIndicator) processingIndicator.classList.remove("active");
    const typingIndicator = document.getElementById("typingIndicator");
    if (typingIndicator) typingIndicator.classList.remove("active");

    const chatMessages = document.getElementById("chatMessages");
    chatMessages.innerHTML = `
      <div class="message assistant">
        <div class="message-bubble">Conversation deleted. Start a new one or select another from the sidebar.</div>
      </div>
    `;
  }

  loadConversations();

}

export function copyChatLink(sessionId) {
  const url = `${window.location.origin}${window.location.pathname}#/chat/${sessionId}`;
  navigator.clipboard.writeText(url).then(() => {
    // Brief visual feedback
    const btn = document.querySelector(`.conversation-item[data-session-id="${sessionId}"] .conversation-link`);
    if (btn) {
      const original = btn.innerHTML;
      btn.innerHTML = "&#10003;";
      setTimeout(() => { btn.innerHTML = original; }, 1500);
    }
  }).catch(() => {
    // Fallback: select from prompt
    window.prompt("Copy this link:", url);
  });
}
