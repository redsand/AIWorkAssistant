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

  // Chart canvas element IDs (we re-get context on each render)
  const STATUS_CANVAS_ID = "statusChart";
  const PRIORITY_CANVAS_ID = "priorityChart";
  const ASSIGNEE_CANVAS_ID = "assigneeChart";

  // Graph
  const graphContainer = document.getElementById("dependency-graph");

  // Sprint
  const sprintSection = document.getElementById("sprint-section");
  const sprintSelect = document.getElementById("sprint-select");
  const sprintStatsBar = document.getElementById("sprint-stats");
  const statPointsCommitted = document.getElementById("stat-points-committed");
  const statPointsDone = document.getElementById("stat-points-done");
  const statPointsRemaining = document.getElementById("stat-points-remaining");
  const statDaysLeft = document.getElementById("stat-days-left");
  const BURNDOWN_CANVAS_ID = "burndownChart";

  // Table
  const issuesTable = document.getElementById("issues-table");
  const issuesTbody = document.getElementById("issues-tbody");
  const tableSearch = document.getElementById("table-search");
  const tableStatusFilter = document.getElementById("table-status-filter");
  const tablePriorityFilter = document.getElementById("table-priority-filter");
  const refreshBtn = document.getElementById("refresh-btn");

  // ─── State ─────────────────────────────────────────────────────────────────

  let allIssues = [];
  let chartInstances = {};
  let sprintIssues = [];
  let currentSprintId = null;
  let networkInstance = null;
  let lastFetchedAt = null;
  let lastFetchedPlatformKey = null;

  const STATUS_COLORS = {
    open: "#3b82f6",
    in_progress: "#f59e0b",
    blocked: "#ef4444",
    done: "#22c55e",
    unknown: "#9ca3af",
  };
  const PRIORITY_COLORS = {
    critical: "#ef4444",
    high: "#f97316",
    medium: "#3b82f6",
    low: "#9ca3af",
    unknown: "#d1d5db",
  };

  const PRIORITY_ORDER = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    unknown: 4,
  };
  const STATUS_ORDER = {
    in_progress: 0,
    open: 1,
    blocked: 2,
    done: 3,
    unknown: 4,
  };

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = "block";
    setTimeout(function () {
      errorBanner.style.display = "none";
    }, 8000);
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

  function renderStat(el, value) {
    if (el) el.textContent = value;
  }

  function shortDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    var now = new Date();
    var diff = now - d;
    var days = Math.floor(diff / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return days + "d ago";
    if (days < 30) return Math.floor(days / 7) + "w ago";
    return d.toLocaleDateString();
  }

  function showEmpty(key, isEmpty) {
    var el = document.getElementById(key + "-empty");
    if (el) el.style.display = isEmpty ? "block" : "none";
  }

  function updateLastUpdatedDisplay() {
    var el = document.getElementById("last-updated");
    if (!el || !lastFetchedAt) return;
    var diffMin = Math.floor((Date.now() - new Date(lastFetchedAt).getTime()) / 60000);
    el.textContent = diffMin === 0 ? "Last updated: just now" : "Last updated: " + diffMin + " min ago";
  }

  /** Get a fresh 2d context from a canvas by ID. */
  function freshCtx(canvasId) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    return canvas.getContext("2d");
  }

  /** Sort issues by priority then status. */
  function sortIssues(issues) {
    return issues.slice().sort(function (a, b) {
      var pDiff =
        (PRIORITY_ORDER[a.priority] || 4) - (PRIORITY_ORDER[b.priority] || 4);
      if (pDiff !== 0) return pDiff;
      return (STATUS_ORDER[a.status] || 4) - (STATUS_ORDER[b.status] || 4);
    });
  }

  // ─── Chart helpers ─────────────────────────────────────────────────────────

  function makeDoughnut(canvasId, data, showEmptyFn) {
    destroyChart(canvasId);
    var ctx = freshCtx(canvasId);
    if (!ctx) return;

    var labels = Object.keys(data);
    var values = Object.values(data);
    var total = values.reduce(function (a, b) {
      return a + b;
    }, 0);
    if (total === 0) {
      showEmptyFn(true);
      return;
    }
    showEmptyFn(false);

    chartInstances[canvasId] = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: labels,
        datasets: [
          {
            data: values,
            backgroundColor: labels.map(function (l) {
              return STATUS_COLORS[l] || PRIORITY_COLORS[l] || "#9ca3af";
            }),
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "bottom",
            labels: { padding: 16, usePointStyle: true, boxWidth: 8 },
          },
        },
      },
    });
  }

  function makeBar(canvasId, labels, values, colorFn, showEmptyFn) {
    destroyChart(canvasId);
    var ctx = freshCtx(canvasId);
    if (!ctx) return;

    if (labels.length === 0) {
      showEmptyFn(true);
      return;
    }
    showEmptyFn(false);

    chartInstances[canvasId] = new Chart(ctx, {
      type: "bar",
      data: {
        labels: labels,
        datasets: [
          {
            data: values,
            backgroundColor: labels.map(function (l) {
              return colorFn(l);
            }),
            borderRadius: 4,
            borderWidth: 0,
          },
        ],
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

  function makeLineChart(canvasId, labels, datasets, showEmptyFn) {
    destroyChart(canvasId);
    var ctx = freshCtx(canvasId);
    if (!ctx) return;

    if (labels.length === 0) {
      showEmptyFn(true);
      return;
    }
    showEmptyFn(false);

    chartInstances[canvasId] = new Chart(ctx, {
      type: "line",
      data: {
        labels: labels,
        datasets: datasets.map(function (ds) {
          return {
            label: ds.label,
            data: ds.data,
            borderColor: ds.borderColor,
            backgroundColor: ds.backgroundColor || ds.borderColor + "33",
            fill: ds.fill || false,
            tension: ds.tension || 0,
            stepped: ds.stepped || false,
            pointRadius: ds.pointRadius || 3,
            borderWidth: ds.borderWidth || 2,
          };
        }),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "bottom",
            labels: { padding: 16, usePointStyle: true, boxWidth: 8 },
          },
        },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 } },
          x: { ticks: { font: { size: 11 }, maxRotation: 45 } },
        },
      },
    });
  }
  // ─── Render ────────────────────────────────────────────────────────────────

  function renderStats(issues) {
    var open = 0,
      progress = 0,
      blocked = 0,
      done = 0;
    for (var i = 0; i < issues.length; i++) {
      var s = issues[i].status;
      if (s === "open") open++;
      else if (s === "in_progress") progress++;
      else if (s === "blocked") blocked++;
      else if (s === "done") done++;
    }
    renderStat(statTotal, issues.length);
    renderStat(statOpen, open);
    renderStat(statProgress, progress);
    renderStat(statBlocked, blocked);
    renderStat(statDone, done);
  }

  function renderStatusChart(issues) {
    var counts = { open: 0, in_progress: 0, blocked: 0, done: 0 };
    for (var i = 0; i < issues.length; i++) {
      var s = issues[i].status;
      if (counts[s] !== undefined) counts[s]++;
      else counts[s] = 1;
    }
    requestAnimationFrame(function () {
      makeDoughnut(STATUS_CANVAS_ID, counts, function (empty) {
        showEmpty("status", empty);
      });
    });
  }

  function renderPriorityChart(issues) {
    var counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (var i = 0; i < issues.length; i++) {
      var p = issues[i].priority;
      if (counts[p] !== undefined) counts[p]++;
      else counts[p] = 1;
    }
    requestAnimationFrame(function () {
      makeDoughnut(PRIORITY_CANVAS_ID, counts, function (empty) {
        showEmpty("priority", empty);
      });
    });
  }

  function renderAssigneeChart(issues) {
    var byAssignee = {};
    for (var i = 0; i < issues.length; i++) {
      var key = issues[i].assignee || "(unassigned)";
      byAssignee[key] = (byAssignee[key] || 0) + 1;
    }
    var sorted = Object.entries(byAssignee)
      .sort(function (a, b) {
        return b[1] - a[1];
      })
      .slice(0, 15);
    var labels = sorted.map(function (e) {
      return e[0];
    });
    var values = sorted.map(function (e) {
      return e[1];
    });
    requestAnimationFrame(function () {
      makeBar(
        ASSIGNEE_CANVAS_ID,
        labels,
        values,
        function () {
          return "#667eea";
        },
        function (empty) {
          showEmpty("assignee", empty);
        },
      );
    });
  }

  function renderDependencyGraph(nodes, edges) {
    destroyNetwork();
    if (nodes.length === 0) {
      document.getElementById("graph-empty").style.display = "block";
      return;
    }
    document.getElementById("graph-empty").style.display = "none";

    var visNodes = nodes.map(function (n) {
      return {
        id: n.id,
        label: n.label,
        title:
          "<b>" +
          n.label +
          "</b><br>" +
          n.title.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
        color: {
          background: PRIORITY_COLORS[n.priority] || "#9ca3af",
          border: STATUS_COLORS[n.status] || "#9ca3af",
        },
        shape:
          n.status === "done"
            ? "square"
            : n.status === "in_progress"
              ? "triangle"
              : n.status === "blocked"
                ? "star"
                : "dot",
        size: n.priority === "critical" ? 18 : n.priority === "high" ? 14 : 10,
        font: { size: 11, color: "#1a1a2e" },
        borderWidth: 2,
      };
    });

    var visEdges = edges.map(function (e) {
      return {
        from: e.from,
        to: e.to,
        arrows: "to",
        label: e.label,
        font: { size: 9, color: "#6b7280", align: "middle" },
        color: { color: "#c4b5fd", hover: "#a78bfa" },
        smooth: { type: "curvedCW", roundness: 0.2 },
      };
    });

    networkInstance = new vis.Network(
      graphContainer,
      { nodes: visNodes, edges: visEdges },
      {
        physics: {
          solver: "forceAtlas2Based",
          forceAtlas2Based: {
            gravitationalConstant: -40,
            centralGravity: 0.005,
            springLength: 150,
            springConstant: 0.08,
          },
        },
        interaction: { hover: true, tooltipDelay: 200 },
        layout: { improvedLayout: true },
      },
    );

    networkInstance.on("click", function (params) {
      if (params.nodes.length > 0) {
        var nodeId = params.nodes[0];
        var node = nodes.find(function (n) {
          return n.id === nodeId;
        });
        if (node && node.url) window.open(node.url, "_blank");
      }
    });
  }

  function renderTable() {
    var search = (tableSearch.value || "").toLowerCase().trim();
    var statusFilter = tableStatusFilter.value;
    var priorityFilter = tablePriorityFilter.value;

    var filtered = allIssues;
    if (search)
      filtered = filtered.filter(function (i) {
        return i.title.toLowerCase().includes(search);
      });
    if (statusFilter)
      filtered = filtered.filter(function (i) {
        return i.status === statusFilter;
      });
    if (priorityFilter)
      filtered = filtered.filter(function (i) {
        return i.priority === priorityFilter;
      });

    // Sort by priority within status groups
    filtered = sortIssues(filtered);

    if (filtered.length === 0) {
      issuesTable.style.display = "none";
      document.getElementById("issues-empty").style.display = "block";
      return;
    }

    document.getElementById("issues-empty").style.display = "none";
    issuesTable.style.display = "";
    issuesTbody.innerHTML = "";

    function statusBadge(s) {
      var cls =
        s === "open"
          ? "open"
          : s === "in_progress"
            ? "progress"
            : s === "blocked"
              ? "blocked"
              : s === "done"
                ? "done"
                : "";
      return (
        '<span class="badge badge-' +
        cls +
        '">' +
        s.replace(/_/g, " ") +
        "</span>"
      );
    }

    function priorityBadge(p) {
      return '<span class="badge badge-' + p + '">' + p + "</span>";
    }

    function depLinks(deps) {
      if (!deps || deps.length === 0) return "—";
      return deps
        .map(function (d) {
          return (
            '<span class="dep-link" title="' + d.label + '">' + d.id + "</span>"
          );
        })
        .join(", ");
    }

    for (var idx = 0; idx < filtered.length; idx++) {
      var i = filtered[idx];
      var tr = document.createElement("tr");
      tr.innerHTML = [
        '<td><a href="' +
          i.url +
          '" target="_blank" rel="noopener">' +
          i.externalId +
          "</a></td>",
        "<td>" + i.title.replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</td>",
        "<td>" + statusBadge(i.status) + "</td>",
        "<td>" + priorityBadge(i.priority) + "</td>",
        "<td>" + (i.assignee || "—") + "</td>",
        "<td>" +
          (i.labels || [])
            .map(function (l) {
              return (
                '<span class="badge badge-low">' +
                l.replace(/</g, "&lt;") +
                "</span>"
              );
            })
            .join(" ") +
          "</td>",
        "<td>" + depLinks(i.dependencies) + "</td>",
        "<td>" + shortDate(i.updatedAt) + "</td>",
        "<td>" + sprintBadge(i.sprint) + "</td>",
      ].join("");
      issuesTbody.appendChild(tr);
    }
  }

  function sprintBadge(sprint) {
    if (!sprint) return '<span class="badge badge-low">—</span>';
    return (
      '<span class="badge badge-sprint">' +
      sprint.replace(/</g, "&lt;").replace(/>/g, "&gt;") +
      "</span>"
    );
  }
  // ─── Filter event handlers ─────────────────────────────────────────────────

  tableSearch.addEventListener("input", renderTable);
  tableStatusFilter.addEventListener("change", renderTable);
  tablePriorityFilter.addEventListener("change", renderTable);

  // ─── Refresh ────────────────────────────────────────────────────────────────

  function refreshDashboard() {
    var val = repoSelect.value;
    if (!val) return;

    var colon = val.indexOf(":");
    var platform = val.slice(0, colon);
    var repoKey = val.slice(colon + 1);

    // Destroy existing instances
    Object.keys(chartInstances).forEach(function (k) {
      destroyChart(k);
    });
    destroyNetwork();

    loadDashboard(platform, repoKey, true);
  }

  refreshBtn.addEventListener("click", function () {
    if (!repoSelect.value) return;
    refreshBtn.style.pointerEvents = "none";
    refreshBtn.style.opacity = "0.7";
    refreshDashboard();
    setTimeout(function () {
      refreshBtn.style.pointerEvents = "";
      refreshBtn.style.opacity = "";
    }, 1000);
  });

  // ─── Load data ─────────────────────────────────────────────────────────────

  async function loadRepos() {
    repoSelect.innerHTML = '<option value="">Loading repositories…</option>';
    repoSelect.disabled = true;
    try {
      var resp = await fetch("/api/repo-dashboard/repos");
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      var data = await resp.json();

      if (data.repos.length === 0) {
        repoSelect.innerHTML =
          '<option value="">— No repositories available —</option>';
        return;
      }

      repoSelect.innerHTML =
        '<option value="">— Select a repository —</option>';
      for (var ri = 0; ri < data.repos.length; ri++) {
        var repo = data.repos[ri];
        var opt = document.createElement("option");
        opt.value = repo.platform + ":" + repo.repoKey;
        opt.textContent = repo.repoName + " (" + repo.issueCount + " issues)";
        repoSelect.appendChild(opt);
      }
    } catch (err) {
      repoSelect.innerHTML =
        '<option value="">— Failed to load repositories —</option>';
      showError("Failed to load repositories: " + err.message);
    } finally {
      repoSelect.disabled = false;
    }
  }

  function showDashboardLoading() {
    emptyState.style.display = "none";
    dashboardContent.style.display = "none";
    var loader = document.getElementById("dashboard-loading");
    if (loader) loader.style.display = "block";
  }

  function hideDashboardLoading() {
    var loader = document.getElementById("dashboard-loading");
    if (loader) loader.style.display = "none";
  }

  async function loadDashboard(platform, repoKey, forceRefresh) {
    showDashboardLoading();
    var currentKey = platform + ":" + repoKey;
    var isIncremental = !forceRefresh &&
      lastFetchedAt !== null &&
      lastFetchedPlatformKey === currentKey &&
      (Date.now() - new Date(lastFetchedAt).getTime() < 5 * 60 * 1000);

    try {
      var issuesUrl = "/api/repo-dashboard/issues?platform=" +
        encodeURIComponent(platform) +
        "&repo=" +
        encodeURIComponent(repoKey) +
        "&limit=200";

      if (isIncremental) {
        issuesUrl += "&since=" + encodeURIComponent(lastFetchedAt);
      }
      if (forceRefresh) {
        issuesUrl += "&_t=" + Date.now();
      }

      var results = await Promise.all([
        fetch(issuesUrl),
        fetch(
          "/api/repo-dashboard/dependencies?platform=" +
            encodeURIComponent(platform) +
            "&repo=" +
            encodeURIComponent(repoKey),
        ),
      ]);

      if (!results[0].ok) throw new Error("HTTP " + results[0].status);

      var issuesData = await results[0].json();
      var depsData = await results[1].json();

      if (issuesData.error) {
        showError(issuesData.error);
        hideDashboardLoading();
        return;
      }

      if (isIncremental) {
        var updatedIssues = issuesData.issues || [];
        var issueMap = {};
        allIssues.forEach(function (i) { issueMap[i.platform + ":" + i.id] = i; });
        updatedIssues.forEach(function (i) { issueMap[i.platform + ":" + i.id] = i; });
        allIssues = Object.values(issueMap);
      } else {
        allIssues = issuesData.issues || [];
      }

      lastFetchedAt = new Date().toISOString();
      lastFetchedPlatformKey = currentKey;
      updateLastUpdatedDisplay();

      hideDashboardLoading();
      dashboardContent.style.display = "block";

      renderStats(allIssues);
      renderStatusChart(allIssues);
      renderPriorityChart(allIssues);
      renderAssigneeChart(allIssues);
      renderDependencyGraph(depsData.nodes || [], depsData.edges || []);

      // Reset table filters to defaults: show in_progress only, sort by priority
      tableSearch.value = "";
      tableStatusFilter.value = "in_progress";
      tablePriorityFilter.value = "";
      renderTable();

      // Load sprint data for platforms that support sprints
      if (platform === "github" || platform === "jira") {
        loadSprints(platform, repoKey);
      } else {
        sprintSection.style.display = "none";
      }
    } catch (err) {
      hideDashboardLoading();
      showError("Failed to load dashboard data: " + err.message);
    }
  }

  repoSelect.addEventListener("change", function () {
    var val = this.value;
    if (!val) {
      dashboardContent.style.display = "none";
      emptyState.style.display = "block";
      return;
    }

    var colon = val.indexOf(":");
    var platform = val.slice(0, colon);
    var repoKey = val.slice(colon + 1);

    // Destroy existing instances
    Object.keys(chartInstances).forEach(function (k) {
      destroyChart(k);
    });
    destroyNetwork();

    loadDashboard(platform, repoKey);
  });

  // ─── Sprint functions ───────────────────────────────────────────────────────

  async function loadSprints(platform, repoKey) {
    sprintSelect.innerHTML = '<option value="">Loading sprints…</option>';
    sprintSelect.disabled = true;
    sprintSection.style.display = "none";

    try {
      var resp = await fetch(
        "/api/repo-dashboard/sprints?platform=" +
          encodeURIComponent(platform) +
          "&repo=" +
          encodeURIComponent(repoKey),
      );
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      var data = await resp.json();

      if (data.error) {
        sprintSelect.innerHTML =
          '<option value="">— Error loading sprints —</option>';
        sprintSelect.disabled = false;
        return;
      }

      var sprints = data.sprints || [];
      sprintIssues = (data.issues || []).map(function (issue) {
        return Object.assign({}, issue, { sprint: issue.sprint || "" });
      });

      if (sprints.length === 0) {
        sprintSelect.innerHTML =
          '<option value="">— No active sprints —</option>';
        sprintSelect.disabled = false;
        return;
      }

      sprintSection.style.display = "";
      sprintSelect.innerHTML = '<option value="">— Select a sprint —</option>';
      for (var si = 0; si < sprints.length; si++) {
        var sp = sprints[si];
        var opt = document.createElement("option");
        opt.value = sp.id;
        opt.textContent = sp.name + " (" + sp.state + ")";
        sprintSelect.appendChild(opt);
      }
      sprintSelect.disabled = false;
    } catch (err) {
      sprintSelect.innerHTML =
        '<option value="">— Failed to load sprints —</option>';
      sprintSelect.disabled = false;
      showError("Failed to load sprints: " + err.message);
    }
  }

  async function loadBurndown(platform, repoKey, sprintId) {
    destroyChart(BURNDOWN_CANVAS_ID);

    if (!sprintId) {
      sprintStatsBar.style.display = "none";
      showEmpty("burndown", true);
      return;
    }

    try {
      var resp = await fetch(
        "/api/repo-dashboard/burndown?platform=" +
          encodeURIComponent(platform) +
          "&repo=" +
          encodeURIComponent(repoKey) +
          "&sprintId=" +
          encodeURIComponent(sprintId),
      );
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      var data = await resp.json();

      if (data.error) {
        showEmpty("burndown", true);
        sprintStatsBar.style.display = "none";
        return;
      }

      var sprint = data.sprint || {};
      var committed = sprint.totalPoints || 0;
      var done = sprint.completedPoints || 0;
      var remaining = committed - done;

      renderStat(statPointsCommitted, committed);
      renderStat(statPointsDone, done);
      renderStat(statPointsRemaining, remaining);

      if (sprint.endDate) {
        var end = new Date(sprint.endDate);
        var now = new Date();
        var daysLeft = Math.max(0, Math.ceil((end - now) / 86400000));
        renderStat(statDaysLeft, daysLeft);
      } else {
        renderStat(statDaysLeft, "—");
      }

      sprintStatsBar.style.display = "";

      if (!data.labels || data.labels.length === 0) {
        showEmpty("burndown", true);
        return;
      }

      makeLineChart(
        BURNDOWN_CANVAS_ID,
        data.labels,
        [
          {
            label: "Ideal",
            data: data.ideal,
            borderColor: "#9ca3af",
            backgroundColor: "#9ca3af33",
            borderDash: [6, 3],
            pointRadius: 2,
          },
          {
            label: "Actual",
            data: data.actual,
            borderColor: "#667eea",
            backgroundColor: "#667eea33",
            fill: true,
            stepped: true,
            pointRadius: 3,
          },
        ],
        function (empty) {
          showEmpty("burndown", empty);
        },
      );
    } catch (err) {
      showEmpty("burndown", true);
      sprintStatsBar.style.display = "none";
    }
  }

  function renderSprintIssues() {
    if (!currentSprintId) {
      renderTable();
      return;
    }

    var filtered = allIssues.filter(function (i) {
      return i.sprint === currentSprintId;
    });

    var search = (tableSearch.value || "").toLowerCase().trim();
    var statusFilter = tableStatusFilter.value;
    var priorityFilter = tablePriorityFilter.value;
    if (search)
      filtered = filtered.filter(function (i) {
        return i.title.toLowerCase().includes(search);
      });
    if (statusFilter)
      filtered = filtered.filter(function (i) {
        return i.status === statusFilter;
      });
    if (priorityFilter)
      filtered = filtered.filter(function (i) {
        return i.priority === priorityFilter;
      });

    filtered = sortIssues(filtered);

    if (filtered.length === 0) {
      issuesTable.style.display = "none";
      document.getElementById("issues-empty").style.display = "block";
      return;
    }

    document.getElementById("issues-empty").style.display = "none";
    issuesTable.style.display = "";
    issuesTbody.innerHTML = "";

    function statusBadge(s) {
      var cls =
        s === "open"
          ? "open"
          : s === "in_progress"
            ? "progress"
            : s === "blocked"
              ? "blocked"
              : s === "done"
                ? "done"
                : "";
      return (
        '<span class="badge badge-' +
        cls +
        '">' +
        s.replace(/_/g, " ") +
        "</span>"
      );
    }

    function priorityBadge(p) {
      return '<span class="badge badge-' + p + '">' + p + "</span>";
    }

    function depLinks(deps) {
      if (!deps || deps.length === 0) return "—";
      return deps
        .map(function (d) {
          return (
            '<span class="dep-link" title="' + d.label + '">' + d.id + "</span>"
          );
        })
        .join(", ");
    }

    for (var idx = 0; idx < filtered.length; idx++) {
      var i = filtered[idx];
      var tr = document.createElement("tr");
      tr.innerHTML = [
        '<td><a href="' +
          i.url +
          '" target="_blank" rel="noopener">' +
          i.externalId +
          "</a></td>",
        "<td>" + i.title.replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</td>",
        "<td>" + statusBadge(i.status) + "</td>",
        "<td>" + priorityBadge(i.priority) + "</td>",
        "<td>" + (i.assignee || "—") + "</td>",
        "<td>" +
          (i.labels || [])
            .map(function (l) {
              return (
                '<span class="badge badge-low">' +
                l.replace(/</g, "&lt;") +
                "</span>"
              );
            })
            .join(" ") +
          "</td>",
        "<td>" + depLinks(i.dependencies) + "</td>",
        "<td>" + shortDate(i.updatedAt) + "</td>",
        "<td>" + sprintBadge(i.sprint) + "</td>",
      ].join("");
      issuesTbody.appendChild(tr);
    }
  }

  sprintSelect.addEventListener("change", function () {
    var val = this.value;
    if (!val) {
      currentSprintId = null;
      destroyChart(BURNDOWN_CANVAS_ID);
      sprintStatsBar.style.display = "none";
      showEmpty("burndown", true);
      renderTable();
      return;
    }
    currentSprintId = val;

    var repoVal = repoSelect.value;
    var colon = repoVal.indexOf(":");
    var platform = repoVal.slice(0, colon);
    var repoKey = repoVal.slice(colon + 1);

    loadBurndown(platform, repoKey, val);
    renderSprintIssues();
  });

  // ─── Initial load ──────────────────────────────────────────────────────────

  loadRepos();
  setInterval(updateLastUpdatedDisplay, 60000);
})();
