import { agentRunDatabase } from "./database";

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
 */

const STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes of silence
const REAPER_INTERVAL_MS = 60 * 1000; // run once per minute

let reaperTimer: NodeJS.Timeout | null = null;

export function startStaleAgentRunReaper(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    try {
      const reaped = agentRunDatabase.reapStaleRunningRuns(STALE_AFTER_MS);
      if (reaped > 0) {
        console.log(`[AgentRunReaper] marked ${reaped} stuck run(s) as failed (no activity for ${STALE_AFTER_MS / 1000}s)`);
      }
    } catch (err) {
      console.error("[AgentRunReaper] reap failed:", err);
    }
  }, REAPER_INTERVAL_MS);
  // Don't keep the event loop alive solely for the reaper.
  if (typeof reaperTimer.unref === "function") reaperTimer.unref();
  console.log(`[AgentRunReaper] started (stale threshold: ${STALE_AFTER_MS / 1000}s, check interval: ${REAPER_INTERVAL_MS / 1000}s)`);
}

export function stopStaleAgentRunReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}
