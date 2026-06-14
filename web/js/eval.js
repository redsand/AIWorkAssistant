// Phase 2 calibration eval UI.
// Talks to /api/eval-calibration/* — see src/eval/calibration/api.ts.

const API = "/api/eval-calibration";

const state = {
  segments: [],
  cases: [],
  selectedCaseId: null,
  detail: null,
  // Per-run draft rating state, keyed by runId
  draftRatings: new Map(),
};

let calibrationChart = null;

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  loadSegments().then(() => {
    refreshCases();
    refreshStats();
    refreshAnalysis();
  });
});

function bindEvents() {
  document.getElementById("add-case-btn").addEventListener("click", openAddCaseModal);
  document.getElementById("add-case-cancel").addEventListener("click", closeAddCaseModal);
  document.getElementById("add-case-save").addEventListener("click", saveNewCase);
  document.querySelector("#add-case-modal .modal-backdrop").addEventListener("click", closeAddCaseModal);
  document.getElementById("run-all-btn").addEventListener("click", runAllUnrun);
  document
    .getElementById("segment-filter")
    .addEventListener("change", refreshCases);
  document
    .getElementById("refresh-analysis-btn")
    .addEventListener("click", refreshAnalysis);
}

// ── Loaders ─────────────────────────────────────────────────────────

async function loadSegments() {
  try {
    const res = await fetch(`${API}/segments`);
    const data = await res.json();
    state.segments = data.segments ?? [];
    const filter = document.getElementById("segment-filter");
    const modal = document.getElementById("new-case-segment");
    for (const s of state.segments) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      filter.appendChild(opt);
      const opt2 = opt.cloneNode(true);
      modal.appendChild(opt2);
    }
  } catch (err) {
    showError(`Failed to load segments: ${err.message}`);
  }
}

async function refreshCases() {
  try {
    const segment = document.getElementById("segment-filter").value;
    const url = segment ? `${API}/cases?segment=${encodeURIComponent(segment)}` : `${API}/cases`;
    const res = await fetch(url);
    const data = await res.json();
    state.cases = data.cases ?? [];
    renderCases();
  } catch (err) {
    showError(`Failed to load cases: ${err.message}`);
  }
}

async function refreshStats() {
  // Stats are derived client-side from the case list + a calibration call.
  // Cheaper than another DB query, and the data is small.
  try {
    const totalCases = state.cases.length;
    let totalRuns = 0;
    let totalRatings = 0;
    for (const c of state.cases) {
      if (c.hasRagRun) totalRuns++;
      if (c.hasClaimkitRun) totalRuns++;
      if (c.ragRated) totalRatings++;
      if (c.claimkitRated) totalRatings++;
    }
    document.getElementById("stat-cases").textContent = totalCases;
    document.getElementById("stat-runs").textContent = totalRuns;
    document.getElementById("stat-ratings").textContent = totalRatings;

    const res = await fetch(`${API}/calibration?system=claimkit`);
    const data = await res.json();
    document.getElementById("stat-pairs-ck").textContent =
      (data.pairs ?? []).length;
  } catch (err) {
    console.warn("stats refresh failed", err);
  }
}

// ── Render ──────────────────────────────────────────────────────────

function renderCases() {
  const list = document.getElementById("cases-list");
  if (!state.cases.length) {
    list.innerHTML = `<div class="empty-state">No cases yet — click "Add case" to start.</div>`;
    return;
  }
  list.innerHTML = "";
  for (const c of state.cases) {
    const row = document.createElement("div");
    row.className = "case-row" + (c.id === state.selectedCaseId ? " selected" : "");
    row.dataset.caseId = c.id;

    const ragStatus = c.hasRagRun
      ? c.ragRated
        ? `<span class="status-pill done">RAG rated</span>`
        : `<span class="status-pill pending">RAG unrated</span>`
      : `<span class="status-pill missing">RAG not run</span>`;
    const ckStatus = c.hasClaimkitRun
      ? c.claimkitRated
        ? `<span class="status-pill done">CK rated</span>`
        : `<span class="status-pill pending">CK unrated</span>`
      : `<span class="status-pill missing">CK not run</span>`;

    row.innerHTML = `
      <div class="case-query" title="${escapeHtml(c.query)}">${escapeHtml(c.query)}</div>
      <div class="case-segment">${escapeHtml(c.segment)}</div>
      ${ragStatus}
      ${ckStatus}
      <button class="secondary-btn run-case-btn" data-case-id="${c.id}">Run</button>
    `;
    row.addEventListener("click", (e) => {
      if (e.target.closest(".run-case-btn")) return;
      selectCase(c.id);
    });
    list.appendChild(row);
  }
  list.querySelectorAll(".run-case-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      runSingleCase(btn.dataset.caseId);
    });
  });
}

