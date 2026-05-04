import {
  currentSessionId,
  messageHistory,
  setCurrentSessionId,
  setMessageHistory,
} from "./state.js";
import { authHeaders } from "./auth.js";
import { addMessage, showError } from "./messages.js";
import { escapeHtml } from "./utils.js";

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
          (roadmap) => `
                <div class="roadmap-item" style="cursor:pointer" onclick="viewRoadmap('${roadmap.id}','${roadmap.name.replace(/'/g, "\\'")}')">
                    <div class="roadmap-name">${roadmap.name}</div>
                    <div class="roadmap-meta">
                        ${roadmap.type} • ${roadmap.status} • ${new Date(roadmap.createdAt).toLocaleDateString()}
                    </div>
                </div>
            `,
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
      addMessage(`Failed to load roadmap: ${data.error}`, "assistant");
      return;
    }
    const r = data.roadmap;
    let md = `## ${r.name}\n`;
    md += `**${r.type}** · ${r.status}\n\n`;
    if (r.description) md += `*${r.description}*\n\n`;
    md += `Start: ${r.startDate}${r.endDate ? " — End: " + r.endDate : ""}\n`;
    if (r.milestones && r.milestones.length > 0) {
      md += `\n### Milestones\n`;
      for (const m of r.milestones) {
        const icon =
          m.status === "completed"
            ? "✅"
            : m.status === "blocked"
              ? "🚫"
              : "⬜";
        md += `- ${icon} **${m.name}** — ${m.status} (target: ${m.targetDate ? new Date(m.targetDate).toLocaleDateString() : "TBD"})\n`;
        if (m.items && m.items.length > 0) {
          for (const item of m.items) {
            const ic =
              item.status === "done"
                ? "✅"
                : item.status === "blocked"
                  ? "🚫"
                  : item.status === "in_progress"
                    ? "🔄"
                    : "⬜";
            md += `  - ${ic} ${item.title} [${item.priority}]${item.jiraKey ? " (" + item.jiraKey + ")" : ""}\n`;
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

  let html = "";
  for (const [category, tools] of Object.entries(data.categories)) {
    const toolArr = tools;
    const catId = `tool-cat-${category.replace(/\s+/g, '-').toLowerCase()}`;
    html += `<div style="margin-bottom:8px">`;
    html += `<div style="font-weight:600;color:#555;margin-bottom:4px;text-transform:capitalize;cursor:pointer;display:flex;justify-content:space-between;align-items:center" onclick="toggleToolCategory('${catId}')">`;
    html += `<span>${escapeHtml(category)}</span>`;
    html += `<span style="font-size:11px;color:#999">${toolArr.length} tools ▶</span>`;
    html += `</div>`;
    html += `<div id="${catId}" style="display:none">`;
    for (const tool of toolArr) {
      const desc =
        tool.description.length > 80
          ? tool.description.substring(0, 80) + "..."
          : tool.description;
      html += `<div style="padding:2px 0 2px 8px;color:#666;border-left:2px solid #e5e7eb;margin-bottom:2px" title="${escapeHtml(tool.description)}">`;
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
  if (panel.style.display === "none") {
    panel.style.display = "block";
    arrow.style.transform = "rotate(90deg)";
    loadTodos();
  } else {
    panel.style.display = "none";
    arrow.style.transform = "rotate(0deg)";
  }
}

export async function quickAction(action) {
  const { sendMessage } = await import("./chat.js");
  const { showChatView } = await import("./conversations.js");
  const input = document.getElementById("messageInput");
  input.value = action;
  showChatView();
  await sendMessage();
}
