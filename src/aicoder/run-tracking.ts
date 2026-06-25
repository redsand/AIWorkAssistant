/**
 * Agent-run step/completion tracking extracted from src/aicoder.ts
 * (2026-06-25).
 *
 * The tracker delegates to the HTTP agent-runs client when available
 * (so the dashboard sees live updates) and falls back to direct DB
 * writes when running standalone or before the server is ready.
 *
 * All `track*` functions are best-effort — they swallow errors so
 * observability failures never block the aicoder pipeline.
 */
import type { AgentRunStepCreate } from "../agent-runs/types";

export interface AgentRunsClientLike {
  addStep(step: AgentRunStepCreate): Promise<unknown>;
  completeRun(
    runId: string,
    data: { model: string; toolLoopCount: number; totalTokens: number },
  ): Promise<unknown>;
  failRun(runId: string, errorMessage: string): Promise<unknown>;
}

export interface AgentRunsDbLike {
  addStep(step: AgentRunStepCreate): unknown;
  touchRun(runId: string): unknown;
  completeRun(
    runId: string,
    data: { model: string; toolLoopCount: number; totalTokens: number },
  ): unknown;
  failRun(runId: string, errorMessage: string): unknown;
}

/**
 * Step counter is per-run but global to this module — there's only ever
 * one aicoder process at a time so cross-run interleaving isn't a
 * concern. Reset by callers between issues (currentRunStepOrder = 0).
 */
let currentRunStepOrder = 0;

export function resetStepOrder(): void {
  currentRunStepOrder = 0;
}

export function getStepOrder(): number {
  return currentRunStepOrder;
}

export function trackStep(
  client: AgentRunsClientLike | null,
  db: AgentRunsDbLike,
  runId: string,
  stepType: AgentRunStepCreate["stepType"],
  content: string,
  extra?: Partial<
    Pick<AgentRunStepCreate, "toolName" | "success" | "errorMessage" | "durationMs">
  >,
): void {
  try {
    currentRunStepOrder++;
    const step: AgentRunStepCreate = {
      runId,
      stepType,
      toolName: extra?.toolName ?? null,
      content,
      sanitizedParams: null,
      success: extra?.success ?? true,
      errorMessage: extra?.errorMessage ?? null,
      durationMs: extra?.durationMs ?? null,
      stepOrder: currentRunStepOrder,
    };
    if (client) {
      client.addStep(step).catch(() => {});
    } else {
      db.addStep(step);
      db.touchRun(runId);
    }
  } catch {
    // Non-fatal: tracking should never crash the aicoder
  }
}

export function completeRunTrack(
  client: AgentRunsClientLike | null,
  db: AgentRunsDbLike,
  runId: string,
  data: { model: string; toolLoopCount: number; totalTokens: number },
): void {
  if (client) {
    client.completeRun(runId, data).catch(() => {});
  } else {
    db.completeRun(runId, data);
  }
}

export function failRunTrack(
  client: AgentRunsClientLike | null,
  db: AgentRunsDbLike,
  runId: string,
  errorMessage: string,
): void {
  if (client) {
    client.failRun(runId, errorMessage).catch(() => {});
  } else {
    db.failRun(runId, errorMessage);
  }
}

/**
 * Recognize stderr patterns that indicate the coding agent failed to
 * start (bad config, missing binary, wrong API shape) — distinct from
 * "the agent ran but produced no useful output". Used to escalate
 * rather than retry on the same broken setup.
 */
export function isAgentInfrastructureFailure(
  stderr: string | undefined,
): boolean {
  if (!stderr) return false;
  return /Error loading config\.toml|wire_api\s*=\s*"chat"|Failed to start|cannot use OpenCode Go directly/i.test(
    stderr,
  );
}
