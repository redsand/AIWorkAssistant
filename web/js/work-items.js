import { authHeaders } from "./auth.js";
import { escapeHtml, escapeAttr } from "./utils.js";

const API_BASE = window.location.origin;

// ── Helper Utilities ──

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatRelativeDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = d - now;
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays < 0) return `${Math.abs(diffDays)}d overdue`;
  if (diffDays === 0) return "Due today";
  if (diffDays === 1) return "Due tomorrow";
  return `Due in ${diffDays}d`;
}

const STATUS_COLORS = {
  proposed: "#9ca3af",
  planned: "#60a5fa",
  active: "#34d399",
  blocked: "#f87171",
  waiting: "#fbbf24",
  done: "#6b7280",
  archived: "#d1d5db",
};

const TYPE_ICONS = {
  task: "✅",
  decision: "⚡",
  code_review: "👀",
  roadmap: "🗺️",
  customer_followup: "📞",
  detection: "🔍",
  research: "📚",
  personal: "🏠",
  support: "🎫",
  release: "🚀",
};

const PRIORITY_COLORS = {
  low: "#9ca3af",
  medium: "#60a5fa",
  high: "#f59e0b",
  critical: "#ef4444",
};

const WORK_ITEM_TYPES = [
  "task",
  "decision",
  "code_review",
  "roadmap",
  "customer_followup",
  "detection",
  "research",
  "personal",
  "support",
  "release",
];

const WORK_ITEM_STATUSES = [
  "proposed",
  "planned",
  "active",
  "blocked",
  "waiting",
  "done",
  "archived",
];

const WORK_ITEM_PRIORITIES = ["low", "medium", "high", "critical"];

// ── State ──

let currentFilters = {
  status: "",
  type: "",
  priority: "",
  source: "",
  search: "",
  includeArchived: false,
  limit: "50",
};
let selectedItemId = null;

