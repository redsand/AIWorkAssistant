/**
 * Cold-start ingestion badge.
 *
 * Polls /health/ingestion every 5 s while ingestion is in flight. Shows a
 * compact "KG warming up" badge with phase + count. Hides itself once the
 * server reports isReady=true. Stops polling on failure (with a visible
 * warning) so we don't hammer the endpoint forever on a broken setup.
 */

import { API_BASE } from "./state.js";
import { authHeaders } from "./auth.js";

const POLL_INTERVAL_MS = 5_000;
const MAX_CONSECUTIVE_ERRORS = 6;

let pollTimer = null;
let consecutiveErrors = 0;
let lastSnapshot = null;
let lastErrorState = false;
let clickHandlerBound = false;

function el() {
  return document.getElementById("ingestionBadge");
}

function popoverEl() {
  return document.getElementById("ingestionPopover");
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleTimeString();
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return null;
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function phaseRow(p) {
  const done = (p.ingested || 0) + (p.skipped || 0);
  const state =
    p.completedAt !== null ? "✅" : p.startedAt !== null ? "🔄" : "⏳";
  const errors = p.errors
    ? ` <span class="ingestion-popover-errors">${p.errors} errors</span>`
    : "";
  const skipped = p.skipped ? `, ${p.skipped} skipped` : "";
  return `<div class="ingestion-popover-row">
    <span>${state} ${labelFor(p.name)}</span>
    <span>${done}/${p.total || 0}${skipped}${errors}</span>
  </div>`;
}

function renderPopover() {
  const pop = popoverEl();
  if (!pop) return;

  if (lastErrorState || !lastSnapshot) {
    pop.innerHTML = `<div class="ingestion-popover-title">Knowledge graph status</div>
      <div class="ingestion-popover-row">Status endpoint unreachable — check <code>/health/ingestion</code> and the server log.</div>`;
    return;
  }

  const s = lastSnapshot;
  const status = s.disabled
    ? "⏸️ Disabled"
    : s.failed
      ? "⚠️ Ingestion failed — see server log"
      : s.isReady
        ? "✅ Ready"
        : "🔄 Warming up (cold-start ingestion)";
  const reason = s.reason
    ? `<div class="ingestion-popover-status">${s.reason}</div>`
    : "";
  const phases = (s.phases || []).map(phaseRow).join("");
  const duration = fmtDuration(s.durationMs);
  pop.innerHTML = `<div class="ingestion-popover-title">Knowledge graph status</div>
    <div class="ingestion-popover-status">${status}</div>
    ${reason}
    ${phases || '<div class="ingestion-popover-row">No phases reported yet.</div>'}
    <div class="ingestion-popover-meta">Started ${fmtTime(s.startedAt)}${duration ? ` · took ${duration}` : ""}</div>`;
}

function togglePopover(force) {
  const badge = el();
  if (!badge) return;
  let pop = popoverEl();
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "ingestionPopover";
    pop.className = "ingestion-popover";
    pop.style.display = "none";
    document.body.appendChild(pop);
  }
  const show = force !== undefined ? force : pop.style.display === "none";
  if (show) {
    renderPopover();
    const rect = badge.getBoundingClientRect();
    pop.style.top = `${rect.bottom + 6}px`;
    pop.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    pop.style.display = "block";
    // Refresh immediately so the numbers are current when opened.
    void pollOnce();
  } else {
    pop.style.display = "none";
  }
}

function bindClickHandler() {
  if (clickHandlerBound) return;
  const badge = el();
  if (!badge) return;
  clickHandlerBound = true;
  badge.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopover();
  });
  document.addEventListener("click", (e) => {
    const pop = popoverEl();
    if (pop && pop.style.display !== "none" && !pop.contains(e.target)) {
      togglePopover(false);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") togglePopover(false);
  });
}

function summarize(snapshot) {
  const phases = snapshot.phases || [];
  if (phases.length === 0) return "🔄 KG warming up…";

  // Find the first phase that hasn't completed yet, otherwise the last one.
  const active =
    phases.find((p) => p.completedAt === null) || phases[phases.length - 1];
  const total = active.total || 0;
  const done = (active.ingested || 0) + (active.skipped || 0);
  const label = labelFor(active.name);
  if (total === 0) return `🔄 ${label} — empty`;
  return `🔄 ${label}: ${done}/${total}`;
}

function labelFor(phaseName) {
  switch (phaseName) {
    case "knowledge":
      return "Knowledge";
    case "graph-nodes":
      return "Graph nodes";
    case "graph-edges":
      return "Graph edges";
    default:
      return phaseName;
  }
}

function render(snapshot, errorState) {
  const badge = el();
  if (!badge) return;

  lastSnapshot = snapshot;
  lastErrorState = errorState;
  const pop = popoverEl();
  if (pop && pop.style.display !== "none") {
    renderPopover();
  }

  if (errorState) {
    badge.textContent = "⚠️ KG status unavailable";
    badge.className = "ingestion-badge ingestion-badge-error";
    badge.style.display = "inline-flex";
    return;
  }

  if (snapshot.isReady) {
    badge.style.display = "none";
    togglePopover(false);
    return;
  }

  if (snapshot.failed) {
    badge.textContent = "⚠️ KG ingestion failed";
    badge.className = "ingestion-badge ingestion-badge-error";
    badge.style.display = "inline-flex";
    return;
  }

  // Not started yet OR not failed → still in progress.
  badge.textContent = summarize(snapshot);
  badge.className = "ingestion-badge ingestion-badge-warming";
  badge.style.display = "inline-flex";
}

async function pollOnce() {
  try {
    const res = await fetch(`${API_BASE}/health/ingestion`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        render(null, true);
        stopPolling();
      }
      return;
    }
    consecutiveErrors = 0;
    const snapshot = await res.json();
    render(snapshot, false);

    if (snapshot.isReady) {
      // Job done — we don't need to poll again until next page load.
      stopPolling();
    }
  } catch {
    consecutiveErrors++;
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      render(null, true);
      stopPolling();
    }
  }
}

export function startIngestionBadgePolling() {
  if (pollTimer) return;
  bindClickHandler();
  // First poll immediately so the badge is accurate before the first interval.
  void pollOnce();
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
