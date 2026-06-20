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

function el() {
  return document.getElementById("ingestionBadge");
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

  if (errorState) {
    badge.textContent = "⚠️ KG status unavailable";
    badge.className = "ingestion-badge ingestion-badge-error";
    badge.style.display = "inline-flex";
    return;
  }

  if (snapshot.isReady) {
    badge.style.display = "none";
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
