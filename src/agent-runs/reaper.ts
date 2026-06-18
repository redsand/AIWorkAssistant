import { agentRunDatabase } from "./database";
import { env } from "../config/env";

/**
 * Periodic reaper for stuck agent_runs rows. Marks runs as failed when
 * their last_activity_at is older than the stale threshold. Necessary
 * because runs can enter the model/tool loop and stop progressing
 * without calling completeRun or failRun — the UI then shows them as
 * live indefinitely.
 *
 * Discovered via session 0a6a8d8d (2026-06-11) where a glm-5.1 tool
 * confusion loop left two runs in status='running' with no terminal
 * state ever set.
 *
 * The threshold is controlled by AICODER_STALE_TIMEOUT_MINUTES. Set it
 * to 0 to disable the reaper entirely (useful for supervised long runs).
 */

function getStaleAfterMs(): number {
  const minutes = Number(env.AICODER_STALE_TIMEOUT_MINUTES);
  if (Number.isNaN(minutes) || minutes <= 0) return 0;
  return minutes * 60 * 1000;
}

const REAPER_INTERVAL_MS = 60 * 1000; // run once per minute

let reaperTimer: NodeJS.Timeout | null = null;

type OnReapCallback = (sessionIds: string[]) => void;
let onReapCallback: OnReapCallback | null = null;

/**
 * Register a callback invoked with the session_ids that were just reaped.
 * Chat routes use this to also abort the in-memory ProcessingJob, releasing
 * its aiRequestLimiter slot — the DB update alone doesn't reach the inflight
 * provider HTTP call, so without this hook a slot stays held until the socket
 * dies (observed: 48 minutes in session 926107f7).
 */
export function setOnReapCallback(cb: OnReapCallback | null): void {
  onReapCallback = cb;
}

export function startStaleAgentRunReaper(): void {
  if (reaperTimer) return;
  const staleAfterMs = getStaleAfterMs();
  if (staleAfterMs === 0) {
    console.log("[AgentRunReaper] disabled (AICODER_STALE_TIMEOUT_MINUTES=0)");
    return;
  }
  reaperTimer = setInterval(() => {
    try {
      const threshold = getStaleAfterMs();
      if (threshold === 0) return; // disabled mid-flight
      const { count, sessionIds } = agentRunDatabase.reapStaleRunningRuns(threshold);
      if (count > 0) {
        console.log(`[AgentRunReaper] marked ${count} stuck run(s) as failed (no activity for ${threshold / 1000}s)`);
        if (onReapCallback && sessionIds.length > 0) {
          try { onReapCallback(sessionIds); } catch (e) { console.error("[AgentRunReaper] onReap callback failed:", e); }
        }
      }
    } catch (err) {
      console.error("[AgentRunReaper] reap failed:", err);
    }
  }, REAPER_INTERVAL_MS);
  // Don't keep the event loop alive solely for the reaper.
  if (typeof reaperTimer.unref === "function") reaperTimer.unref();
  console.log(`[AgentRunReaper] started (stale threshold: ${staleAfterMs / 1000}s, check interval: ${REAPER_INTERVAL_MS / 1000}s)`);
}

export function stopStaleAgentRunReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}
