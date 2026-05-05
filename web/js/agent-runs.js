import { API_BASE } from "./state.js";
import { authHeaders } from "./auth.js";
import { escapeHtml, escapeAttr } from "./utils.js";

const AgentRunsPage = {
  state: {
    runs: [],
    selectedRun: null,
    selectedSteps: [],
    loading: false,
    error: null,
    filters: { status: "", userId: "", limit: "25" },
    refreshInterval: null,
  },

  async init() {
    this.attachListeners();
    await this.loadRuns();
    this.state.refreshInterval = setInterval(() => this.loadRuns(), 30000);
  },

  destroy() {
    if (this.state.refreshInterval) {
      clearInterval(this.state.refreshInterval);
      this.state.refreshInterval = null;
    }
  },

  attachListeners() {
    const el = document.getElementById("agentRunsSection");
    if (!el) return;

    el.querySelector("#ar-status-filter").addEventListener("change", (e) => {
      this.state.filters.status = e.target.value;
      this.loadRuns();
    });
    el.querySelector("#ar-limit-filter").addEventListener("change", (e) => {
      this.state.filters.limit = e.target.value;
      this.loadRuns();
    });
    el.querySelector("#ar-refresh-btn").addEventListener("click", () => {
      this.loadRuns();
    });
    el.querySelector("#ar-back-btn").addEventListener("click", () => {
      this.showList();
    });
  },

  async loadRuns() {
    this.state.loading = true;
    this.state.error = null;
    this.renderList();

    try {
      const params = new URLSearchParams();
      if (this.state.filters.status)
        params.set("status", this.state.filters.status);
      if (this.state.filters.limit) params.set("limit", this.state.filters.limit);

      const response = await fetch(`${API_BASE}/api/agent-runs?${params}`, {
        headers: authHeaders(),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      this.state.runs = data.runs || [];
    } catch (err) {
      this.state.error = err.message || "Failed to load runs";
    } finally {
      this.state.loading = false;
      this.renderList();
    }
  },

  async loadRunDetails(id) {
    this.state.loading = true;
    this.state.error = null;

    try {
      const [runRes, stepsRes] = await Promise.all([
        fetch(`${API_BASE}/api/agent-runs/${encodeURIComponent(id)}`, {
          headers: authHeaders(),
        }),
        fetch(`${API_BASE}/api/agent-runs/${encodeURIComponent(id)}/steps`, {
          headers: authHeaders(),
        }),
      ]);

      if (!runRes.ok) throw new Error(`HTTP ${runRes.status}`);
      const runData = await runRes.json();
      if (runData.error) throw new Error(runData.error);

      const stepsData = stepsRes.ok ? await stepsRes.json() : [];
      this.state.selectedRun = runData;
      this.state.selectedSteps = Array.isArray(stepsData) ? stepsData : [];
      this.renderDetails();
    } catch (err) {
      this.state.error = err.message || "Failed to load run details";
      this.renderDetails();
    }
  },

  showList() {
    this.state.selectedRun = null;
    this.state.selectedSteps = [];
    document.getElementById("ar-list-view").style.display = "";
    document.getElementById("ar-detail-view").style.display = "none";
    this.renderList();
  },

  showDetail() {
    document.getElementById("ar-list-view").style.display = "none";
    document.getElementById("ar-detail-view").style.display = "";
  },

  renderList() {
    const container = document.getElementById("ar-runs-table-body");
    const emptyEl = document.getElementById("ar-empty-state");
    const errorEl = document.getElementById("ar-error-state");
    const loadingEl = document.getElementById("ar-loading-state");

    if (!container) return;

    errorEl.style.display = this.state.error ? "" : "none";
    if (this.state.error) {
      errorEl.textContent = this.state.error;
    }

    loadingEl.style.display = this.state.loading ? "" : "none";
    emptyEl.style.display =
      !this.state.loading && this.state.runs.length === 0 ? "" : "none";
    container.style.display =
      !this.state.loading && this.state.runs.length > 0 ? "" : "none";

    if (this.state.loading || this.state.runs.length === 0) return;

    container.innerHTML = this.state.runs
      .map((run) => {
        const statusClass =
          run.status === "running"
            ? "ar-badge-running"
            : run.status === "completed"
              ? "ar-badge-completed"
              : "ar-badge-failed";
        const duration = run.completedAt
          ? this.formatDuration(
              new Date(run.completedAt) - new Date(run.startedAt),
            )
          : run.status === "running"
            ? "Running..."
            : "—";
        const tokens =
          run.totalTokens != null ? run.totalTokens.toLocaleString() : "—";
        const model = run.model || "—";
        const inputPreview = "—";

        return `<tr class="ar-run-row" onclick="window._arViewRun('${escapeAttr(run.id)}')">
          <td title="${this.formatDate(run.startedAt)}">${this.formatRelativeTime(run.startedAt)}</td>
          <td><span class="ar-mode">${escapeHtml(run.mode)}</span></td>
          <td>${escapeHtml(model)}</td>
          <td><span class="ar-badge ${statusClass}">${escapeHtml(run.status)}</span></td>
          <td>${escapeHtml(duration)}</td>
          <td>${tokens}</td>
          <td class="ar-preview">${escapeHtml(inputPreview)}</td>
          <td><button class="ar-detail-btn" title="View details">&#9654;</button></td>
        </tr>`;
      })
      .join("");
  },

  renderDetails() {
    const container = document.getElementById("ar-detail-content");
    if (!container) return;

    const run = this.state.selectedRun;
    const steps = this.state.selectedSteps;

    if (this.state.error) {
      container.innerHTML = `<div class="ar-error">${escapeHtml(this.state.error)}</div>`;
      this.showDetail();
      return;
    }

    if (!run) {
      container.innerHTML = "";
      return;
    }

    const duration = run.completedAt
      ? this.formatDuration(new Date(run.completedAt) - new Date(run.startedAt))
      : run.status === "running"
        ? "Still running..."
        : "—";

    let html = `
      <div class="ar-meta-grid">
        <div class="ar-meta-item"><span class="ar-meta-label">ID</span><span class="ar-meta-value">${escapeHtml(run.id)}</span></div>
        <div class="ar-meta-item"><span class="ar-meta-label">Status</span><span class="ar-badge ${run.status === 'running' ? 'ar-badge-running' : run.status === 'completed' ? 'ar-badge-completed' : 'ar-badge-failed'}">${escapeHtml(run.status)}</span></div>
        <div class="ar-meta-item"><span class="ar-meta-label">Mode</span><span class="ar-meta-value">${escapeHtml(run.mode)}</span></div>
        <div class="ar-meta-item"><span class="ar-meta-label">Model</span><span class="ar-meta-value">${escapeHtml(run.model || "—")}</span></div>
        <div class="ar-meta-item"><span class="ar-meta-label">Started</span><span class="ar-meta-value">${this.formatDate(run.startedAt)}</span></div>
        <div class="ar-meta-item"><span class="ar-meta-label">Duration</span><span class="ar-meta-value">${escapeHtml(duration)}</span></div>
        <div class="ar-meta-item"><span class="ar-meta-label">Tokens</span><span class="ar-meta-value">${run.totalTokens != null ? run.totalTokens.toLocaleString() : "—"}${run.promptTokens != null && run.completionTokens != null ? ` (${run.promptTokens.toLocaleString()}+${run.completionTokens.toLocaleString()})` : ""}</span></div>
        <div class="ar-meta-item"><span class="ar-meta-label">Tool Loops</span><span class="ar-meta-value">${run.toolLoopCount}</span></div>
      </div>
    `;

    if (run.errorMessage) {
      html += `<div class="ar-run-error">${escapeHtml(run.errorMessage)}</div>`;
    }

    if (run.steps && run.steps.length > 0) {
      html += `<div class="ar-steps-section"><div class="ar-steps-header">Steps (${run.steps.length})</div>`;
      html += this.renderSteps(run.steps);
      html += `</div>`;
    } else if (steps.length > 0) {
      html += `<div class="ar-steps-section"><div class="ar-steps-header">Steps (${steps.length})</div>`;
      html += this.renderSteps(steps);
      html += `</div>`;
    }

    container.innerHTML = html;
    this.showDetail();
  },

  renderSteps(steps) {
    return `<div class="ar-steps-timeline">${steps
      .map((step, i) => {
        const icon =
          step.stepType === "model_request"
            ? "→"
            : step.stepType === "model_response"
              ? "←"
              : step.stepType === "tool_call"
                ? "⚙"
                : step.stepType === "tool_result"
                  ? "✓"
                  : step.stepType === "error"
                    ? "⚠"
                    : step.stepType === "thinking"
                      ? "\u{1F4AD}"
                      : step.stepType === "content"
                        ? "\u{1F4C4}"
                        : "•";
        const durationStr = step.durationMs != null ? ` (${this.formatDuration(step.durationMs)})` : "";
        const toolInfo = step.toolName ? ` ${escapeHtml(step.toolName)}` : "";
        const successIcon =
          step.stepType === "tool_result"
            ? step.success
              ? " ✓"
              : " ✗"
            : "";

        return `<div class="ar-step">
          <div class="ar-step-marker">${icon}</div>
          <div class="ar-step-body">
            <div class="ar-step-header">
              <span class="ar-step-type">${escapeHtml(step.stepType)}${toolInfo}${successIcon}${durationStr}</span>
              <span class="ar-step-time">${this.formatDate(step.createdAt)}</span>
            </div>
            ${step.errorMessage ? `<div class="ar-step-error">${escapeHtml(step.errorMessage)}</div>` : ""}
            ${step.sanitizedParams ? this.renderJsonCollapsible("Params", step.sanitizedParams) : ""}
            ${step.content != null ? this.renderJsonCollapsible("Content", step.content) : ""}
          </div>
        </div>`;
      })
      .join("")}</div>`;
  },

  formatDuration(ms) {
    if (!ms) return "—";
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  },

  formatDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString();
  },

  formatRelativeTime(iso) {
    if (!iso) return "—";
    const now = Date.now();
    const then = new Date(iso).getTime();
    const diffMs = now - then;
    if (diffMs < 0) return "just now";
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  },

  truncate(text, max = 100) {
    if (!text) return "—";
    return text.length > max ? text.substring(0, max) + "…" : text;
  },

  renderJsonCollapsible(label, value) {
    const id = "ar-json-" + Math.random().toString(36).substring(2, 9);
    let displayValue;
    if (value === null || value === undefined) {
      displayValue = "—";
    } else if (typeof value === "string") {
      displayValue = escapeHtml(this.truncate(value, 200));
    } else {
      try {
        displayValue = escapeHtml(JSON.stringify(value, null, 2));
      } catch {
        displayValue = escapeHtml(String(value));
      }
    }

    const isLong =
      typeof value === "object" && value !== null
        ? JSON.stringify(value).length > 80
        : typeof value === "string" && value.length > 80;

    if (!isLong) {
      return `<div class="ar-step-json"><span class="ar-json-label">${escapeHtml(label)}:</span> <code>${displayValue}</code></div>`;
    }

    return `<details class="ar-step-json-collapsible">
      <summary class="ar-json-summary">${escapeHtml(label)}</summary>
      <pre class="ar-json-pre"><code>${displayValue}</code></pre>
    </details>`;
  },
};

// Expose for onclick handlers
window._arViewRun = (id) => AgentRunsPage.loadRunDetails(id);
window._arPage = AgentRunsPage;

export default AgentRunsPage;