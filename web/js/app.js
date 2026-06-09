import {
  API_BASE,
  currentMode,
  messageHistory,
  historyIndex,
  draftBeforeHistory,
  setCurrentMode,
  setCurrentSessionId,
  setHistoryIndex,
  setDraftBeforeHistory,
  setMessageHistory,
} from "./state.js";
import { authHeaders, checkAuth, login, logout } from "./auth.js";
import {
  sendMessage,
  resendMessage,
  clearChat,
  initializeChat,
} from "./chat.js";
import {
  loadRoadmaps,
  viewRoadmap,
  quickAction,
  toggleTodoPanel,
  editQuickAction,
  saveQuickActionPrompt,
  resetQuickActionPrompt,
  closeEditPromptModal,
  toggleWorkItemsPanel,
  toggleSection,
} from "./sidebar.js";
import {
  loadConversations,
  switchConversation,
  newChat,
  deleteConversation,
  showChatView,
  showPanelView,
  copyChatLink,
} from "./conversations.js";
import {
  openToolsModal,
  closeToolsModal,
  stopGeneration,
  exportChat,
  openCalendarModal,
  closeCalendarModal,
  copyCalendarUrl,
  copyIcsUrl,
  copyWebcalUrl,
} from "./actions.js";
import { autoResizeTextarea } from "./utils.js";
import { readSessionHash } from "./state.js";

let _agentRunsPage = null;
async function getAgentRunsPage() {
  if (!_agentRunsPage) {
    const mod = await import("./agent-runs.js");
    _agentRunsPage = mod.default;
  }
  return _agentRunsPage;
}

