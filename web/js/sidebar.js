import {
  currentSessionId,
  messageHistory,
  setCurrentSessionId,
  setMessageHistory,
} from "./state.js";
import { authHeaders } from "./auth.js";
import { addMessage, showError } from "./messages.js";
import { escapeHtml, escapeAttr } from "./utils.js";

export async function loadRoadmaps() {
  const API_BASE = window.location.origin;
  try {
    const response = await fetch(`${API_BASE}/api/roadmaps`, {
      headers: authHeaders(),
    });
    const data = await response.json();

    const roadmapList = document.getElementById("roadmapList");

    if (data.roadmaps && data.roadmaps.length > 0) {
      roadmapList.innerHTML = data.roadmaps
        .map(
          (roadmap) =>
            `<div class="roadmap-item" style="cursor:pointer" onclick="viewRoadmap('${escapeAttr(roadmap.id)}','${escapeAttr(roadmap.name)}')">
              <div class="roadmap-name">${escapeHtml(roadmap.name)}</div>
              <div class="roadmap-meta">
                  ${escapeHtml(roadmap.type)} • ${escapeHtml(roadmap.status)} • ${new Date(roadmap.createdAt).toLocaleDateString()}
              </div>
            </div>
            `
        )
        .join("");
    } else {
      roadmapList.innerHTML =
        '<div style="padding: 12px; color: #666;">No roadmaps yet. Create one with the AI agent!</div>';
    }
  } catch (error) {
    console.error("Failed to load roadmaps:", error);
    document.getElementById("roadmapList").innerHTML =
      '<div style="padding: 12px; color: #c33;">Failed to load roadmaps</div>';
  }
}

export async function viewRoadmap(id, name) {
  const API_BASE = window.location.origin;
  try {
    const response = await fetch(`${API_BASE}/api/roadmaps/${id}`, {
      headers: authHeaders(),
    });
    const data = await response.json();
    if (!data.success) {
      addMessage(`Failed to load roadmap: ${escapeHtml(data.error)}`, "assistant");
      return;
    }
    const r = data.roadmap;
    let md = `## ${escapeHtml(r.name)}\n`;
    md += `**${escapeHtml(r.type)}** ∙ ${escapeHtml(r.status)}\n\n`;
    if (r.description) md += `${escapeHtml(r.description)}*\n\n`;
    md += `Start: ${escapeHtml(r.startDate)}${r.endDate ? " ∙ End: " + escapeHtml(r.endDate) : ""}\n`;
    if (r.milestones && r.milestones.length > 0) {
      md += `\n### Milestones\n`;
      for (const m of r.milestones) {
        const icon =
          m.status === "completed"
            ? "✅"
            : m.status === "blocked"
              ? "🚫"
              : "⏳";
        md += `- ${icon} **${escapeHtml(m.name)}** ∙ ${escapeHtml(m.status)} (target: ${m.targetDate ? new Date(m.targetDate).toLocaleDateString() : "TBD"})\n`;
        if (m.items && m.items.length > 0) {
          for (const item of m.items) {
            const ic =
              item.status === "done"
                ? "✔️"
                : item.status === "blocked"
                  ? "🚫"
                  : item.status === "in_progress"
                    ? "🔄"
                    : "⏸️";
            md += `  - ${ic} ${escapeHtml(item.title)} [${escapeHtml(item.priority)}]${item.jiraKey ? " (" + escapeHtml(item.jiraKey) + ")" : ""}\n`;
          }
        }
      }
    } else {
      md += `\n*No milestones yet.*\n`;
    }
    addMessage(md, "assistant");
  } catch (error) {
    addMessage("Failed to load roadmap details.", "assistant");
  }
}

export async function loadTools() {
  const API_BASE = window.location.origin;
  const { currentMode } = await import("./state.js");
  try {
    const response = await fetch(`${API_BASE}/chat/tools?mode=${currentMode}`, {
      headers: authHeaders(),
    });
    const data = await response.json();

    return data;
  } catch (error) {
    return null;
  }
}

