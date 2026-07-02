/**
 * Singleton orchestrator for UI-configured runners.
 *
 * Responsibilities:
 *   - On server boot: load every enabled runner from the DB and start a loop.
 *   - Expose start / pause / stop / run-now / delete operations.
 *   - Track per-runner loop handles in-process; the DB row is the source of
 *     truth for status so the UI can survive a server restart.
 *   - Graceful shutdown: stop all loops and wait for children to exit.
 */

import { agentRunDatabase } from "../agent-runs/database";
import type {
  Runner,
  RunnerCreateParams,
  RunnerUpdateParams,
} from "../agent-runs/types";
import { RunnerLoop } from "./runner-loop";
import { runnerEvents } from "./runner-events";

class RunnerManager {
  private loops = new Map<string, RunnerLoop>();

  /** Start loops for every enabled runner. Called once at server boot. */
  bootEnabled(): void {
    const runners = agentRunDatabase.listRunners();
    for (const runner of runners) {
      if (runner.enabled) {
        this.spawnLoop(runner.id);
      } else {
        agentRunDatabase.setRunnerStatus(runner.id, "paused");
      }
    }
    console.log(`[RunnerManager] Booted ${this.loops.size} enabled runner(s)`);
  }

  list(): Runner[] {
    return agentRunDatabase.listRunners();
  }

  get(id: string): Runner | null {
    return agentRunDatabase.getRunner(id);
  }

  create(params: RunnerCreateParams): Runner {
    const runner = agentRunDatabase.createRunner(params);
    runnerEvents.emitEvent({ type: "runner.created", runner });
    if (runner.enabled) {
      this.spawnLoop(runner.id);
    }
    return runner;
  }

  async update(id: string, patch: RunnerUpdateParams): Promise<Runner | null> {
    const before = agentRunDatabase.getRunner(id);
    if (!before) return null;
    const updated = agentRunDatabase.updateRunner(id, patch);
    if (!updated) return null;
    runnerEvents.emitEvent({ type: "runner.updated", runner: updated });

    // Enable / disable transitions
    const becameEnabled = !before.enabled && updated.enabled;
    const becameDisabled = before.enabled && !updated.enabled;
    if (becameEnabled && !this.loops.has(id)) {
      this.spawnLoop(id);
    } else if (becameDisabled && this.loops.has(id)) {
      // Pause = let the current cycle finish, then exit at the boundary.
      // We don't SIGTERM here — that's `stop`.
      this.loops.get(id)?.runNow(); // wake the sleep so the loop notices the pause
    } else if (updated.enabled) {
      await this.restartEnabledLoop(id);
    }
    return agentRunDatabase.getRunner(id);
  }

  /** Manually enable + start the loop. Idempotent. */
  start(id: string): Runner | null {
    const runner = agentRunDatabase.getRunner(id);
    if (!runner) return null;
    if (!runner.enabled) {
      agentRunDatabase.updateRunner(id, { enabled: true });
    }
    if (!this.loops.has(id)) {
      this.spawnLoop(id);
    } else {
      this.loops.get(id)?.runNow();
    }
    const refreshed = agentRunDatabase.getRunner(id);
    if (refreshed) runnerEvents.emitEvent({ type: "runner.updated", runner: refreshed });
    return refreshed;
  }

  /** Set enabled=false so the loop exits at the next cycle boundary. */
  pause(id: string): Runner | null {
    const runner = agentRunDatabase.getRunner(id);
    if (!runner) return null;
    agentRunDatabase.updateRunner(id, { enabled: false });
    this.loops.get(id)?.runNow(); // wake from sleep so it observes the flag
    agentRunDatabase.setRunnerStatus(id, "paused");
    const refreshed = agentRunDatabase.getRunner(id);
    if (refreshed) runnerEvents.emitEvent({ type: "runner.updated", runner: refreshed });
    return refreshed;
  }

  /** Pause + SIGTERM the current child. */
  async stop(id: string): Promise<Runner | null> {
    const runner = agentRunDatabase.getRunner(id);
    if (!runner) return null;
    agentRunDatabase.updateRunner(id, { enabled: false });
    agentRunDatabase.setRunnerStatus(id, "stopping");
    const loop = this.loops.get(id);
    if (loop) {
      loop.stop();
      await loop.done;
      this.loops.delete(id);
    }
    agentRunDatabase.setRunnerStatus(id, "idle", { currentRunId: null });
    const refreshed = agentRunDatabase.getRunner(id);
    if (refreshed) runnerEvents.emitEvent({ type: "runner.updated", runner: refreshed });
    return refreshed;
  }

  /** Fire one cycle even when enabled=false. */
  runNow(id: string): Runner | null {
    const runner = agentRunDatabase.getRunner(id);
    if (!runner) return null;
    if (!this.loops.has(id)) {
      this.spawnLoop(id);
    }
    this.loops.get(id)?.runNow();
    return runner;
  }

  async delete(id: string): Promise<boolean> {
    if (this.loops.has(id)) {
      await this.stop(id);
    }
    const ok = agentRunDatabase.deleteRunner(id);
    if (ok) runnerEvents.emitEvent({ type: "runner.deleted", runnerId: id });
    return ok;
  }

  /** Stop every loop. Called on SIGINT / SIGTERM. */
  async shutdown(): Promise<void> {
    const ids = [...this.loops.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  private spawnLoop(id: string): void {
    const loop = new RunnerLoop(id);
    this.loops.set(id, loop);
    loop
      .run()
      .catch((err) => {
        console.error(`[RunnerManager] Loop ${id} crashed:`, err);
      })
      .finally(() => {
        // Only forget the loop if it actually finished — `stop` may have already
        // taken it out of the map.
        if (this.loops.get(id) === loop) {
          this.loops.delete(id);
        }
      });
  }

  private async restartEnabledLoop(id: string): Promise<void> {
    const runner = agentRunDatabase.getRunner(id);
    if (!runner?.enabled) return;

    const loop = this.loops.get(id);
    if (loop) {
      agentRunDatabase.setRunnerStatus(id, "stopping", {
        lastError: "Restarting runner to apply saved configuration",
      });
      runnerEvents.emitStatus(agentRunDatabase.getRunner(id)!);
      loop.stop();
      await loop.done;
      if (this.loops.get(id) === loop) {
        this.loops.delete(id);
      }
    }

    if (!this.loops.has(id)) {
      this.spawnLoop(id);
    }
  }
}

export const runnerManager = new RunnerManager();
