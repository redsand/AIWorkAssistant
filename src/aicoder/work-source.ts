/**
 * Work-source helpers: poll the AIWorkAssistant API for pending work and
 * resolve a prompt for a given item via the ticket-bridge. Extracted from
 * src/aicoder.ts (2026-06-25).
 *
 * Both functions are thin wrappers around HTTP calls to the local
 * AIWorkAssistant server — easier to mock + test in isolation than the
 * full aicoder pipeline. Filters (label/sprint/etc.) are passed as args
 * rather than read from process-wide globals so the same code can run
 * with different filter sets per call.
 */
import axios from "axios";
import type { GeneratedPrompt, ServerConfig, WorkItem } from "../autonomous-loop/types";
import { authHeaders } from "../autonomous-loop/notify";
import { generatePromptFromWorkItem } from "./work-items";
import type { MemorySource } from "./prompt-builder";
import type { WorkItemsLogger } from "./work-items";

export interface FetchWorkFilters {
  label: string;
  /** Empty/undefined → no sprint filter. */
  sprint?: string | null;
  /** When true, the server returns items without a coding-prompt section too. */
  skipPromptCheck?: boolean;
  /** Cap on items returned per call. Default 5 matches legacy behavior. */
  limit?: number;
}

/**
 * Poll the autonomous-loop work endpoint for pending items matching the
 * filters. Throws on transport error or `success=false`.
 */
export async function fetchWork(
  cfg: ServerConfig,
  filters: FetchWorkFilters,
): Promise<WorkItem[]> {
  const params: Record<string, string> = {
    label: filters.label,
    limit: String(filters.limit ?? 5),
    source: cfg.source,
  };
  if (cfg.owner) params.owner = cfg.owner;
  if (cfg.repo) params.repo = cfg.repo;
  if (filters.sprint) params.sprint = filters.sprint;
  if (filters.skipPromptCheck) params.skipPromptCheck = "true";

  const resp = await axios.get<{
    success: boolean;
    items: WorkItem[];
    error?: string;
  }>(`${cfg.apiUrl}/api/autonomous-loop/work`, {
    headers: authHeaders(cfg),
    params,
  });
  if (!resp.data.success) {
    throw new Error(resp.data.error || "Server returned unsuccessful response");
  }
  return resp.data.items ?? [];
}

/**
 * Resolve a coding-agent prompt for the given work item. Routes through
 * the local DB for work_items (where the description IS the prompt) or
 * the ticket-bridge for github/jira (which enriches with codebase
 * context). Tells the bridge to skip items missing a coding-prompt
 * section so the loop doesn't burn agent time on bare titles.
 */
export async function generatePrompt(
  memorySource: MemorySource,
  logger: WorkItemsLogger,
  cfg: ServerConfig,
  item: WorkItem,
): Promise<GeneratedPrompt> {
  if (cfg.source === "work_items") {
    return generatePromptFromWorkItem(memorySource, logger, cfg, item);
  }

  const isJira = /^[A-Z]+-\d+$/.test(item.id);
  const sourceType = isJira ? "jira" : "github";
  const sourceId = isJira
    ? item.id
    : `${item.owner || cfg.owner}/${item.repo || cfg.repo}#${item.number}`;

  const resp = await axios.post<GeneratedPrompt>(
    `${cfg.apiUrl}/api/ticket-bridge/prompt`,
    {
      source: { type: sourceType, id: sourceId },
      context: { includeCodebaseIndex: true, skipMissingCodingPrompt: true },
    },
    { headers: authHeaders(cfg) },
  );
  return resp.data;
}