export function renderToolsHtml(data) {
  if (!data || !data.success || !data.categories) {
    return '<div style="color:#888">Failed to load tools</div>';
  }

  const sortedCategories = Object.entries(data.categories).sort(([a], [b]) => a.localeCompare(b));
  let html = "";
  for (const [category, tools] of sortedCategories) {
    const toolArr = tools;
    const catId = `tool-cat-${escapeAttr(category.replace(/\s+/g, '-').toLowerCase())}`;
    html += `<div style="margin-bottom:8px">`;
    html += `<div style="font-weight:600;color:#555;margin-bottom:4px;text-transform:capitalize;cursor:pointer;display:flex;justify-content:space-between;align-items:center" onclick="toggleToolCategory('${catId}')">`;
    html += `<span>${escapeHtml(category)}</span>`;
    html += `<span style="font-size:11px;color:#999">${toolArr.length} tools ↕</span>`;
    html += `</div>`;
    html += `<div id="${catId}" style="display:none">`;
    for (const tool of toolArr) {
      const desc =
        tool.description.length > 80
          ? tool.description.substring(0, 80) + "..."
          : tool.description;
      html += `<div style="padding:2px 0 2px 8px;color:#666;border-left:2px solid #e5e7eb;margin-bottom:2px" title="${escapeAttr(tool.description)}">`;
      html += `<span style="color:#333;font-weight:500">${escapeHtml(tool.name)}</span>`;
      html += `<div style="font-size:11px;color:#999">${escapeHtml(desc)}</div>`;
      html += `</div>`;
    }
    html += `</div>`;
    html += `</div>`;
  }

  const totalTools = Object.values(data.categories).reduce(
    (sum, t) => sum + t.length,
    0,
  );
  html = `<div style="margin-bottom:8px;color:#888;font-size:11px">${totalTools} tools in ${Object.keys(data.categories).length} categories (click to expand)</div>` + html;
  return html;
}

let todoPanelLoaded = false;

export async function loadTodos() {
  const API_BASE = window.location.origin;
  try {
    const response = await fetch(`${API_BASE}/chat/todos`, {
      headers: authHeaders(),
    });
    const data = await response.json();
    const todoListEl = document.getElementById("todoList");
    const todoSection = document.getElementById("todoSection");

    if (!data.success || !data.lists || data.lists.length === 0) {
      todoSection.style.display = "none";
      return;
    }

    todoSection.style.display = "block";
    const todoPanel = document.getElementById("todoPanel");
    if (todoPanel) todoPanel.style.display = "block";
    const arrow = document.getElementById("todoToggleArrow");
    if (arrow) arrow.style.transform = "rotate(90deg)";

    let html = "";
    for (const list of data.lists) {
      const completed = list.progress?.completed || 0;
      const total = list.progress?.total || 0;
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

      html += `<div style="margin-bottom:10px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">`;
      html += `<div style="padding:6px 8px;background:#f9fafb;font-weight:500;display:flex;justify-content:space-between;align-items:center">`;
      html += `<span style="font-size:12px">${escapeHtml(list.title)}</span>`;
      html += `<span style="font-size:11px;color:#888">${completed}/${total} (${pct}%)</span>`;
      html += `</div>`;

      if (list.items) {
        for (const item of list.items) {
          const statusColors = {
            pending: "#d4d4d4",
            in_progress: "#fbbf24",
            completed: "#34d399",
            cancelled: "#f87171",
          };
          const dot = statusColors[item.status] || "#d4d4d4";
          html += `<div style="padding:4px 8px;display:flex;align-items:center;gap:6px;border-top:1px solid #f3f4f6">`;
          html += `<span style="width:6px;height:6px;border-radius:50%;background:${dot};flex-shrink:0"></span>`;
          html += `<span style="font-size:11px;color:${item.status === "completed" ? "#999" : "#333"};${item.status === "completed" ? "text-decoration:line-through" : ""}">${escapeHtml(item.content)}</span>`;
          html += `</div>`;
        }
      }

      html += `<div style="height:3px;background:#e5e7eb">`;
      html += `<div style="height:100%;width:${pct}%;background:#34d399;transition:width 0.3s"></div>`;
      html += `</div>`;
      html += `</div>`;
    }

    todoListEl.innerHTML = html;
  } catch {
    document.getElementById("todoList").innerHTML =
      '<div style="color:#888">Error loading tasks</div>';
  }
}

export function toggleTodoPanel() {
  const panel = document.getElementById("todoPanel");
  const arrow = document.getElementById("todoToggleArrow");
  if (panel && panel.style.display === "none") {
    panel.style.display = "block";
    if (arrow) arrow.style.transform = "rotate(90deg)";
    loadTodos();
  }
}