function parseJsonArray(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function dateInputValue(iso) {
  if (!iso) return "";
  return iso.slice(0, 10);
}

function renderOptions(values, selected) {
  return values
    .map(
      (value) =>
        `<option value="${escapeAttr(value)}"${value === selected ? " selected" : ""}>${escapeHtml(value)}</option>`,
    )
    .join("");
}

// ── List View ──

export async function loadWorkItems() {
  const container = document.getElementById("workItemsList");
  container.innerHTML = '<div class="loading">Loading work items...</div>';

  try {
    const params = new URLSearchParams();
    if (currentFilters.status) params.set("status", currentFilters.status);
    if (currentFilters.type) params.set("type", currentFilters.type);
    if (currentFilters.priority) params.set("priority", currentFilters.priority);
    if (currentFilters.source) params.set("source", currentFilters.source);
    if (currentFilters.search) params.set("search", currentFilters.search);
    if (currentFilters.includeArchived) params.set("includeArchived", "true");
    if (currentFilters.limit) params.set("limit", currentFilters.limit);

    const response = await fetch(`${API_BASE}/api/work-items?${params.toString()}`, {
      headers: authHeaders(),
    });
    const data = await response.json();

    if (!data.items || data.items.length === 0) {
      container.innerHTML = '<div class="loading">No work items found. Create one with the button above.</div>';
      return;
    }

    let html = "";
    for (const item of data.items) {
      const statusColor = STATUS_COLORS[item.status] || "#999";
      const typeIcon = TYPE_ICONS[item.type] || "📌";
      const priorityColor = PRIORITY_COLORS[item.priority] || "#999";
      const dueInfo = item.dueAt ? formatRelativeDate(item.dueAt) : "";
      const isOverdue =
        item.dueAt &&
        new Date(item.dueAt) < new Date() &&
        item.status !== "done" &&
        item.status !== "archived";

      html += `
        <div class="work-item-row" onclick="window.viewWorkItem('${escapeAttr(item.id)}')" style="cursor:pointer;">
          <div class="work-item-row-header">
            <span style="width:8px;height:8px;border-radius:50%;background:${statusColor};flex-shrink:0;display:inline-block;"></span>
            <span class="work-item-type-icon">${typeIcon}</span>
            <span class="work-item-title">${escapeHtml(item.title)}</span>
            <span class="work-item-priority" style="color:${priorityColor};">${escapeHtml(item.priority)}</span>
            ${isOverdue
              ? '<span style="color:#ef4444;font-size:11px;font-weight:600;">OVERDUE</span>'
              : dueInfo
                ? `<span style="color:#888;font-size:11px;">${escapeHtml(dueInfo)}</span>`
                : ""}
          </div>
          <div class="work-item-row-meta">
            <span style="color:#888;font-size:11px;">${escapeHtml(item.type)}</span>
            <span style="color:#888;font-size:11px;">${escapeHtml(item.source)}</span>
            ${item.owner ? `<span style="color:#888;font-size:11px;">${escapeHtml(item.owner)}</span>` : ""}
            <span style="color:#999;font-size:11px;">${escapeHtml(formatDate(item.updatedAt))}</span>
          </div>
        </div>
      `;
    }
    container.innerHTML = html;
  } catch {
    container.innerHTML = '<div class="error">Failed to load work items.</div>';
  }
}

// ── Detail View ──

export async function viewWorkItem(id) {
  selectedItemId = id;
  const detailEl = document.getElementById("workItemDetail");
  detailEl.style.display = "block";
  detailEl.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const response = await fetch(`${API_BASE}/api/work-items/${id}`, {
      headers: authHeaders(),
    });
    const item = await response.json();
    if (item.error) {
      detailEl.innerHTML = `<div class="error">${escapeHtml(item.error)}</div>`;
      return;
    }

    const statusColor = STATUS_COLORS[item.status] || "#999";
    const typeIcon = TYPE_ICONS[item.type] || "📌";
    const priorityColor = PRIORITY_COLORS[item.priority] || "#999";
    const tags = parseJsonArray(item.tagsJson);
    const notes = parseJsonArray(item.notesJson);
    const resources = parseJsonArray(item.linkedResourcesJson);

    let html = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 style="margin:0;font-size:16px;">Work Item Details</h3>
        <button class="action-btn" onclick="window.closeWorkItemDetail()">✕ Close</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        <span style="width:10px;height:10px;border-radius:50%;background:${statusColor};display:inline-block;"></span>
        <strong>${escapeHtml(item.status)}</strong>
        <span>${typeIcon} ${escapeHtml(item.type)}</span>
        <span style="color:${priorityColor};font-weight:600;">${escapeHtml(item.priority)}</span>
      </div>
      <h4 style="margin:0 0 8px 0;">${escapeHtml(item.title)}</h4>
      ${item.description
        ? `<p style="margin:0 0 12px 0;font-size:13px;color:#555;white-space:pre-wrap;">${escapeHtml(item.description)}</p>`
        : ""}
      <div style="font-size:12px;color:#888;line-height:1.8;">
        <div><strong>Owner:</strong> ${escapeHtml(item.owner || "—")}</div>
        <div><strong>Source:</strong> ${escapeHtml(item.source)}${item.sourceExternalId ? ` (${escapeHtml(item.sourceExternalId)})` : ""}</div>
        <div><strong>Due:</strong> ${escapeHtml(item.dueAt ? formatDate(item.dueAt) : "—")}</div>
        <div><strong>Created:</strong> ${escapeHtml(formatDate(item.createdAt))}</div>
        <div><strong>Updated:</strong> ${escapeHtml(formatDate(item.updatedAt))}</div>
        ${item.completedAt ? `<div><strong>Completed:</strong> ${escapeHtml(formatDate(item.completedAt))}</div>` : ""}
      </div>
    `;

    if (tags.length > 0) {
      html += `<div style="margin-top:8px;display:flex;gap:4px;flex-wrap:wrap;">`;
      for (const tag of tags) {
        html += `<span style="background:#f3f4f6;border-radius:4px;padding:2px 8px;font-size:11px;color:#555;">${escapeHtml(tag)}</span>`;
      }
      html += `</div>`;
    }

    if (resources.length > 0) {
      html += `<div style="margin-top:12px;"><strong style="font-size:13px;">Linked Resources</strong>`;
      for (const r of resources) {
        html += `<div style="margin:4px 0;font-size:12px;"><a href="${escapeAttr(r.url)}" target="_blank" style="color:#667eea;">${escapeHtml(r.label)}</a> <span style="color:#888;">(${escapeHtml(r.type)})</span></div>`;
      }
      html += `</div>`;
    }

    if (notes.length > 0) {
      html += `<div style="margin-top:12px;"><strong style="font-size:13px;">Notes</strong>`;
      for (const note of notes) {
        html += `<div style="margin:6px 0;padding:8px;background:#f9fafb;border-radius:6px;border:1px solid #e5e7eb;">
          <div style="font-size:11px;color:#888;">${escapeHtml(note.author)} · ${escapeHtml(formatDate(note.createdAt))}</div>
          <div style="font-size:13px;margin-top:2px;">${escapeHtml(note.content)}</div>
        </div>`;
      }
      html += `</div>`;
    }

    html += `
      <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;">
        <button class="action-btn" onclick="window.editWorkItem('${escapeAttr(item.id)}')">Edit</button>
        ${item.status !== "done"
          ? `<button class="action-btn" onclick="window.completeWorkItem('${escapeAttr(item.id)}')">✓ Mark Done</button>`
          : ""}
        ${item.status !== "archived"
          ? `<button class="action-btn" onclick="window.archiveWorkItem('${escapeAttr(item.id)}')" style="background:#f3f4f6;color:#333;">Archive</button>`
          : ""}
      </div>
    `;

    detailEl.innerHTML = html;
  } catch {
    detailEl.innerHTML = '<div class="error">Failed to load work item.</div>';
  }
}

export async function editWorkItem(id) {
  selectedItemId = id;
  const detailEl = document.getElementById("workItemDetail");
  detailEl.style.display = "block";
  detailEl.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const response = await fetch(`${API_BASE}/api/work-items/${id}`, {
      headers: authHeaders(),
    });
    const item = await response.json();
    if (item.error) {
      detailEl.innerHTML = `<div class="error">${escapeHtml(item.error)}</div>`;
      return;
    }

    const tags = parseJsonArray(item.tagsJson).join(", ");
    detailEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 style="margin:0;font-size:16px;">Edit Work Item</h3>
        <button class="action-btn" onclick="window.viewWorkItem('${escapeAttr(item.id)}')">Cancel</button>
      </div>
      <div class="work-item-create-form" style="display:block;background:white;border:none;padding:0;margin:0;">
        <label>Type</label>
        <select id="editType">${renderOptions(WORK_ITEM_TYPES, item.type)}</select>
        <label>Status</label>
        <select id="editStatus">${renderOptions(WORK_ITEM_STATUSES, item.status)}</select>
        <label>Title *</label>
        <input type="text" id="editTitle" value="${escapeAttr(item.title)}" />
        <label>Description</label>
        <textarea id="editDescription">${escapeHtml(item.description || "")}</textarea>
        <label>Priority</label>
        <select id="editPriority">${renderOptions(WORK_ITEM_PRIORITIES, item.priority)}</select>
        <label>Due Date</label>
        <input type="date" id="editDueAt" value="${escapeAttr(dateInputValue(item.dueAt))}" />
        <label>Owner</label>
        <input type="text" id="editOwner" value="${escapeAttr(item.owner || "")}" />
        <label>Tags (comma-separated)</label>
        <input type="text" id="editTags" value="${escapeAttr(tags)}" />
        <div style="display:flex;gap:8px;">
          <button class="action-btn" onclick="window.updateWorkItem('${escapeAttr(item.id)}')">Save</button>
          <button class="action-btn" onclick="window.viewWorkItem('${escapeAttr(item.id)}')" style="background:#f3f4f6;color:#333;">Cancel</button>
        </div>
      </div>
    `;
  } catch {
    detailEl.innerHTML = '<div class="error">Failed to load work item.</div>';
  }
}