async function selectCase(caseId) {
  state.selectedCaseId = caseId;
  document
    .querySelectorAll(".case-row")
    .forEach((el) => el.classList.toggle("selected", el.dataset.caseId === caseId));
  try {
    const res = await fetch(`${API}/cases/${caseId}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    state.detail = await res.json();
    renderDetail();
  } catch (err) {
    showError(`Failed to load case detail: ${err.message}`);
  }
}

function renderDetail() {
  const panel = document.getElementById("detail-panel");
  const body = document.getElementById("detail-body");
  if (!state.detail) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const { case: c, runs } = state.detail;
  const ragRun = runs.find((r) => r.system === "rag") ?? null;
  const ckRun = runs.find((r) => r.system === "claimkit") ?? null;

  body.innerHTML = `
    <div class="detail-header">
      <div>
        <div class="detail-query">${escapeHtml(c.query)}</div>
        <div class="detail-meta">segment: ${escapeHtml(c.segment)} · created ${escapeHtml(c.createdAt)}</div>
      </div>
      <div class="detail-actions">
        <button class="secondary-btn" id="detail-run-btn">Run / re-check</button>
        <button class="secondary-btn" id="detail-delete-btn">Delete case</button>
      </div>
    </div>
    ${c.expectedAnswer ? `<div class="detail-expected"><strong>Expected:</strong> ${escapeHtml(c.expectedAnswer)}</div>` : ""}
    <div class="runs-grid">
      ${renderRunCard("rag", ragRun)}
      ${renderRunCard("claimkit", ckRun)}
    </div>
  `;

  document.getElementById("detail-run-btn").addEventListener("click", () => runSingleCase(c.id));
  document.getElementById("detail-delete-btn").addEventListener("click", () => deleteCase(c.id));

  // Wire rating controls
  body.querySelectorAll(".likert-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const runId = btn.dataset.runId;
      const value = parseInt(btn.dataset.value, 10);
      const draft = ensureDraft(runId);
      draft.rating = value;
      body
        .querySelectorAll(`.likert-btn[data-run-id="${runId}"]`)
        .forEach((b) => b.classList.toggle("selected", parseInt(b.dataset.value, 10) === value));
    });
  });
  body.querySelectorAll(".flag-checkbox").forEach((cb) => {
    cb.addEventListener("change", () => {
      const draft = ensureDraft(cb.dataset.runId);
      draft[cb.dataset.flag] = cb.checked;
    });
  });
  body.querySelectorAll(".rating-notes").forEach((ta) => {
    ta.addEventListener("input", () => {
      const draft = ensureDraft(ta.dataset.runId);
      draft.notes = ta.value;
    });
  });
  body.querySelectorAll(".rating-submit").forEach((btn) => {
    btn.addEventListener("click", () => submitRating(btn.dataset.runId));
  });
}

function renderRunCard(system, run) {
  if (!run) {
    return `<div class="run-card ${system}">
      <div class="run-header"><div class="run-system-label">${system.toUpperCase()}</div></div>
      <div class="empty-state">No run yet — click "Run / re-check" above.</div>
    </div>`;
  }
  const draft = state.draftRatings.get(run.id) ?? null;
  const conf = run.confidence != null ? Number(run.confidence).toFixed(3) : "—";
  const halluc = run.hallucinationRate != null ? Number(run.hallucinationRate).toFixed(3) : null;
  const grounded = run.grounded === true ? "grounded ✓" : run.grounded === false ? "ungrounded ✗" : null;

  return `<div class="run-card ${system}">
    <div class="run-header">
      <div class="run-system-label">${system.toUpperCase()}</div>
      <div class="run-confidence">confidence: ${conf}</div>
    </div>
    ${run.errorMessage ? `<div class="run-error">${escapeHtml(run.errorMessage)}</div>` : ""}
    <div class="run-answer">${escapeHtml(run.answer ?? "(no answer)")}</div>
    <div class="run-meta">
      ${run.processingTimeMs != null ? `<span>${run.processingTimeMs}ms</span>` : ""}
      ${run.contextTokens != null ? `<span>${run.contextTokens} tok</span>` : ""}
      ${halluc != null ? `<span>halluc: ${halluc}</span>` : ""}
      ${grounded ? `<span>${grounded}</span>` : ""}
    </div>
    ${renderRatingBlock(run, draft)}
  </div>`;
}

function renderRatingBlock(run, draft) {
  const existing = run.ratings ?? [];
  const existingMarkup = existing.length
    ? `<div class="existing-ratings">Existing ratings: ${existing
        .map(
          (r) =>
            `<strong>${r.rating}/4</strong>${r.rater ? ` by ${escapeHtml(r.rater)}` : ""}${r.notes ? ` — ${escapeHtml(r.notes)}` : ""}`,
        )
        .join("<br>")}</div>`
    : "";

  const selectedValue = draft?.rating ?? null;
  const likertButtons = [0, 1, 2, 3, 4]
    .map(
      (v) =>
        `<button class="likert-btn${v === selectedValue ? " selected" : ""}" data-run-id="${run.id}" data-value="${v}">${v}</button>`,
    )
    .join("");

  return `<div class="rating-block">
    <div class="rating-block-title">Rate this answer (0 wrong → 4 fully right)</div>
    <div class="likert-row">${likertButtons}</div>
    <div class="flag-row">
      <label><input type="checkbox" class="flag-checkbox" data-run-id="${run.id}" data-flag="correct" ${draft?.correct ? "checked" : ""}> correct</label>
      <label><input type="checkbox" class="flag-checkbox" data-run-id="${run.id}" data-flag="complete" ${draft?.complete ? "checked" : ""}> complete</label>
      <label><input type="checkbox" class="flag-checkbox" data-run-id="${run.id}" data-flag="grounded" ${draft?.grounded ? "checked" : ""}> grounded</label>
    </div>
    <textarea class="rating-notes" data-run-id="${run.id}" rows="2" placeholder="Notes (optional)">${escapeHtml(draft?.notes ?? "")}</textarea>
    <button class="primary-btn rating-submit" data-run-id="${run.id}">Save rating</button>
    ${existingMarkup}
  </div>`;
}

function ensureDraft(runId) {
  if (!state.draftRatings.has(runId)) {
    state.draftRatings.set(runId, {
      rating: null,
      correct: false,
      complete: false,
      grounded: false,
      notes: "",
    });
  }
  return state.draftRatings.get(runId);
}

// ── Mutations ───────────────────────────────────────────────────────

async function saveNewCase() {
  const query = document.getElementById("new-case-query").value.trim();
  const segment = document.getElementById("new-case-segment").value;
  const expected = document.getElementById("new-case-expected").value.trim() || null;
  const notes = document.getElementById("new-case-notes").value.trim() || null;
  if (!query) {
    showError("Query is required");
    return;
  }
  try {
    const res = await fetch(`${API}/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, segment, expectedAnswer: expected, notes }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `status ${res.status}`);
    }
    closeAddCaseModal();
    await refreshCases();
    refreshStats();
  } catch (err) {
    showError(`Failed to save case: ${err.message}`);
  }
}

