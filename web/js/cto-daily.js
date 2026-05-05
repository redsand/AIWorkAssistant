import { authHeaders } from "./auth.js";
import { renderMarkdown } from "./markdown.js";

const API_BASE = window.location.origin;

let lastSuggestedWorkItems = [];

function boolValue(id) {
  const el = document.getElementById(id);
  return el ? el.checked : true;
}

function valueOf(id) {
  const el = document.getElementById(id);
  return el ? el.value : "";
}

export function initCtoDailyPage() {
  const dateInput = document.getElementById("ctoDate");
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().slice(0, 10);
  }
}

export async function generateCtoDailyCommand() {
  initCtoDailyPage();
  const resultEl = document.getElementById("ctoDailyResult");
  const createBtn = document.getElementById("ctoCreateWorkItemsBtn");
  resultEl.innerHTML = '<div class="loading">Generating daily command...</div>';
  if (createBtn) createBtn.disabled = true;
  lastSuggestedWorkItems = [];

  try {
    const params = new URLSearchParams({
      userId: "tim",
      date: valueOf("ctoDate"),
      daysBack: valueOf("ctoDaysBack") || "7",
      includeCalendar: String(boolValue("ctoIncludeCalendar")),
      includeJira: String(boolValue("ctoIncludeJira")),
      includeGitLab: String(boolValue("ctoIncludeGitLab")),
      includeGitHub: String(boolValue("ctoIncludeGitHub")),
      includeRoadmap: String(boolValue("ctoIncludeRoadmap")),
      includeWorkItems: String(boolValue("ctoIncludeWorkItems")),
      includeJitbit: String(boolValue("ctoIncludeJitbit")),
    });
    const response = await fetch(`${API_BASE}/api/cto/daily-command-center?${params.toString()}`, {
      headers: authHeaders(),
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      resultEl.innerHTML = `<div class="error">${data.error || "Failed to generate daily command."}</div>`;
      return;
    }
    lastSuggestedWorkItems = data.suggestedWorkItems || [];
    resultEl.innerHTML = `<div class="cto-markdown">${renderMarkdown(data.markdown || "")}</div>`;
    if (createBtn) {
      createBtn.disabled = lastSuggestedWorkItems.length === 0;
      createBtn.textContent = lastSuggestedWorkItems.length > 0
        ? `Create ${lastSuggestedWorkItems.length} Suggested Work Items`
        : "No Suggested Work Items";
    }
  } catch {
    resultEl.innerHTML = '<div class="error">Failed to generate daily command.</div>';
  }
}

export async function createCtoSuggestedWorkItems() {
  if (lastSuggestedWorkItems.length === 0) return;
  const createBtn = document.getElementById("ctoCreateWorkItemsBtn");
  const statusEl = document.getElementById("ctoCreateStatus");
  if (createBtn) createBtn.disabled = true;
  if (statusEl) statusEl.textContent = "Creating work items...";

  try {
    const response = await fetch(`${API_BASE}/api/cto/daily-command-center/create-work-items`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ items: lastSuggestedWorkItems }),
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      if (statusEl) statusEl.textContent = data.error || "Failed to create work items.";
      if (createBtn) createBtn.disabled = false;
      return;
    }
    if (statusEl) statusEl.textContent = `Created ${data.created?.length || 0} work item(s).`;
    lastSuggestedWorkItems = [];
    if (createBtn) {
      createBtn.textContent = "Suggested Work Items Created";
      createBtn.disabled = true;
    }
    if (window.refreshWorkItems) window.refreshWorkItems();
  } catch {
    if (statusEl) statusEl.textContent = "Failed to create work items.";
    if (createBtn) createBtn.disabled = false;
  }
}

export function showCtoDailyPage() {
  const section = document.getElementById("ctoDailySection");
  const panel = document.querySelector(".panel-section");
  if (section && panel) {
    panel.querySelectorAll(":scope > :not(#ctoDailySection)").forEach((el) => {
      el.style.display = "none";
    });
    section.style.display = "";
    initCtoDailyPage();
  }
}

export function hideCtoDailyPage() {
  const section = document.getElementById("ctoDailySection");
  const panel = document.querySelector(".panel-section");
  if (section && panel) {
    section.style.display = "none";
    panel.querySelectorAll(":scope > :not(#ctoDailySection)").forEach((el) => {
      el.style.display = "";
    });
  }
}

window.showCtoDailyPage = showCtoDailyPage;
window.hideCtoDailyPage = hideCtoDailyPage;
window.generateCtoDailyCommand = generateCtoDailyCommand;
window.createCtoSuggestedWorkItems = createCtoSuggestedWorkItems;
