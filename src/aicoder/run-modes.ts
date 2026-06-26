/**
 * Top-level run-mode entrypoints. Extracted from src/aicoder.ts
 * (2026-06-26).
 *
 * Three exports:
 *   - focusedLoop:  single-issue-per-cycle mode with dep-blocked skip
 *                   semantics and the review loop running inline.
 *   - pollLoop:     classic poll-everything-in-priority-order mode.
 *   - focusedProcessWorkItem: wrapper used by focusedLoop that runs
 *                   processWorkItem + (on success) the review loop, and
 *                   always ensures a clean workspace on the way out.
 *
 * Both loops follow the same shape:
 *   1. log config banner
 *   2. if TARGET_ISSUE_KEY: fetch + process that one, exit
 *   3. loop forever: fetchWork → expandDeps → prioritize → process
 *      → sleep POLL_MS
 *
 * The deps bag is fat because these are bootstrap entrypoints that
 * touch most of the runtime — every callback is injected so the module
 * never reaches back into aicoder.ts.
 */
import type { ServerConfig, WorkItem } from "../autonomous-loop/types";
import type { PriorityMode } from "../integrations/ollama-launcher/priority-sorter";

export interface RunModesLogger {
  log(level: string, message: string): void;
  logConfig(message: string): void;
  logError(message: string): void;
  logPoll(message: string): void;
}

export interface RunModesDeps {
  logger: RunModesLogger;
  workspace: string;

  // CLI-arg constants
  agent: string;
  useOllama: boolean;
  debug: boolean;
  targetIssueKey: string | null;
  label: string;
  source: string;
  priority: PriorityMode;
  lookup: string;
  sprint: string;
  maxCycles: number;
  pollMs: number;
  skipPoll: boolean;
  reviewPollMs: number;