async function deleteCase(caseId) {
  if (!confirm("Delete this case and all its runs/ratings?")) return;
  try {
    const res = await fetch(`${API}/cases/${caseId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    state.detail = null;
    state.selectedCaseId = null;
    document.getElementById("detail-panel").hidden = true;
    await refreshCases();
    refreshStats();
  } catch (err) {
    showError(`Failed to delete: ${err.message}`);
  }
}

async function runSingleCase(caseId) {
  try {
    setBusy(true);
    const res = await fetch(`${API}/cases/${caseId}/run`, { method: "POST" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    await refreshCases();
    if (state.selectedCaseId === caseId) await selectCase(caseId);
    refreshStats();
  } catch (err) {
    showError(`Run failed: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

async function runAllUnrun() {
  if (!confirm("Run RAG + ClaimKit on every case missing a run? This may take a while.")) return;
  try {
    setBusy(true);
    const res = await fetch(`${API}/run-all`, { method: "POST" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    alert(`Run complete. attempted=${data.attempted}, succeeded=${data.succeeded}, errored=${data.errored}`);
    await refreshCases();
    if (state.selectedCaseId) await selectCase(state.selectedCaseId);
    refreshStats();
  } catch (err) {
    showError(`Run-all failed: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

async function submitRating(runId) {
  const draft = state.draftRatings.get(runId);
  if (!draft || draft.rating == null) {
    showError("Pick a 0–4 rating first");
    return;
  }
  try {
    const res = await fetch(`${API}/runs/${runId}/ratings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rating: draft.rating,
        correct: draft.correct,
        complete: draft.complete,
        grounded: draft.grounded,
        notes: draft.notes || null,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `status ${res.status}`);
    }
    state.draftRatings.delete(runId);
    if (state.selectedCaseId) await selectCase(state.selectedCaseId);
    await refreshCases();
    refreshStats();
    refreshAnalysis();
  } catch (err) {
    showError(`Rating failed: ${err.message}`);
  }
}

// ── Modal helpers ───────────────────────────────────────────────────

function openAddCaseModal() {
  document.getElementById("new-case-query").value = "";
  document.getElementById("new-case-expected").value = "";
  document.getElementById("new-case-notes").value = "";
  document.getElementById("add-case-modal").hidden = false;
}

function closeAddCaseModal() {
  document.getElementById("add-case-modal").hidden = true;
}

// ── Helpers ─────────────────────────────────────────────────────────

function showError(msg) {
  const banner = document.getElementById("error-banner");
  banner.textContent = msg;
  banner.hidden = false;
  setTimeout(() => {
    banner.hidden = true;
  }, 5000);
}

function setBusy(busy) {
  document.querySelectorAll("button").forEach((b) => (b.disabled = busy));
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Phase 3 calibration analysis ────────────────────────────────────

async function refreshAnalysis() {
  try {
    const res = await fetch(`${API}/analysis?system=claimkit`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    renderAnalysis(data);
    // Refreshing analysis usually means ratings changed — re-derive
    // top-of-page stats so the rated counter stays in sync.
    refreshStats();
  } catch (err) {
    console.warn("analysis refresh failed", err);
  }
}

function renderAnalysis(data) {
  const empty = document.getElementById("analysis-empty");
  const body = document.getElementById("analysis-body");

  if (!data || data.sampleSize === 0) {
    empty.hidden = false;
    body.hidden = true;
    if (calibrationChart) {
      calibrationChart.destroy();
      calibrationChart = null;
    }
    return;
  }
  empty.hidden = true;
  body.hidden = false;

  // Metrics row
  document.getElementById("metric-sample").textContent = data.sampleSize;
  document.getElementById("metric-ece").textContent = data.reliability.ece.toFixed(3);
  document.getElementById("metric-rmse").textContent = data.reliability.rmse.toFixed(3);
  // Mean signed gap: sum of (conf - rating) / n. Negative means the
  // system is systematically under-confident (over-penalized).
  const meanGap =
    data.pairs.reduce((acc, p) => acc + (p.confidence - p.ratingNormalized), 0) /
    data.pairs.length;
  const gapEl = document.getElementById("metric-gap");
  gapEl.textContent = (meanGap >= 0 ? "+" : "") + meanGap.toFixed(3);
  gapEl.style.color = meanGap < -0.05 ? "#991b1b" : meanGap > 0.05 ? "#92400e" : "#065f46";

  renderCalibrationChart(data);
  renderSegmentTable(data.perSegment);
  renderPenaltyTable(data.perPenalty);
}

function renderCalibrationChart(data) {
  const canvas = document.getElementById("calibration-chart");
  const ctx = canvas.getContext("2d");
  if (calibrationChart) calibrationChart.destroy();

  // Scatter: each rated run as (confidence, rating/4)
  const scatter = data.pairs.map((p) => ({ x: p.confidence, y: p.ratingNormalized }));
  // Reliability line: bin midpoint x bin avg rating
  const reliabilityLine = data.reliability.bins
    .filter((b) => b.count > 0)
    .map((b) => ({ x: b.avgConfidence, y: b.avgRatingNormalized }));
  // Diagonal y = x
  const diagonal = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ];

  calibrationChart = new Chart(ctx, {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Perfect calibration",
          type: "line",
          data: diagonal,
          borderColor: "#9ca3af",
          borderDash: [4, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0,
        },
        {
          label: "Reliability bins",
          type: "line",
          data: reliabilityLine,
          borderColor: "#667eea",
          backgroundColor: "#667eea",
          pointRadius: 5,
          pointHoverRadius: 7,
          borderWidth: 2,
          fill: false,
          tension: 0,
        },
        {
          label: "Per-run (raw)",
          data: scatter,
          backgroundColor: "rgba(245, 158, 11, 0.55)",
          borderColor: "#f59e0b",
          pointRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          type: "linear",
          min: 0,
          max: 1,
          title: { display: true, text: "Predicted confidence" },
        },
        y: {
          type: "linear",
          min: 0,
          max: 1,
          title: { display: true, text: "Human rating (normalized to 0–1)" },
        },
      },
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              `(${ctx.parsed.x.toFixed(2)}, ${ctx.parsed.y.toFixed(2)})`,
          },
        },
      },
    },
  });
}

