/**
 * Issue Dashboard — Kibana-style board per repository
 *
 * Fetches data from /api/repo-dashboard/repos, /issues, /dependencies
 * Renders charts with Chart.js and dependency graph with vis-network.
 */
(function () {
  "use strict";

  // ─── DOM refs ──────────────────────────────────────────────────────────────

  const repoSelect = document.getElementById("repo-select");
  const errorBanner = document.getElementById("error-banner");
  const emptyState = document.getElementById("empty-state");
  const dashboardContent = document.getElementById("dashboard-content");

  // Stats
  const statTotal = document.getElementById("stat-total");
  const statOpen = document.getElementById("stat-open");
  const statProgress = document.getElementById("stat-progress");
  const statBlocked = document.getElementById("stat-blocked");
  const statDone = document.getElementById("stat-done");

  // Charts
  const statusCtx = document.getElementById("statusChart").getContext("2d");
  const priorityCtx = document.getElementById("priorityChart").getContext("2d");
  const assigneeCtx = document.getElementById("assigneeChart").getContext("2d");

  // Graph
  const graphContainer = document.getElementById("dependency-graph");

  // Table
  const issuesTable = document.getElementById("issues-table");
  const issuesTbody = document.getElementById("issues-tbody");
  const tableSearch = document.getElementById("table-search");
  const tableStatusFilter = document.getElementById("table-status-filter");
  const tablePriorityFilter = document.getElementById("table-priority-filter");

  // ─── State ─────────────────────────────────────────────────────────────────

  let allIssues = [];
  let chartInstances = {};
  let networkInstance = null;

  const STATUS_COLORS = { open: "#3b82f6", in_progress: "#f59e0b", blocked: "#ef4444", done: "#22c55e", unknown: "#9ca3af" };
  const PRIORITY_COLORS = { critical: "#ef4444", high: "#f97316", medium: "#3b82f6", low: "#9ca3af", unknown: "#d1d5db" };

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = "block";
    setTimeout(() => { errorBanner.style.display = "none"; }, 8000);
  }

  function destroyChart(key) {
    if (chartInstances[key]) {
      chartInstances[key].destroy();
      delete chartInstances[key];
    }
  }

  function destroyNetwork() {
    if (networkInstance) {
      networkInstance.destroy();
      networkInstance = null;
    }
  }

  /** Render a single stat chip value */
  function renderStat(el, value) {
    if (el) el.textContent = value;
  }

  /** Format a date string to a short relative format */
  function shortDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    const days = Math.floor(diff / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    return d.toLocaleDateString();
  }

  /** Toggle empty state vs chart */
  function showEmpty(key, isEmpty) {
    const el = document.getElementById(key + "-empty");
    if (el) el.style.display = isEmpty ? "block" : "none";
  }

  // ─── Chart helpers ─────────────────────────────────────────────────────────

  function makeDoughnut(canvas, data, showEmptyFn) {
    destroyChart(canvas);
    const labels = Object.keys(data);
    const values = Object.values(data);
    const total = values.reduce((a, b) => a + b, 0);
    if (total === 0) { showEmptyFn(true); return; }
    showEmptyFn(false);

    chartInstances[canvas] = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: labels.map(l => STATUS_COLORS[l] || PRIORITY_COLORS[l] || "#9ca3af"),
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { padding: 16, usePointStyle: true, boxWidth: 8 } } },
      },
    });
  }

  function makeBar(canvas, labels, values, colorFn, showEmptyFn) {
    destroyChart(canvas);
    if (labels.length === 0) { showEmptyFn(true); return; }
    showEmptyFn(false);

    chartInstances[canvas] = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: labels.map(l => colorFn(l)),
          borderRadius: 4,
          borderWidth: 0,
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0 } },
          y: { ticks: { font: { size: 12 }, autoSkip: false } },
        },
      },
    });
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  function renderStats(issues) {
    const open = issues.filter(i => i.status === "open").length;
    const progress = issues.filter(i => i.status === "in_progress").length;
    const blocked = issues.filter(i => i.status === "blocked").length;
    const done = issues.filter(i => i.status === "done").length;

    renderStat(statTotal, issues.length);
    renderStat(statOpen, open);
    renderStat(statProgress, progress);
    renderStat(statBlocked, blocked);
    renderStat(statDone, done);
  }

  function renderStatusChart(issues) {
    const counts = { open: 0, in_progress: 0, blocked: 0, done: 0 };
    for (const i of issues) {
      if (counts[i.status] !== undefined) counts[i.status]++;
      else counts[i.status] = 1;
    }
    makeDoughnut(statusCtx, counts, (empty) => showEmpty("status", empty));
  }

  function renderPriorityChart(issues) {
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const i of issues) {
      if (counts[i.priority] !== undefined) counts[i.priority]++;
      else counts[i.priority] = 1;
    }
    makeDoughnut(priorityCtx, counts, (empty) => showEmpty("priority", empty));
  }

  function renderAssigneeChart(issues) {
    const byAssignee = {};
    for (const i of issues) {
      const key = i.assignee || "(unassigned)";
      byAssignee[key] = (byAssignee[key] || 0) + 1;
    }
    const sorted = Object.entries(byAssignee).sort((a, b) => b[1] - a[1]).slice(0, 15);
    const labels = sorted.map(e => e[0]);
    const values = sorted.map(e => e[1]);
    makeBar(assigneeCtx, labels, values, () => "#667eea", (empty) => showEmpty("assignee", empty));
  }

  function renderDependencyGraph(nodes, edges) {
    destroyNetwork();
    if (nodes.length === 0 || edges.length === 0) {
      document.getElementById("graph-empty").style.display = "block";
      return;
    }
    document.getElementById("graph-empty").style.display = "none";

    const visNodes = nodes.map(n => ({
      id: n.id,
      label: n.label,
      title: `<b>${n.label}</b><br>${n.title.replace(/</g, "&lt;").replace(/>/g, "&gt;")}`,
      color: {
        background: PRIORITY_COLORS[n.priority] || "#9ca3af",
        border: STATUS_COLORS[n.status] || "#9ca3af",
      },
      shape: n.status === "done" ? "square" : n.status === "in_progress" ? "triangle" : n.status === "blocked" ? "star" : "dot",
      size: n.priority === "critical" ? 18 : n.priority === "high" ? 14 : 10,
      font: { size: 11, color: "#1a1a2e" },
      borderWidth: 2,
    }));

    const visEdges = edges.map(e => ({
      from: e.from,
      to: e.to,
      arrows: "to",
      label: e.label,
      font: { size: 9, color: "#6b7280", align: "middle" },
      color: { color: "#c4b5fd", hover: "#a78bfa" },
      smooth: { type: "curvedCW", roundness: 0.2 },
    }));

    networkInstance = new vis.Network(graphContainer, { nodes: visNodes, edges: visEdges }, {
      physics: {
        solver: "forceAtlas2Based",
        forceAtlas2Based: { gravitationalConstant: -40, centralGravity: 0.005, springLength: 150, springConstant: 0.08 },
      },
      interaction: { hover: true, tooltipDelay: 200 },
      layout: { improvedLayout: true },
    });

    networkInstance.on("click", function (params) {
      if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        const node = nodes.find(n => n.id === nodeId);
        if (node && node.url) window.open(node.url, "_blank");
      }
    });
  }

  function renderTable(issues) {
    const search = (tableSearch.value || "").toLowerCase().trim();
    const statusFilter = tableStatusFilter.value;
    const priorityFilter = tablePriorityFilter.value;

    let filtered = issues;
    if (search) filtered = filtered.filter(i => i.title.toLowerCase().includes(search));
    if (statusFilter) filtered = filtered.filter(i => i.status === statusFilter);
    if (priorityFilter) filtered = filtered.filter(i => i.priority === priorityFilter);

    if (filtered.length === 0) {
      issuesTable.style.display = "none";
      document.getElementById("issues-empty").style.display = "block";
      return;
    }

    document.getElementById("issues-empty").style.display = "none";
    issuesTable.style.display = "";
    issuesTbody.innerHTML = "";

    const statusBadge = (s) => {
      const cls = s === "open" ? "open" : s === "in_progress" ? "progress" : s === "blocked" ? "blocked" : s === "done" ? "done" : "";
      return `<span class="badge badge-${cls}">${s.replace(/_/g, " ")}</span>`;
    };

    const priorityBadge = (p) => `<span class="badge badge-${p}">${p}</span>`;

    const depLinks = (deps) => {
      if (!deps || deps.length === 0) return "—";
      return deps.map(d => `<span class="dep-link" title="${d.label}">${d.id}</span>`).join(", ");
    };

    for (const i of filtered) {
      const tr = document.createElement("tr");
      tr.innerHTML = [
        `<td><a href="${i.url}" target="_blank" rel="noopener">${i.externalId}</a></td>`,
        `<td>${i.title.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</td>`,
        `<td>${statusBadge(i.status)}</td>`,
        `<td>${priorityBadge(i.priority)}</td>`,
        `<td>${i.assignee || "—"}</td>`,
        `<td>${(i.labels || []).map(l => `<span class="badge badge-low">${l.replace(/</g, "&lt;")}</span>`).join(" ")}</td>`,
        `<td>${depLinks(i.dependencies)}</td>`,
        `<td>${shortDate(i.updatedAt)}</td>`,
      ].join("");
      issuesTbody.appendChild(tr);
    }
  }

  // ─── Filter event handlers ─────────────────────────────────────────────────

  tableSearch.addEventListener("input", () => renderTable(allIssues));
  tableStatusFilter.addEventListener("change", () => renderTable(allIssues));
  tablePriorityFilter.addEventListener("change", () => renderTable(allIssues));

  // ─── Load data ─────────────────────────────────────────────────────────────

  async function loadRepos() {
    try {
      const resp = await fetch("/api/repo-dashboard/repos");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      repoSelect.innerHTML = '<option value="">— Select a repository —</option>';
      for (const repo of data.repos) {
        const opt = document.createElement("option");
        opt.value = `${repo.platform}:${repo.repoKey}`;
        opt.textContent = `${repo.repoName} (${repo.issueCount} issues)`;
        repoSelect.appendChild(opt);
      }
    } catch (err) {
      showError("Failed to load repositories: " + err.message);
    }
  }

  async function loadDashboard(platform, repoKey) {
    try {
      const [issuesResp, depsResp] = await Promise.all([
        fetch(`/api/repo-dashboard/issues?platform=${encodeURIComponent(platform)}&repo=${encodeURIComponent(repoKey)}&limit=200`),
        fetch(`/api/repo-dashboard/dependencies?platform=${encodeURIComponent(platform)}&repo=${encodeURIComponent(repoKey)}`),
      ]);

      if (!issuesResp.ok) throw new Error(`HTTP ${issuesResp.status}`);

      const issuesData = await issuesResp.json();
      const depsData = await depsResp.json();

      if (issuesData.error) {
        showError(issuesData.error);
        return;
      }

      allIssues = issuesData.issues || [];

      // Show dashboard, hide empty state
      emptyState.style.display = "none";
      dashboardContent.style.display = "block";

      renderStats(allIssues);
      renderStatusChart(allIssues);
      renderPriorityChart(allIssues);
      renderAssigneeChart(allIssues);
      renderDependencyGraph(depsData.nodes || [], depsData.edges || []);
      renderTable(allIssues);
    } catch (err) {
      showError("Failed to load dashboard data: " + err.message);
    }
  }

  repoSelect.addEventListener("change", function () {
    const val = this.value;
    if (!val) {
      dashboardContent.style.display = "none";
      emptyState.style.display = "block";
      return;
    }

    const colon = val.indexOf(":");
    const platform = val.slice(0, colon);
    const repoKey = val.slice(colon + 1);

    // Destroy existing instances
    Object.keys(chartInstances).forEach(k => destroyChart(k));
    destroyNetwork();

    loadDashboard(platform, repoKey);
  });

  // ─── Initial load ──────────────────────────────────────────────────────────

  loadRepos();
})();