const QUICK_ACTION_PROMPTS = {
  "plan-week":
    "Plan my next 2 weeks. Pull in my Jira tickets, calendar events, GitHub issues, and any open tasks. Build a structured day-by-day schedule for the next 14 days — prioritize deadlines and high-impact work, protect time for deep focus blocks, and flag anything that looks overloaded or at risk.",
  "close-ticket":
    "I have committed and pushed my latest code changes to the repository. Please: 1) Retrieve my active Jira ticket and its acceptance criteria, 2) Review my recent commits to verify every requirement is addressed, 3) If fully complete — close the ticket and write a concise summary of what was changed and why, 4) If anything is missing — list each gap clearly and provide a ready-to-use coding prompt for each one so I can fill them in.",
  "show my tickets across all platforms":
    "Show me all my open tickets and issues across every platform — Jira, Jitbit support tickets, and GitHub issues. Group them by platform, showing ticket ID, title, status, and priority for each. Highlight anything urgent or overdue.",
  "hawk-ir-cases":
    "Pull the HAWK IR incident response security signals. List all high-risk and critical open cases that have not been escalated, active nodes, and any recent cases from the last 7 days. Group by risk level (critical first, then high). For each case show the name, risk level, status, owner, and how long it has been open. Flag any that are unowned or stale.",
  "open-work-items":
    "Show me all my open work items. Group them by status: blocked first, then active, then planned, then proposed. Within each group sort by priority (critical → high → medium → low). Highlight anything overdue. Also show a brief count summary at the top.",
  "entity-memory":
    "Search entity memory and show me what we know. List the 20 most recently updated entities across all types — customers, repos, Jira issues, decisions, and preferences. For each one show the type, name, summary, and how many facts we have stored. If any customers or companies have open facts, surface those first.",
  "ir-node-status":
    "List all active HAWK IR nodes. For each node show the hostname, platform, IP address, last seen timestamp, number of available tasks, and whether hybrid tools are registered. Flag any nodes that haven't been seen in the last 24 hours.",
};

function getCustomPrompts() {
  try {
    return JSON.parse(localStorage.getItem("customQuickActions") || "{}");
  } catch {
    return {};
  }
}

function resolvePrompt(action) {
  const custom = getCustomPrompts();
  return custom[action] ?? QUICK_ACTION_PROMPTS[action] ?? action;
}

export async function quickAction(action) {
  const { sendMessage } = await import("./chat.js");
  const { showChatView } = await import("./conversations.js");
  const input = document.getElementById("messageInput");
  input.value = resolvePrompt(action);
  showChatView();
  await sendMessage();
}

let _editingAction = null;

export function editQuickAction(action, label) {
  _editingAction = action;
  document.getElementById("editPromptLabel").textContent = label;
  document.getElementById("editPromptTextarea").value = resolvePrompt(action);
  const isCustom = action in getCustomPrompts();
  document.getElementById("editPromptResetBtn").style.display = isCustom ? "inline-flex" : "none";
  document.getElementById("editPromptModal").style.display = "flex";
  document.getElementById("editPromptTextarea").focus();
}

export function saveQuickActionPrompt() {
  if (!_editingAction) return;
  const value = document.getElementById("editPromptTextarea").value.trim();
  if (!value) return;
  const custom = getCustomPrompts();
  custom[_editingAction] = value;
  localStorage.setItem("customQuickActions", JSON.stringify(custom));
  closeEditPromptModal();
}

export function resetQuickActionPrompt() {
  if (!_editingAction) return;
  const custom = getCustomPrompts();
  delete custom[_editingAction];
  localStorage.setItem("customQuickActions", JSON.stringify(custom));
  closeEditPromptModal();
}

export function closeEditPromptModal() {
  document.getElementById("editPromptModal").style.display = "none";
  _editingAction = null;
}

let workItemsPanelLoaded = false;

export async function loadWorkItemsPanel() {
  const section = document.getElementById("workItemsSection");
  if (section) section.style.display = "block";

  if (!workItemsPanelLoaded) {
    const { loadWorkItems } = await import("./work-items.js");
    await loadWorkItems();
    workItemsPanelLoaded = true;
  }
}

export function toggleWorkItemsPanel() {
  const panel = document.getElementById("workItemsPanel");
  const arrow = document.getElementById("workItemsToggleArrow");
  if (panel.style.display === "none") {
    panel.style.display = "block";
    if (arrow) arrow.style.transform = "rotate(90deg)";
    loadWorkItemsPanel();
  } else {
    panel.style.display = "none";
    if (arrow) arrow.style.transform = "rotate(0deg)";
  }
}

export function toggleSection(sectionId) {
  const panel = document.getElementById(`${sectionId}Panel`);
  const arrow = document.getElementById(`${sectionId}Arrow`);
  if (!panel) return;
  const isHidden = panel.style.display === "none";
  panel.style.display = isHidden ? "" : "none";
  if (arrow) arrow.style.transform = isHidden ? "rotate(90deg)" : "rotate(0deg)";
}