function renderSegmentTable(rows) {
  const tbody = document.querySelector("#segment-table tbody");
  if (!rows || !rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#888;">No data</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .map(
      (r) => `
      <tr>
        <td>${escapeHtml(r.segment)}</td>
        <td>${r.sampleSize}</td>
        <td>${r.avgConfidence.toFixed(3)}</td>
        <td>${r.avgRatingNormalized.toFixed(3)}</td>
        <td style="color:${r.gap < -0.05 ? "#991b1b" : r.gap > 0.05 ? "#92400e" : "#065f46"}">
          ${r.gap >= 0 ? "+" : ""}${r.gap.toFixed(3)}
        </td>
      </tr>`,
    )
    .join("");
}

function renderPenaltyTable(rows) {
  const tbody = document.querySelector("#penalty-table tbody");
  if (!rows || !rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#888;">No confidence_trace data — runs predate Phase 1 telemetry, or no ratings yet</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .sort((a, b) => b.firedCount - a.firedCount)
    .map((r) => {
      // Suspicion heuristic: penalty fires often AND average rating
      // when it fires is high (≥3 out of 4). That's the over-penalizer
      // signature: the human says the answer was right, but the system
      // still hit it with a penalty.
      let suspicion = "low";
      if (r.firedCount >= 3 && r.avgRatingWhenFired >= 3) {
        suspicion = "high";
      } else if (r.firedCount >= 3 && r.avgRatingWhenFired >= 2) {
        suspicion = "med";
      }
      return `
        <tr>
          <td>${escapeHtml(r.penalty)}</td>
          <td>${r.firedCount} / ${r.firedCount + r.notFiredCount}</td>
          <td>${r.avgRatingWhenFired.toFixed(2)}</td>
          <td>${r.avgRatingWhenNotFired.toFixed(2)}</td>
          <td>${r.avgMagnitudeWhenFired.toFixed(3)}</td>
          <td><span class="suspicion-pill ${suspicion}">${suspicion}</span></td>
        </tr>`;
    })
    .join("");
}