  // Core operations
  getBaseBranch: () => string;
  fetchIssueByKey: (
    cfg: ServerConfig,
    key: string,
  ) => Promise<WorkItem | null>;
  fetchWork: (cfg: ServerConfig) => Promise<WorkItem[]>;
  expandWithDependencies: (
    items: WorkItem[],
    source: string,
    ghToken: string,
    owner: string,
    repo: string,
  ) => Promise<WorkItem[]>;
  prioritizeItems: (
    items: WorkItem[],
    priority: PriorityMode,
    apiUrl: string,
    apiKey: string,
  ) => Promise<WorkItem[]>;
  processWorkItem: (
    cfg: ServerConfig,
    item: WorkItem,
  ) => Promise<{ prNumber: number } | null>;
  ensureCleanWorkspace: () => boolean;
  detectRemotePlatform: (workspace: string) => string;
  runReviewLoop: (
    cfg: ServerConfig,
    item: WorkItem,
    ghToken: string | undefined,
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<void>;

  // Shared mutable state
  depBlockedThisCycle: Set<string>;
  getLastPipelineExitCode: () => number;
}

export async function focusedLoop(
  deps: RunModesDeps,
  cfg: ServerConfig,
): Promise<void> {
  const log = deps.logger;
  log.logConfig(
    `AiRemoteCoder started in focused mode (agent: ${deps.agent}, workspace: ${deps.workspace}${deps.useOllama ? ", ollama: on" : ""}${deps.debug ? ", debug: on" : ""}, base: ${deps.getBaseBranch()})`,
  );
  const ghToken = process.env.GITHUB_TOKEN;
  const owner = cfg.owner || process.env.GITHUB_DEFAULT_OWNER || "redsand";
  const repo = cfg.repo || process.env.AICODER_REPO || "";

  // --issue <key>: work on a specific issue with review loop
  if (deps.targetIssueKey) {
    log.logConfig(`Targeting issue ${deps.targetIssueKey} directly`);
    const target = await deps.fetchIssueByKey(cfg, deps.targetIssueKey);
    if (!target) {
      log.logError(`Could not find issue ${deps.targetIssueKey}`);
      process.exit(1);
    }
    await focusedProcessWorkItem(deps, cfg, target, ghToken, owner, repo);
    process.exit(deps.getLastPipelineExitCode());
  }

  log.logConfig(`Polling ${cfg.apiUrl} for label="${deps.label}"`);
  log.logConfig(
    `Source: ${deps.source}, Priority mode: ${deps.priority}, Lookup: ${deps.lookup}${deps.sprint ? `, Sprint: ${deps.sprint}` : ""}`,
  );

  let cycles = 0;
  while (true) {
    if (deps.maxCycles > 0 && cycles >= deps.maxCycles) {
      log.log("STOP", `Reached max cycles (${deps.maxCycles})`);
      break;
    }

    try {
      const rawItems = await deps.fetchWork(cfg);
      if (rawItems.length === 0) {
        log.logPoll(
          `No qualifying issues found — waiting ${deps.pollMs / 1000}s`,
        );
      } else {
        const items = await deps.expandWithDependencies(
          rawItems,
          deps.source,
          ghToken || "",
          owner,
          repo,
        );
        const sorted = await deps.prioritizeItems(
          items,
          deps.priority,
          cfg.apiUrl,
          cfg.apiKey,
        );
        log.logConfig(
          `Prioritized ${sorted.length} issues (mode=${deps.priority}): ${sorted.map((i) => `#${i.number}`).join(", ")}`,
        );
        // Try items in priority order. Skip dep-blocked ones and attempt
        // the next. Only one unblocked item per cycle so that after it
        // merges, the next cycle pulls latest main before branching for
        // the subsequent item.
        deps.depBlockedThisCycle.clear();
        for (const item of sorted) {
          await focusedProcessWorkItem(deps, cfg, item, ghToken, owner, repo);
          if (
            !deps.depBlockedThisCycle.has(item.id || String(item.number))
          )
            break;
        }
        cycles++;
      }
    } catch (err) {
      log.logError((err as Error).message);
    }

    if (deps.skipPoll) {
      log.log("STOP", "skip-poll: exiting after one cycle");
      break;
    }
    await new Promise((r) => setTimeout(r, deps.pollMs));
  }
}

export async function focusedProcessWorkItem(
  deps: RunModesDeps,
  cfg: ServerConfig,
  item: WorkItem,
  ghToken: string | undefined,
  owner: string,
  repo: string,
): Promise<void> {
  try {
    await focusedProcessWorkItemInner(deps, cfg, item, ghToken, owner, repo);
  } finally {
    // Always clean up the workspace before returning to the poll loop
    deps.ensureCleanWorkspace();
  }
}

async function focusedProcessWorkItemInner(
  deps: RunModesDeps,
  cfg: ServerConfig,
  item: WorkItem,
  ghToken: string | undefined,
  owner: string,
  repo: string,
): Promise<void> {
  const result = await deps.processWorkItem(cfg, item);
  if (!result) {
    return; // Failed to create PR/MR
  }

  const platform = deps.detectRemotePlatform(deps.workspace);
  const label = platform === "gitlab" ? "MR" : "PR";
  const prNumber = result.prNumber;

  // For GitLab, we don't need ghToken/repo for review polling
  if (platform !== "gitlab" && (!ghToken || !repo)) {
    return; // No GitHub token — can't poll for review
  }

  deps.logger.logConfig(
    `Waiting for review of ${label} #${prNumber} (polling every ${deps.reviewPollMs / 1000}s)`,
  );
  await deps.runReviewLoop(cfg, item, ghToken, owner, repo, prNumber);
}

export async function pollLoop(
  deps: RunModesDeps,
  cfg: ServerConfig,
): Promise<void> {
  const log = deps.logger;
  log.logConfig(
    `AiRemoteCoder started in poll mode (agent: ${deps.agent}, workspace: ${deps.workspace}${deps.useOllama ? ", ollama: on" : ""}, base: ${deps.getBaseBranch()})`,
  );

  // --issue <key>: work on a specific issue and exit (no polling)
  if (deps.targetIssueKey) {
    log.logConfig(`Targeting issue ${deps.targetIssueKey} directly`);
    const target = await deps.fetchIssueByKey(cfg, deps.targetIssueKey);
    if (!target) {
      log.logError(`Could not find issue ${deps.targetIssueKey}`);
      process.exit(1);
    }
    await deps.processWorkItem(cfg, target);
    process.exit(deps.getLastPipelineExitCode());
  }

  log.logConfig(`Polling ${cfg.apiUrl} for label="${deps.label}"`);
  log.logConfig(
    `Source: ${deps.source}, Priority mode: ${deps.priority}, Lookup: ${deps.lookup}${deps.sprint ? `, Sprint: ${deps.sprint}` : ""}`,
  );

  let cycles = 0;
  while (true) {
    if (deps.maxCycles > 0 && cycles >= deps.maxCycles) {
      log.log("STOP", `Reached max cycles (${deps.maxCycles})`);
      break;
    }

    try {
      const rawItems = await deps.fetchWork(cfg);
      const ghToken = process.env.GITHUB_TOKEN;
      const owner = cfg.owner || process.env.GITHUB_DEFAULT_OWNER || "redsand";
      const repo = cfg.repo || process.env.AICODER_REPO || "";

      if (rawItems.length === 0) {
        log.logPoll(
          `No qualifying issues found — waiting ${deps.pollMs / 1000}s`,
        );
      } else {
        const items = await deps.expandWithDependencies(
          rawItems,
          deps.source,
          ghToken || "",
          owner,
          repo,
        );
        const sorted = await deps.prioritizeItems(
          items,
          deps.priority,
          cfg.apiUrl,
          cfg.apiKey,
        );
        log.logConfig(
          `Prioritized ${sorted.length} issues (mode=${deps.priority}): ${sorted.map((i) => `#${i.number}`).join(", ")}`,
        );
        for (const item of sorted) {
          await deps.processWorkItem(cfg, item);
        }
        cycles++;
      }
    } catch (err) {
      log.logError((err as Error).message);
    }

    if (deps.skipPoll) {
      log.log("STOP", "skip-poll: exiting after one cycle");
      break;
    }
    await new Promise((r) => setTimeout(r, deps.pollMs));
  }
}
