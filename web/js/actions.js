import {
  API_BASE,
  currentMode,
  activeStreamController,
  setActiveStreamController,
} from "./state.js";
import { authHeaders } from "./auth.js";
import { addMessage, showTyping } from "./messages.js";

export function openToolsModal() {
  const modal = document.getElementById("toolsModal");
  modal.style.display = "flex";
  loadToolsModal();
}

export function closeToolsModal() {
  document.getElementById("toolsModal").style.display = "none";
}

async function loadToolsModal() {
  const body = document.getElementById("toolsModalBody");
  body.innerHTML = '<div style="color:#888">Loading tools...</div>';

  const { loadTools, renderToolsHtml } = await import("./sidebar.js");
  const data = await loadTools();
  body.innerHTML = renderToolsHtml(data);
}

export function stopGeneration() {
  if (activeStreamController) {
    activeStreamController?.abort();
    setActiveStreamController(null);
  }
  const processingEl = document.getElementById("processingIndicator");
  processingEl.classList.remove("active");
  showTyping(false);

  const progressEls = document.querySelectorAll(".tool-progress");
  progressEls.forEach((el) => {
    const headerStatus = el.querySelector(
      ".tool-progress-header-left .tool-call-status",
    );
    if (headerStatus) {
      headerStatus.classList.remove("running");
      headerStatus.classList.add("error");
    }
    const headerText = el.querySelector(".tool-progress-header-left");
    if (headerText && headerStatus) {
      headerText.innerHTML = `
        <span class="tool-call-status error"></span>
        Stopped by user
      `;
    }
  });

  addMessage("Generation stopped by user.", "assistant");
}

export function exportChat() {
  const messages = document.querySelectorAll("#chatMessages .message");
  if (messages.length === 0) return;

  let md = `# Chat Export\n`;
  md += `**Exported:** ${new Date().toLocaleString()}\n`;
  md += `**Mode:** ${currentMode}\n\n---\n\n`;

  messages.forEach((msg) => {
    const bubble = msg.querySelector(".message-bubble");
    if (!bubble) return;
    const isUser = msg.classList.contains("user");
    const text = bubble.textContent.trim();
    if (!text) return;
    md += isUser
      ? `## You\n\n${text}\n\n`
      : `## Assistant\n\n${text}\n\n---\n\n`;
  });

  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `chat-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

export let calendarIcsUrl = "";
export let calendarWebcalUrl = "";

export async function openCalendarModal() {
  const modal = document.getElementById("calendarModal");
  modal.style.display = "flex";

  try {
    const response = await fetch(`${API_BASE}/calendar/subscribe`, {
      headers: authHeaders(),
    });
    const data = await response.json();
    calendarIcsUrl = data.subscription?.icsUrl || "";
    calendarWebcalUrl = data.subscription?.webcalUrl || "";
    document.getElementById("calendarUrl").textContent = calendarIcsUrl;
  } catch {
    document.getElementById("calendarUrl").textContent = "Failed to load URL";
  }
}

export function closeCalendarModal() {
  document.getElementById("calendarModal").style.display = "none";
}

export function copyCalendarUrl() {
  navigator.clipboard.writeText(calendarIcsUrl);
  const btn = document.querySelector("#calendarModal .copy-btn");
  btn.textContent = "Copied!";
  setTimeout(() => {
    btn.textContent = "Copy";
  }, 1500);
}

export function copyIcsUrl() {
  navigator.clipboard.writeText(calendarIcsUrl);
  showCopyFeedback("ICS URL copied");
}

export function copyWebcalUrl() {
  navigator.clipboard.writeText(calendarWebcalUrl);
  showCopyFeedback("webcal URL copied");
}

function showCopyFeedback(text) {
  const btn = document.querySelector("#calendarModal .copy-btn");
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = "Copy";
  }, 1500);
}
