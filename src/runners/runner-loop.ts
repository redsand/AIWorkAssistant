/**
 * Per-runner background loop.
 *
 * A RunnerLoop drives a single configured Runner: it provisions a persistent
 * worktree, spawns aicoder (or reviewer) as a child process with --skip-poll
 * so the loop owns the cadence, captures all stdout/stderr to a per-runner
 * log file, and honors pause / stop / run-now signals between cycles.
 *
 * The loop never preempts a running child mid-cycle for pause; only `stop`
 * SIGTERMs the child. This matches the "graceful shutdown" semantic the user
 * asked for.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { agentRunDatabase } from "../agent-runs/database";
import type { Runner } from "../agent-runs/types";
import { ensurePersistentWorktree } from "../kanban/worktree-manager";
import { runnerEvents } from "./runner-events";

const LOG_DIR = path.join(process.cwd(), "data", "runner-logs");

function resolveTsxCli(): string {
  // Resolve the tsx CLI script that we'll feed to `node`. Cross-platform —
  // no shell, no PATH dependency.
  try {
    return require.resolve("tsx/cli");
  } catch {
    // Fallback for ESM-only resolutions; tsx ships dist/cli.mjs
    return path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  }
}

function aicoderScriptPath(): string {
  return path.resolve(__dirname, "..", "aicoder.ts");
}

function reviewerScriptPath(): string {
  return path.resolve(__dirname, "..", "reviewer.ts");
}

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

export function runnerLogPath(runnerId: string): string {
  return path.join(LOG_DIR, `${runnerId}.log`);
}

interface LoopState {
  child: child_process.ChildProcess | null;
  stopRequested: boolean;
  runNowRequested: boolean;
  sleepTimer: NodeJS.Timeout | null;
  sleepResolve: (() => void) | null;
  done: Promise<void>;
  finished: boolean;
}

export class RunnerLoop {
  private state: LoopState;
  private resolveDone!: () => void;

  constructor(public readonly runnerId: string) {
    this.state = {
      child: null,
      stopRequested: false,
      runNowRequested: false,
      sleepTimer: null,
      sleepResolve: null,
      done: new Promise<void>((res) => {
        this.resolveDone = res;
      }),
      finished: false,
    };
  }

  get isFinished(): boolean {
    return this.state.finished;
  }

  get done(): Promise<void> {
    return this.state.done;
  }

  /** Cooperative stop — pause flag + SIGTERM any running child. */
  stop(): void {
    this.state.stopRequested = true;
    if (this.state.child && !this.state.child.killed) {
      try {
        this.state.child.kill("SIGTERM");
      } catch {
        // Ignore — child may already be gone
      }
    }
    this.wakeFromSleep();
  }

  /** Kick a single cycle immediately even if runner.enabled=false. */
  runNow(): void {
    this.state.runNowRequested = true;
    this.wakeFromSleep();
  }

  private wakeFromSleep(): void {
    if (this.state.sleepTimer) {
      clearTimeout(this.state.sleepTimer);
      this.state.sleepTimer = null;
    }
    if (this.state.sleepResolve) {
      const resolve = this.state.sleepResolve;
      this.state.sleepResolve = null;
      resolve();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.state.sleepResolve = resolve;
      this.state.sleepTimer = setTimeout(() => {
        this.state.sleepTimer = null;
        this.state.sleepResolve = null;
        resolve();
      }, ms);
    });
  }

  /**
   * Long-lived loop. Reads the runner row from the DB each iteration so config
   * edits and enable/disable toggles take effect on the next cycle.
   */
  async run(): Promise<void> {
    try {
      ensureLogDir();
      while (!this.state.stopRequested) {
        const runner = agentRunDatabase.getRunner(this.runnerId);
        if (!runner) {
          this.appendLog("Runner deleted — exiting loop");
          break;
        }

        const shouldRun = runner.enabled || this.state.runNowRequested;
        this.state.runNowRequested = false;

        if (!shouldRun) {
          agentRunDatabase.setRunnerStatus(this.runnerId, "paused");
          this.emitStatus(this.runnerId);
          await this.sleep(runner.pollIntervalMs);
          continue;
        }

        await this.runOneCycle(runner);

        const refreshed = agentRunDatabase.getRunner(this.runnerId);
        if (!refreshed) break;

        // Target-issue mode: one-shot. Disable runner and exit loop.
        if (refreshed.targetIssue && refreshed.targetIssue.trim().length > 0) {
          agentRunDatabase.updateRunner(this.runnerId, { enabled: false });
          agentRunDatabase.setRunnerStatus(this.runnerId, "idle");
          this.emitStatus(this.runnerId);
          this.appendLog(`Target issue ${refreshed.targetIssue} cycle complete — disabling runner`);
          break;
        }

        if (this.state.stopRequested) break;

        // Idle between cycles.
        agentRunDatabase.setRunnerStatus(this.runnerId, "idle");
        this.emitStatus(this.runnerId);
        await this.sleep(refreshed.pollIntervalMs);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendLog(`Loop error: ${msg}`);
      agentRunDatabase.setRunnerStatus(this.runnerId, "error", { lastError: msg });
      this.emitStatus(this.runnerId);
    } finally {
      agentRunDatabase.setRunnerStatus(this.runnerId, "idle", { currentRunId: null });
      this.emitStatus(this.runnerId);
      this.state.finished = true;
      this.resolveDone();
    }
  }

  /** Single iteration: ensure workspace → spawn aicoder/reviewer → wait. */
  private async runOneCycle(runner: Runner): Promise<void> {
    // 1. Workspace
    //
    // Aicoder needs a per-runner isolated worktree (we provision/refresh
    // one). Reviewer works across multiple existing local clones — it
    // expects a parent directory the user supplied via the form. Skipping
    // ensurePersistentWorktree for reviewer also avoids a useless clone of
    // a single repo when the reviewer is configured to watch several.
    let workspacePath: string;
    if (runner.kind === "reviewer") {
      const userPath = runner.workspacePath?.trim();
      if (!userPath) {
        const msg = "Reviewer runner has no workspacePath set — point it at the parent directory of your local clones.";
        this.appendLog(msg);
        agentRunDatabase.setRunnerStatus(this.runnerId, "error", { lastError: msg });
        this.emitStatus(this.runnerId);
        return;
      }
      workspacePath = userPath;
    } else {
      try {
        workspacePath = await ensurePersistentWorktree({
          runnerId: runner.id,
          repoUrl: runner.repoUrl,
          baseBranch: runner.baseBranch ?? "main",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.appendLog(`Workspace provisioning failed: ${msg}`);
        agentRunDatabase.setRunnerStatus(this.runnerId, "error", { lastError: msg });
        this.emitStatus(this.runnerId);
        return;
      }
      if (runner.workspacePath !== workspacePath) {
        agentRunDatabase.updateRunner(runner.id, { workspacePath });
      }
    }

    const startedAt = new Date().toISOString();
    agentRunDatabase.setRunnerStatus(this.runnerId, "running", {
      lastStartedAt: startedAt,
      lastError: null,
    });
    this.emitStatus(this.runnerId);

    // 2. Build child argv + env
    const { argv, env } = this.buildChildInvocation(runner, workspacePath);

    this.appendLog(
      `── Cycle started at ${startedAt} ──\n` +
        `kind=${runner.kind} agent=${runner.agent} model=${runner.model ?? "(default)"} ` +
        `source=${runner.source} workspace=${workspacePath}\n` +
        `argv: ${argv.join(" ")}\n`,
    );

    // 3. Spawn
    const tsxCli = resolveTsxCli();
    const child = child_process.spawn(
      process.execPath,
      [tsxCli, ...argv],
      {
        cwd: workspacePath,
        env,
        shell: false,
      },
    );
    this.state.child = child;

    const logStream = fs.createWriteStream(runnerLogPath(this.runnerId), { flags: "a" });
    const forward = (chunk: Buffer) => {
      logStream.write(chunk);
      runnerEvents.emitLog(this.runnerId, chunk.toString("utf8"));
    };
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on("error", (err) => {
          this.appendLog(`Child spawn error: ${err.message}`);
          resolve({ code: -1, signal: null });
        });
        child.on("close", (code, signal) => {
          resolve({ code, signal });
        });
      },
    );

    logStream.end();
    this.state.child = null;

    const finishedAt = new Date().toISOString();
    const summary =
      exit.signal !== null
        ? `Child terminated by signal ${exit.signal}`
        : `Child exited with code ${exit.code}`;
    this.appendLog(`── Cycle finished at ${finishedAt} — ${summary} ──\n\n`);

    const hasError = exit.code !== 0 && exit.code !== null;
    agentRunDatabase.setRunnerStatus(this.runnerId, hasError ? "error" : "idle", {
      lastFinishedAt: finishedAt,
      lastError: hasError ? summary : null,
    });
    this.emitStatus(this.runnerId);
  }

  private buildChildInvocation(
    runner: Runner,
    workspacePath: string,
  ): { argv: string[]; env: NodeJS.ProcessEnv } {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AICODER_WORKSPACE: workspacePath,
      AICODER_AGENT: runner.agent,
      AICODER_SOURCE: runner.source,
    };
    if (runner.model) env.AICODER_MODEL = runner.model;

    // ── Resolve apiProviderHostId → per-provider env override ─────────────
    // Only applied when the host's provider matches runner.apiProvider; a
    // mismatched pair would misroute requests so we skip + log instead.
    if (runner.apiProviderHostId) {
      const host = agentRunDatabase.getProviderHost(runner.apiProviderHostId);
      if (host && host.provider === runner.apiProvider) {
        if (host.provider === "ollama") {
          env.OLLAMA_API_URL = host.baseUrl;
          env.OLLAMA_API_KEY = host.apiKey ?? "";
          // Per-host timeout flows through to the child's OllamaProvider via
          // factory.ts. Useful for runners that hit a slow local box on
          // long aicoder cycles.
          if (host.timeoutSeconds) {
            const ms = String(host.timeoutSeconds * 1000);
            env.OLLAMA_TIMEOUT_MS = ms;
            // Also raise the first-chunk idle watchdog (default 30s) so a
            // slow box loading weights into VRAM doesn't get killed before
            // its first token streams. Same value as total timeout.
            env.AI_FIRST_CHUNK_TIMEOUT_MS = ms;
          }
        }
        this.appendLog(
          `Provider host override: ${host.provider} → ${host.name} (${host.baseUrl})` +
            (host.timeoutSeconds ? ` [timeout=${host.timeoutSeconds}s]` : ""),
        );
      } else if (host) {
        this.appendLog(
          `Skipping provider host ${host.name}: host.provider=${host.provider} does not match runner.apiProvider=${runner.apiProvider}`,
        );
      } else {
        this.appendLog(
          `Provider host id ${runner.apiProviderHostId} no longer exists — falling back to env defaults`,
        );
      }
    }

    const argv: string[] = [];

    if (runner.kind === "aicoder") {
      argv.push(aicoderScriptPath());
      argv.push("--workspace", workspacePath);
      argv.push("--source", runner.source);
      argv.push("--agent", runner.agent);
      argv.push("--skip-poll"); // loop owns cadence
      if (runner.model) argv.push("--model", runner.model);
      if (runner.apiProvider === "opencode") argv.push("--opencode");
      else if (runner.apiProvider === "zai") argv.push("--zai");
      else if (runner.apiProvider === "ollama") argv.push("--ollama");
      if (runner.owner) argv.push("--owner", runner.owner);
      if (runner.repo) argv.push("--repo", runner.repo);
      if (runner.label) argv.push("--label", runner.label);
      if (runner.sprint) argv.push("--sprint", runner.sprint);
      if (runner.baseBranch) argv.push("--base", runner.baseBranch);
      if (runner.targetIssue) {
        argv.push("--issue", runner.targetIssue);
        argv.push("--force");
      }
    } else {
      // reviewer
      argv.push(reviewerScriptPath());
      argv.push("--poll-ms", "0"); // one-shot, loop owns cadence
      argv.push("--source", runner.source === "gitlab" ? "gitlab" : "github");
      if (runner.owner) argv.push("--owner", runner.owner);
      if (runner.repo) {
        if (runner.source === "gitlab") {
          argv.push("--gitlab-project", runner.repo);
        }
        argv.push("--repo", runner.repo);
      }
      if (runner.apiProvider) argv.push("--provider", runner.apiProvider);
      if (runner.model) argv.push("--model", runner.model);
      argv.push("--workspace-path", workspacePath);
      // For reviewer, runner.targetIssue holds the MR/PR number (the UI
      // field is labeled "Target MR/PR #"). Maps to reviewer's --review-mr
      // for a one-shot focused review.
      if (runner.targetIssue) {
        argv.push("--review-mr", runner.targetIssue);
      }
    }

    return { argv, env };
  }

  private appendLog(line: string): void {
    ensureLogDir();
    fs.appendFileSync(runnerLogPath(this.runnerId), `[${new Date().toISOString()}] ${line}\n`);
  }

  private emitStatus(runnerId: string): void {
    const runner = agentRunDatabase.getRunner(runnerId);
    if (!runner) return;
    runnerEvents.emitStatus(runner);
  }
}