async function loadBuildVersion() {
  const versionEl = document.getElementById("buildVersion");
  if (!versionEl) return;
  try {
    const response = await fetch(`${API_BASE}/health`, {
      headers: authHeaders(),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const commit = data.git?.commit || "unknown";
    const dirty = data.git?.dirty ? "+dirty" : "";
    versionEl.textContent = `commit ${commit}${dirty}`;
    versionEl.title = data.version ? `Version ${data.version}` : "";
  } catch {
    versionEl.textContent = "commit unavailable";
  }
}

window.login = login;
window.logout = logout;
window.clearChat = clearChat;
window.sendMessage = sendMessage;
window.resendMessage = resendMessage;
window.stopGeneration = stopGeneration;
window.exportChat = exportChat;
window.openCalendarModal = openCalendarModal;
window.closeCalendarModal = closeCalendarModal;
window.copyCalendarUrl = copyCalendarUrl;
window.copyIcsUrl = copyIcsUrl;
window.copyWebcalUrl = copyWebcalUrl;
window.openToolsModal = openToolsModal;
window.closeToolsModal = closeToolsModal;
window.viewRoadmap = viewRoadmap;
window.quickAction = quickAction;
window.editQuickAction = editQuickAction;
window.saveQuickActionPrompt = saveQuickActionPrompt;
window.resetQuickActionPrompt = resetQuickActionPrompt;
window.closeEditPromptModal = closeEditPromptModal;
window.newChat = newChat;
window.deleteConversation = deleteConversation;
window.switchConversation = switchConversation;
window.copyChatLink = copyChatLink;
window.showChatView = showChatView;
window.showPanelView = showPanelView;
window.toggleTodoPanel = toggleTodoPanel;
window.toggleWorkItemsPanel = toggleWorkItemsPanel;
window.toggleSection = toggleSection;

window._arShowPage = async function() {
  const section = document.getElementById("agentRunsSection");
  const panel = document.querySelector(".panel-section");
  if (section && panel) {
    panel.querySelectorAll(":scope > :not(#agentRunsSection)").forEach(el => el.style.display = "none");
    section.style.display = "";
    section.classList.add("active");
    const page = await getAgentRunsPage();
    page.init();
  }
};

window._arHidePage = async function() {
  const section = document.getElementById("agentRunsSection");
  const panel = document.querySelector(".panel-section");
  if (section && panel) {
    section.style.display = "none";
    section.classList.remove("active");
    panel.querySelectorAll(":scope > :not(#agentRunsSection)").forEach(el => el.style.display = "");
    const page = await getAgentRunsPage();
    page.destroy();
  }
};

window.toggleToolCategory = function(catId) {
  const el = document.getElementById(catId);
  if (el) {
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  }
};

document.addEventListener("click", function (e) {
  if (e.target.classList && e.target.classList.contains("result-toggle")) {
    const resultId = e.target.getAttribute("data-result-id");
    const pre = document.getElementById(resultId);
    if (pre) {
      const isVisible = pre.style.display !== "none";
      pre.style.display = isVisible ? "none" : "block";
      e.target.textContent = isVisible ? "[show raw]" : "[hide raw]";
    }
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  loadBuildVersion();

  // Prime currentSessionId from the URL hash BEFORE checkAuth so that
  // initializeChat (called inside checkAuth) loads the right session and we
  // avoid a double-load race between initializeChat and switchConversation.
  const hashSessionId = readSessionHash();
  if (hashSessionId) {
    setCurrentSessionId(hashSessionId);
    localStorage.setItem("currentSessionId", hashSessionId);
  }

  await checkAuth();

  // Collapse noisy sections by default on mobile so conversations are visible
  if (window.innerWidth <= 768) {
    ["quickActions", "roadmaps"].forEach((id) => {
      const panel = document.getElementById(`${id}Panel`);
      const arrow = document.getElementById(`${id}Arrow`);
      if (panel) panel.style.display = "none";
      if (arrow) arrow.style.transform = "rotate(0deg)";
    });
  }

  const workItemsSection = document.getElementById("workItemsSection");
  if (workItemsSection && authHeaders()) {
    workItemsSection.style.display = "block";
  }

  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".mode-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      setCurrentMode(btn.dataset.mode);
    });
  });

  document.getElementById("sendBtn").addEventListener("click", sendMessage);
  const messageInput = document.getElementById("messageInput");
  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
    if (e.key === "ArrowUp" && !e.shiftKey) {
      const textarea = e.target;
      const isAtStart =
        textarea.selectionStart === 0 && textarea.selectionEnd === 0;
      const isEmpty = textarea.value.length === 0;
      if (isAtStart || isEmpty) {
        e.preventDefault();
        const hi = historyIndex;
        if (hi === -1) {
          setDraftBeforeHistory(textarea.value);
        }
        if (messageHistory.length > 0 && hi < messageHistory.length - 1) {
          const newIdx = hi + 1;
          setHistoryIndex(newIdx);
          textarea.value = messageHistory[messageHistory.length - 1 - newIdx];
          autoResizeTextarea(textarea);
          textarea.setSelectionRange(0, 0);
        }
      }
    }
    if (e.key === "ArrowDown" && !e.shiftKey) {
      const textarea = e.target;
      const isAtEnd =
        textarea.selectionStart === textarea.value.length &&
        textarea.selectionEnd === textarea.value.length;
      if (isAtEnd) {
        e.preventDefault();
        const hi = historyIndex;
        if (hi > 0) {
          const newIdx = hi - 1;
          setHistoryIndex(newIdx);
          textarea.value = messageHistory[messageHistory.length - 1 - newIdx];
        } else if (hi === 0) {
          setHistoryIndex(-1);
          textarea.value = draftBeforeHistory;
        }
        autoResizeTextarea(textarea);
        const len = textarea.value.length;
        textarea.setSelectionRange(len, len);
      }
    }
  });
  messageInput.addEventListener("input", () =>
    autoResizeTextarea(messageInput),
  );

  document.getElementById("password").addEventListener("keypress", (e) => {
    if (e.key === "Enter") login();
  });
  document.getElementById("username").addEventListener("keypress", (e) => {
    if (e.key === "Enter") document.getElementById("password").focus();
  });

  document.getElementById("calendarModal").addEventListener("click", (e) => {
    if (e.target.id === "calendarModal") closeCalendarModal();
  });

  document.getElementById("toolsModal").addEventListener("click", (e) => {
    if (e.target.id === "toolsModal") closeToolsModal();
  });

  // Handle browser back/forward via hash changes
  window.addEventListener("hashchange", () => {
    const hashId = readSessionHash();
    if (hashId) {
      switchConversation(hashId);
    } else {
      newChat();
    }
  });
});
