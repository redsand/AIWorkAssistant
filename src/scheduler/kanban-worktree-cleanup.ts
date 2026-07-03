import { agentRunDatabase } from "../agent-runs/database";
import { removeWorktree } from "../kanban/worktree-manager";
import { kanbanEvents } from "../kanban/events";

let intervalHandle: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 5 * 60 * 1000; // 5 minutes

/**
 * One tick of the auto-cleanup loop.
 *
 * For every completed agent run whose linked card is in the "done" column
 * (detected via the run's `completed_at` timestamp) **and** whose worktree
 * still exists on disk, remove the worktree if more than `autoCleanupHours`
 * have elapsed since the run completed.
 *
 * `aicoder` runners reuse a single persistent workspace across every cycle
 * (see `ensurePersistentWorktree` / `deps.workspace` in run-prelude.ts), so
 * that same path is stamped onto every run row for that runner — including
 * ones from hours ago that have long since completed. Deleting it based
 * solely on an old run's `completedAt` would rip the directory out from
 * under whatever cycle is *currently* running there. So paths that still
 * match a runner's live `workspacePath` are always excluded, regardless of
 * how old the individual run is.
 *
 * Exported so tests can call it with a fake clock.
 */
export async function runCleanupTick(
  now: Date = new Date(),
  getSetting: (key: string) => string | null = (key) =>
    agentRunDatabase.getKanbanSetting(key),
  listRuns: typeof agentRunDatabase.listRuns = (f) =>
    agentRunDatabase.listRuns(f),
  listRunners: typeof agentRunDatabase.listRunners = () =>
    agentRunDatabase.listRunners(),
): Promise<{ cleaned: number; skipped: number }> {
  const rawHours = getSetting("autoCleanupHours");
  const hours = rawHours !== null ? Number(rawHours) : 24;

  // hours = 0 means disabled
  if (hours === 0 || !Number.isFinite(hours) || hours < 0) {
    return { cleaned: 0, skipped: 0 };
  }

  const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();

  const liveWorkspacePaths = new Set(
    listRunners()
      .map((r) => r.workspacePath)
      .filter((p): p is string => !!p),
  );

  // Find completed/failed runs with worktree paths
  const completed = listRuns({ status: "completed", limit: 10000 });
  const failed = listRuns({ status: "failed", limit: 10000 });
  const allDone = [...completed.runs, ...failed.runs].filter(
    (r) =>
      r.worktreePath &&
      r.completedAt &&
      r.completedAt < cutoff &&
      !liveWorkspacePaths.has(r.worktreePath),
  );

  let cleaned = 0;
  let skipped = 0;

  for (const run of allDone) {
    if (!run.worktreePath) continue;

    try {
      await removeWorktree(run.worktreePath, { force: true });
      kanbanEvents.emitEvent({
        type: "worktree.changed",
        path: run.worktreePath,
        status: "removed",
      });
      cleaned++;
    } catch {
      skipped++;
    }
  }

  if (cleaned > 0) {
    console.log(
      `[Kanban Cleanup] Removed ${cleaned} worktree(s) older than ${hours}h`,
    );
  }

  return { cleaned, skipped };
}

export function startKanbanCleanupScheduler(): void {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;

  console.log("[Kanban Cleanup] Starting worktree auto-cleanup scheduler (every 5 min)");
  intervalHandle = setInterval(() => {
    runCleanupTick().catch((err) => {
      console.error("[Kanban Cleanup] Tick failed:", err);
    });
  }, TICK_MS);
  intervalHandle.unref();
}

export function stopKanbanCleanupScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
