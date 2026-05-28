(function () {
  "use strict";

  const charts = {};
  const COLORS = {
    ck: "#22c55e",
    ckLight: "#86efac",
    rag: "#3b82f6",
    ragLight: "#93c5fd",
    tie: "#9ca3af",
    tieLight: "#d1d5db",
  };

  // ── Data fetching ────────────────────────────────────────────────

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function showError(msg) {
    const banner = document.getElementById("error-banner");
    banner.textContent = msg;
    banner.classList.add("show");
    setTimeout(function () {
      banner.classList.remove("show");
    }, 8000);
  }

  // ── Chart helpers ────────────────────────────────────────────────

  function destroyChart(key) {
    if (charts[key]) {
      charts[key].destroy();
      delete charts[key];
    }
  }

  function makeDoughnut(canvasId, data, showEmpty) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    destroyChart(canvasId);
    if (!data || data.labels.length === 0 || data.values.every(function (v) { return v === 0; })) {
      showEmpty();
      return;
    }
    charts[canvasId] = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels: data.labels,
        datasets: [
          {
            data: data.values,
            backgroundColor: data.colors,
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        cutout: "60%",
        plugins: {
          legend: { position: "bottom", labels: { padding: 16, usePointStyle: true } },
        },
      },
    });
  }

  function makeBar(canvasId, data, showEmpty) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    destroyChart(canvasId);
    if (!data || data.labels.length === 0) {
      showEmpty();
      return;
    }
    charts[canvasId] = new Chart(canvas, {
      type: "bar",
      data: {
        labels: data.labels,
        datasets: data.datasets,
      },
      options: {
        responsive: true,
        indexAxis: "y",
        plugins: {
          legend: { position: "bottom", labels: { padding: 16, usePointStyle: true } },
        },
        scales: {
          x: { beginAtZero: true, grid: { color: "#f3f4f6" } },
          y: { grid: { display: false } },
        },
      },
    });
  }

  function makeLine(canvasId, data, showEmpty) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    destroyChart(canvasId);
    if (!data || data.labels.length === 0) {
      showEmpty();
      return;
    }
    charts[canvasId] = new Chart(canvas, {
      type: "line",
      data: {
        labels: data.labels,
        datasets: [
          {
            label: "Avg Confidence",
            data: data.values,
            borderColor: COLORS.ck,
            backgroundColor: COLORS.ckLight + "40",
            fill: true,
            tension: 0.3,
            pointRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
        },
        scales: {
          x: { grid: { color: "#f3f4f6" } },
          y: { min: 0, max: 1, ticks: { callback: function (v) { return (v * 100).toFixed(0) + "%"; } } },
        },
      },
    });
  }

  function makeStackedBar(canvasId, data, showEmpty) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    destroyChart(canvasId);
    if (!data || data.labels.length === 0) {
      showEmpty();
      return;
    }
    charts[canvasId] = new Chart(canvas, {
      type: "bar",
      data: {
        labels: data.labels,
        datasets: data.datasets,
      },
      options: {
        responsive: true,
        indexAxis: "y",
        plugins: {
          legend: { position: "bottom", labels: { padding: 16, usePointStyle: true } },
        },
        scales: {
          x: { stacked: true, beginAtZero: true, grid: { color: "#f3f4f6" } },
          y: { stacked: true, grid: { display: false } },
        },
      },
    });
  }

  function hideEmpty(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = "none";
  }
  function showEmpty(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = "";
  }

  // ── Render functions ─────────────────────────────────────────────

  function renderStat(id, value, formatter) {
    var el = document.getElementById(id);
    if (el) el.textContent = formatter ? formatter(value) : value;
  }

  function renderWinRateChart(stats) {
    var ckWins = stats.overallWins.claimkit;
    var ragWins = stats.overallWins.rag;
    var ties = stats.overallWins.tie;
    makeDoughnut(
      "winRateChart",
      {
        labels: ["ClaimKit", "RAG", "Tie"],
        values: [ckWins, ragWins, ties],
        colors: [COLORS.ck, COLORS.rag, COLORS.tie],
      },
      function () { showEmpty("winrate-empty"); hideEmpty("winrate-section"); }
    );
  }

  function renderAnswerabilityChart(stats) {
    var rate = stats.avgAnswerabilityRate;
    var pct = Math.round(rate * 100);
    makeDoughnut(
      "answerabilityChart",
      {
        labels: ["Answerable", "Other"],
        values: [pct, 100 - pct],
        colors: [COLORS.ck, COLORS.tieLight],
      },
      function () { showEmpty("answerability-empty"); }
    );
  }

  function renderProcessingTimeChart(stats) {
    makeBar(
      "processingTimeChart",
      {
        labels: ["Avg Processing Time"],
        datasets: [
          { label: "ClaimKit", data: [Math.round(stats.avgCkTimeMs)], backgroundColor: COLORS.ck },
          { label: "RAG", data: [Math.round(stats.avgRagTimeMs)], backgroundColor: COLORS.rag },
        ],
      },
      function () { showEmpty("time-empty"); }
    );
  }

  function renderConfidenceTrend(trends) {
    makeLine(
      "confidenceTrendChart",
      {
        labels: trends.map(function (t) { return t.date; }),
        values: trends.map(function (t) { return t.avgConfidence; }),
      },
      function () { showEmpty("trend-empty"); }
    );
  }

  function renderCategoryChart(stats) {
    var cats = stats.byCategory;
    makeStackedBar(
      "categoryChart",
      {
        labels: cats.map(function (c) { return c.category.replace(/_/g, " "); }),
        datasets: [
          { label: "ClaimKit Wins", data: cats.map(function (c) { return c.claimkitWins; }), backgroundColor: COLORS.ck },
          { label: "RAG Wins", data: cats.map(function (c) { return c.ragWins; }), backgroundColor: COLORS.rag },
          { label: "Ties", data: cats.map(function (c) { return c.ties; }), backgroundColor: COLORS.tie },
        ],
      },
      function () { showEmpty("category-empty"); }
    );
  }

  function renderRunsTable(runs) {
    var empty = document.getElementById("runs-empty");
    var table = document.getElementById("runs-table");
    var tbody = document.getElementById("runs-tbody");
    tbody.innerHTML = "";

    if (!runs || runs.length === 0) {
      empty.style.display = "";
      table.style.display = "none";
      return;
    }
    empty.style.display = "none";
    table.style.display = "";

    runs.forEach(function (run) {
      var total = run.totalCases;
      var ckWins = run.wins.claimkit;
      var winRate = total > 0 ? Math.round((ckWins / total) * 100) + "%" : "—";
      var date = new Date(run.created_at).toLocaleDateString();

      var tr = document.createElement("tr");
      tr.className = "clickable";
      tr.setAttribute("data-run-id", run.id);
      tr.innerHTML =
        "<td>" + date + "</td>" +
        "<td><span class='badge badge-" + run.source + "'>" + run.source + "</span></td>" +
        "<td>" + (run.description || "—") + "</td>" +
        "<td>" + total + "</td>" +
        "<td><span class='badge badge-win'>" + ckWins + "</span></td>" +
        "<td>" + run.wins.rag + "</td>" +
        "<td>" + run.wins.tie + "</td>" +
        "<td>" + winRate + "</td>";

      tr.addEventListener("click", function () {
        var existing = tr.nextElementSibling;
        if (existing && existing.classList.contains("detail-row")) {
          existing.remove();
          return;
        }
        loadRunDetail(run.id, tr);
      });

      tbody.appendChild(tr);
    });
  }

  var GITHUB_REPO = "redsand/AIWorkAssistant";
  var repoMeta = document.querySelector("meta[name='github-repo']");
  if (repoMeta) { GITHUB_REPO = repoMeta.content; }

  function buildIssueUrl(c) {
    var title = encodeURIComponent("[ClaimKit] RAG won: " + c.query.substring(0, 60));
    var lines = [];
    lines.push("## Query");
    lines.push("");
    lines.push(c.query);
    lines.push("");
    lines.push("## Why RAG Won");
    lines.push("");
    lines.push("**Winner reason:** " + (c.winner_reason || "unknown"));
    if (c.ck_answerability) { lines.push("**Answerability:** " + c.ck_answerability); }
    if (c.ck_confidence !== null) { lines.push("**Confidence:** " + (c.ck_confidence * 100).toFixed(0) + "%"); }
    if (c.ck_retrieval_score !== null) { lines.push("**Retrieval score:** " + c.ck_retrieval_score.toFixed(3)); }
    if (c.ck_source_count !== null) { lines.push("**Sources used:** " + c.ck_source_count); }
    if (c.ck_missing_evidence) {
      lines.push("");
      lines.push("## Missing Evidence");
      lines.push("");
      lines.push(c.ck_missing_evidence);
    }
    if (c.ck_answer) {
      lines.push("");
      lines.push("## ClaimKit Answer");
      lines.push("");
      lines.push("> " + c.ck_answer.substring(0, 500));
    }
    lines.push("");
    lines.push("## Metrics");
    lines.push("");
    lines.push("| Metric | RAG | ClaimKit |");
    lines.push("|--------|-----|----------|");
    lines.push("| Tokens | " + c.rag_tokens + " | — |");
    lines.push("| Sections | " + c.rag_sections + " | — |");
    lines.push("| Time (ms) | " + c.rag_time_ms + " | " + (c.ck_time_ms !== null ? c.ck_time_ms : "—") + " |");
    lines.push("| Claims | — | " + (c.ck_claim_count !== null ? c.ck_claim_count : "—") + " |");
    lines.push("| Contradictions | — | " + (c.ck_contradictions !== null ? c.ck_contradictions : "—") + " |");
    lines.push("");
    lines.push("> Auto-generated from [comparison dashboard](" + window.location.href + ")");
    var body = encodeURIComponent(lines.join("\n"));
    return "https://github.com/" + GITHUB_REPO + "/issues/new?title=" + title + "&body=" + body + "&labels=claimkit,bug";
  }

  function loadRunDetail(runId, afterRow) {
    fetchJSON("/api/comparison/runs/" + runId)
      .then(function (run) {
        var detailTr = document.createElement("tr");
        detailTr.className = "detail-row";
        var detailTd = document.createElement("td");
        detailTd.colSpan = 8;

        var html = "<div class='detail-panel'>";
        run.cases.forEach(function (c) {
          var winnerBadge =
            c.overall_winner === "claimkit"
              ? "<span class='badge badge-win'>CK</span>"
              : c.overall_winner === "rag"
                ? "<span class='badge badge-loss'>RAG</span>"
                : "<span class='badge badge-tie'>Tie</span>";
          var ckInfo = c.ck_confidence !== null
            ? " | CK: " + (c.ck_confidence * 100).toFixed(0) + "% confidence, " + c.ck_answerability
            : " | CK: unavailable";

          var diagHtml = "";
          if (c.winner_reason) {
            diagHtml += "<div class='diag-row'><span class='diag-label'>Winner reason:</span> <span class='diag-value'>" + c.winner_reason + "</span></div>";
          }
          if (c.ck_confidence !== null && c.overall_winner === "rag") {
            if (c.ck_retrieval_score !== null) {
              diagHtml += "<div class='diag-row'><span class='diag-label'>CK retrieval score:</span> <span class='diag-value'>" + c.ck_retrieval_score.toFixed(3) + "</span></div>";
            }
            if (c.ck_source_count !== null) {
              diagHtml += "<div class='diag-row'><span class='diag-label'>CK sources:</span> <span class='diag-value'>" + c.ck_source_count + "</span></div>";
            }
            if (c.ck_answer) {
              diagHtml += "<div class='diag-row'><span class='diag-label'>CK answer:</span> <span class='diag-value diag-answer'>" + c.ck_answer.substring(0, 300) + "</span></div>";
            }
            if (c.ck_missing_evidence) {
              diagHtml += "<div class='diag-row'><span class='diag-label'>Missing evidence:</span> <span class='diag-value'>" + c.ck_missing_evidence + "</span></div>";
            }
          }

          var issueBtn = "";
          if (c.overall_winner === "rag") {
            issueBtn = "<a class='create-issue-btn' href='" + buildIssueUrl(c) + "' target='_blank' rel='noopener'>Create Issue</a>";
          }

          html +=
            "<div class='case-item'>" +
            "<div class='case-header'>" +
            winnerBadge +
            " <span class='case-query'>" + c.query + "</span>" +
            issueBtn +
            "</div>" +
            "<div class='case-meta'>" +
            c.category.replace(/_/g, " ") +
            " | RAG: " + c.rag_tokens + " tokens, " + c.rag_sections + " sections, " + c.rag_time_ms + "ms" +
            ckInfo +
            "</div>" +
            diagHtml +
            "</div>";
        });
        html += "</div>";

        detailTd.innerHTML = html;
        detailTr.appendChild(detailTd);
        afterRow.insertAdjacentElement("afterend", detailTr);
      })
      .catch(function () {
        showError("Failed to load run details");
      });
  }

  // ── Main load ────────────────────────────────────────────────────

  function loadDashboard() {
    fetchJSON("/api/comparison/stats")
      .then(function (stats) {
        // Stat chips
        renderStat("stat-total-runs", stats.totalRuns);
        renderStat("stat-total-cases", stats.totalCases);
        renderStat("stat-ck-wins", stats.overallWins.claimkit);
        renderStat("stat-rag-wins", stats.overallWins.rag);
        renderStat("stat-ck-conf", Math.round(stats.avgCkConfidence * 100) + "%");
        renderStat("stat-answerability", Math.round(stats.avgAnswerabilityRate * 100) + "%");

        // Charts
        if (stats.totalCases > 0) {
          renderWinRateChart(stats);
          renderAnswerabilityChart(stats);
          renderProcessingTimeChart(stats);
          renderCategoryChart(stats);
        } else {
          showEmpty("winrate-empty");
          showEmpty("answerability-empty");
          showEmpty("time-empty");
          showEmpty("category-empty");
        }

        // Runs table
        renderRunsTable(stats.recentRuns);
      })
      .catch(function (err) {
        showError("Failed to load dashboard: " + err.message);
      });

    // Confidence trend (separate endpoint)
    fetchJSON("/api/comparison/trends?days=30")
      .then(function (trends) {
        if (trends.length > 0) {
          renderConfidenceTrend(trends);
        } else {
          showEmpty("trend-empty");
        }
      })
      .catch(function () {
        showEmpty("trend-empty");
      });
  }

  // ── Clear button ─────────────────────────────────────────────────

  function initClearButton() {
    var btn = document.getElementById("clear-btn");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      if (!confirm("Clear all comparison data? This cannot be undone.")) return;
      btn.disabled = true;
      btn.textContent = "Clearing…";
      try {
        var res = await fetch("/api/comparison/runs", { method: "DELETE" });
        if (!res.ok) throw new Error("Server error " + res.status);
        await loadDashboard();
      } catch (e) {
        showError("Clear failed: " + e.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg> Clear Data';
      }
    });
  }

  // ── Init ─────────────────────────────────────────────────────────

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { loadDashboard(); initClearButton(); });
  } else {
    loadDashboard();
    initClearButton();
  }
})();