export async function updateWorkItem(id) {
  const tagsRaw = document.getElementById("editTags").value.trim();
  const form = {
    type: document.getElementById("editType").value,
    status: document.getElementById("editStatus").value,
    title: document.getElementById("editTitle").value.trim(),
    description: document.getElementById("editDescription").value.trim(),
    priority: document.getElementById("editPriority").value,
    owner: document.getElementById("editOwner").value.trim(),
    dueAt: document.getElementById("editDueAt").value || null,
    tags: tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [],
  };

  if (!form.title) {
    alert("Title is required");
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/api/work-items/${id}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await response.json();
    if (data.error) {
      alert("Error: " + data.error);
      return;
    }

    viewWorkItem(id);
    loadWorkItems();
  } catch {
    alert("Failed to update work item");
  }
}

export function closeWorkItemDetail() {
  const detailEl = document.getElementById("workItemDetail");
  detailEl.style.display = "none";
  selectedItemId = null;
}

// ── Create Form ──

export function showCreateWorkItemForm() {
  const formEl = document.getElementById("workItemCreateForm");
  formEl.style.display = formEl.style.display === "none" ? "block" : "none";
}

export async function createWorkItem() {
  const tagsRaw = document.getElementById("createTags").value.trim();
  const form = {
    type: document.getElementById("createType").value,
    title: document.getElementById("createTitle").value.trim(),
    description: document.getElementById("createDescription").value.trim(),
    priority: document.getElementById("createPriority").value,
    dueAt: document.getElementById("createDueAt").value || null,
    tags: tagsRaw ? tagsRaw.split(",").map((t) => t.trim()) : undefined,
  };

  if (!form.title) {
    alert("Title is required");
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/api/work-items`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await response.json();
    if (data.error) {
      alert("Error: " + data.error);
      return;
    }

    document.getElementById("createTitle").value = "";
    document.getElementById("createDescription").value = "";
    document.getElementById("createDueAt").value = "";
    document.getElementById("createTags").value = "";
    document.getElementById("workItemCreateForm").style.display = "none";

    loadWorkItems();
  } catch {
    alert("Failed to create work item");
  }
}

// ── Actions ──

export async function completeWorkItem(id) {
  try {
    await fetch(`${API_BASE}/api/work-items/${id}/complete`, {
      method: "POST",
      headers: authHeaders(),
    });
    viewWorkItem(id);
    loadWorkItems();
  } catch {
    alert("Failed to complete work item");
  }
}

export async function archiveWorkItem(id) {
  try {
    await fetch(`${API_BASE}/api/work-items/${id}/archive`, {
      method: "POST",
      headers: authHeaders(),
    });
    viewWorkItem(id);
    loadWorkItems();
  } catch {
    alert("Failed to archive work item");
  }
}

// ── Filters ──

export function applyWorkItemsFilters() {
  currentFilters.status = document.getElementById("wiFilterStatus")?.value || "";
  currentFilters.type = document.getElementById("wiFilterType")?.value || "";
  currentFilters.priority = document.getElementById("wiFilterPriority")?.value || "";
  currentFilters.source = document.getElementById("wiFilterSource")?.value || "";
  currentFilters.search = document.getElementById("wiFilterSearch")?.value || "";
  currentFilters.includeArchived = document.getElementById("wiFilterArchived")?.checked || false;
  currentFilters.limit = document.getElementById("wiFilterLimit")?.value || "50";
  loadWorkItems();
}

// ── Global Bindings ──

window.viewWorkItem = viewWorkItem;
window.editWorkItem = editWorkItem;
window.updateWorkItem = updateWorkItem;
window.closeWorkItemDetail = closeWorkItemDetail;
window.showCreateWorkItemForm = showCreateWorkItemForm;
window.createWorkItem = createWorkItem;
window.completeWorkItem = completeWorkItem;
window.archiveWorkItem = archiveWorkItem;
window.applyWorkItemsFilters = applyWorkItemsFilters;
window.refreshWorkItems = loadWorkItems;
