import {
  currentMode,
  currentSessionId,
  authToken,
  messageHistory,
  historyIndex,
  draftBeforeHistory,
  activeStreamController,
  API_BASE,
  setCurrentSessionId,
  setHistoryIndex,
  setDraftBeforeHistory,
  setMessageHistory,
  setActiveStreamController,
} from "./state.js";
import { authHeaders } from "./auth.js";
import { escapeHtml, summarizeResult, autoResizeTextarea } from "./utils.js";
import { renderMarkdown } from "./markdown.js";

export function showTyping(show) {
  const indicator = document.getElementById("typingIndicator");
  if (show) {
    indicator.classList.add("active");
  } else {
    indicator.classList.remove("active");
  }
}

export function showError(message) {
  const chatMessages = document.getElementById("chatMessages");
  const errorDiv = document.createElement("div");
  errorDiv.className = "error";
  errorDiv.textContent = message;
  chatMessages.insertBefore(errorDiv, chatMessages.firstChild);
}

export function addMessage(content, type, thinking) {
  const messagesDiv = document.getElementById("chatMessages");
  const messageDiv = document.createElement("div");
  messageDiv.className = `message ${type}`;
  messageDiv.dataset.originalText = type === "user" ? content : "";

  const row = document.createElement("div");
  row.className = "message-row";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  if (type === "assistant") {
    let html = "";

    if (thinking && thinking.trim()) {
      const thinkingId = "think-" + Date.now();
      html += `<div class="thinking-section">`;
      html += `<div class="thinking-header" onclick="document.getElementById('${thinkingId}').classList.toggle('expanded'); document.getElementById('${thinkingId}-toggle').classList.toggle('expanded');">`;
      html += `<span class="thinking-toggle" id="${thinkingId}-toggle">&#9654;</span> Thinking`;
      html += `</div>`;
      html += `<div class="thinking-body" id="${thinkingId}">${escapeHtml(thinking)}</div>`;
      html += `</div>`;
    }

    html += renderMarkdown(content);
    bubble.innerHTML = html;
  } else {
    bubble.textContent = content;
  }

  row.appendChild(bubble);

  if (type === "user") {
    const refreshBtn = document.createElement("button");
    refreshBtn.className = "refresh-btn";
    refreshBtn.title = "Resend message";
    refreshBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
    refreshBtn.addEventListener("click", () => window.resendMessage(content));
    row.appendChild(refreshBtn);
  }

  messageDiv.appendChild(row);
  messagesDiv.appendChild(messageDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

export function createToolProgress() {
  const progressEl = document.createElement("div");
  progressEl.className = "tool-progress";

  const header = document.createElement("div");
  header.className = "tool-progress-header";
  header.innerHTML = `
    <span class="tool-progress-header-left">
      <span class="tool-call-status running"></span>
      AI Assistant is working...
    </span>
    <span style="display:flex;align-items:center;gap:6px;">
      <span class="tool-progress-count" data-count="0"></span>
      <span class="tool-progress-toggle">&#9654;</span>
    </span>
  `;

  const body = document.createElement("div");
  body.className = "tool-progress-body";

  header.addEventListener("click", () => {
    body.classList.toggle("expanded");
    header.querySelector(".tool-progress-toggle").classList.toggle("expanded");
  });

  progressEl.appendChild(header);
  progressEl.appendChild(body);

  return { statusDiv: null, progressEl };
}

export function addToolCall(id, name, params) {
  const progressEl = document.querySelector(".tool-progress:last-of-type");
  if (!progressEl) return;

  const body = progressEl.querySelector(".tool-progress-body");
  const item = document.createElement("div");
  item.className = "tool-call-item";
  item.dataset.toolId = id;

  const paramsStr =
    typeof params === "object"
      ? JSON.stringify(params, null, 2)
      : String(params);
  const shortParams =
    paramsStr.length > 200 ? paramsStr.slice(0, 200) + "..." : paramsStr;

  item.innerHTML = `
    <div class="tool-call-name">
      <span class="tool-call-status running"></span>
      ${escapeHtml(name)}
    </div>
    <div class="tool-call-params">${escapeHtml(shortParams)}</div>
  `;

  body.appendChild(item);

  const countEl = progressEl.querySelector(".tool-progress-count");
  const count = body.querySelectorAll(".tool-call-item").length;
  countEl.textContent = `${count} tool${count !== 1 ? "s" : ""}`;

  body.classList.add("expanded");
  progressEl.querySelector(".tool-progress-toggle").classList.add("expanded");

  const chatMessages = document.getElementById("chatMessages");
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

export function completeToolCall(id, result) {
  const progressEl = document.querySelector(".tool-progress:last-of-type");
  if (!progressEl) return;

  const item = progressEl.querySelector(`[data-tool-id="${id}"]`);
  if (!item) return;

  const statusDot = item.querySelector(".tool-call-status");
  statusDot.classList.remove("running");
  statusDot.classList.add("done");

  const resultObj = typeof result === "object" ? result : null;
  const summaryText = summarizeResult(resultObj || result);
  const fullJson = resultObj ? JSON.stringify(result, null, 2) : String(result);
  const truncJson =
    fullJson.length > 2000 ? fullJson.slice(0, 2000) + "..." : fullJson;

  const resultDiv = document.createElement("div");
  resultDiv.className = "tool-call-result";
  if (resultObj && fullJson.length > 200) {
    const resultId =
      "result-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    resultDiv.innerHTML = `<span>${escapeHtml(summaryText)}</span> <span class="result-toggle" data-result-id="${resultId}" style="color:#667eea;cursor:pointer;font-size:11px;margin-left:4px;">[show raw]</span><pre id="${resultId}" style="display:none;margin:4px 0 0;padding:6px;background:#1e1e2e;color:#cdd6f4;border-radius:4px;font-size:11px;max-height:1200px;overflow:auto;white-space:pre-wrap;word-break:break-all;">${escapeHtml(truncJson)}</pre>`;
  } else {
    resultDiv.textContent = summaryText;
  }
  item.appendChild(resultDiv);

  const chatMessages = document.getElementById("chatMessages");
  chatMessages.scrollTop = chatMessages.scrollHeight;

  const body = progressEl.querySelector(".tool-progress-body");
  const running = body.querySelectorAll(".tool-call-status.running");
  if (running.length === 0) {
    const headerStatus = progressEl.querySelector(
      ".tool-progress-header-left .tool-call-status",
    );
    if (headerStatus) {
      headerStatus.classList.remove("running");
      headerStatus.classList.add("done");
    }
    const headerText = progressEl.querySelector(".tool-progress-header-left");
    if (headerText) {
      headerText.innerHTML = `
        <span class="tool-call-status done"></span>
        Generating response...
      `;
    }
  }
}

export function finalizeToolProgress() {
  const progressEls = document.querySelectorAll(".tool-progress");
  progressEls.forEach((el) => {
    const headerText = el.querySelector(".tool-progress-header-left");
    const headerStatus = el.querySelector(
      ".tool-progress-header-left .tool-call-status",
    );
    if (headerStatus) {
      headerStatus.classList.remove("running");
      headerStatus.classList.add("done");
    }
    if (headerText) {
      headerText.innerHTML = `
        <span class="tool-call-status done"></span>
        Completed
      `;
    }
    const body = el.querySelector(".tool-progress-body");
    if (body) {
      body.classList.remove("expanded");
    }
    const toggle = el.querySelector(".tool-progress-toggle");
    if (toggle) {
      toggle.classList.remove("expanded");
    }
  });
}
