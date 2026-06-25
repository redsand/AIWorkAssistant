/**
 * Work-item-source helpers extracted from src/aicoder.ts (2026-06-25).
 *
 * The "work_items" source backs items in the local AIWorkAssistant DB
 * (calendar items, manual tickets, chat-extracted work). Both functions
 * here hit the same `/api/work-items/:id` endpoint and shape the result
 * differently — one returns a coding-prompt string, the other a full
 * WorkItem for the pipeline.
 *
 * authHeaders + work-item helper imports stay in autonomous-loop because
 * they're shared with the rest of the codebase (notify, work-item-utils).
 */
import axios from "axios";
import type { GeneratedPrompt, ServerConfig, WorkItem } from "../autonomous-loop/types";
import { authHeaders } from "../autonomous-loop/notify";
import {
  extractCodingPromptSection,
  hashUuidToNumber,
  parseWorkItemTagsJson,
} from "../autonomous-loop/work-item-utils";
import type { MemorySource } from "./prompt-builder";
import { enrichPromptWithMemory } from "./prompt-builder";

export interface WorkItemsLogger {
  logError(message: string): void;
}

/**
 * Fetch the work-item and produce a prompt for the coding agent. Returns
 * `{skipped: true}` when the item has no description / coding-prompt
 * section to act on (the loop then skips it without burning agent time).
 *
 * `memorySource` is the conversation-memory store used to enrich the
 * prompt with relevant past sessions (same as the regular path).
 */
export async function generatePromptFromWorkItem(
  memorySource: MemorySource,
  logger: WorkItemsLogger,
  cfg: ServerConfig,
  item: WorkItem,
): Promise<GeneratedPrompt> {
  try {
    const resp = await axios.get<{
      id: string;
      title: string;
      description: string;
      status: string;
      type: string;
      tagsJson?: string | null;
    }>(`${cfg.apiUrl}/api/work-items/${item.id}`, { headers: authHeaders(cfg) });

    const wi = resp.data;
    if (!wi || !wi.title) {
      return { prompt: "", skipped: true, skipReason: "Work item not found" };
    }

    const body = wi.description || "";
    const codingPrompt = extractCodingPromptSection(body);
    const promptContent = codingPrompt || body;

    if (!promptContent.trim()) {
      return {
        prompt: "",
        skipped: true,
        skipReason: "Work item has no description or coding prompt",
      };
    }

    const prompt = `# Task: ${wi.title}

## Description
${promptContent}

## Instructions
Implement the changes described above. Follow the project's existing patterns and conventions.
`;

    const enriched = enrichPromptWithMemory(memorySource, prompt, item);
    return { prompt: enriched, skipped: false, skipReason: null };
  } catch (err) {
    logger.logError(
      `Failed to fetch work item ${item.id}: ${err instanceof Error ? err.message : err}`,
    );
    return {
      prompt: "",
      skipped: true,
      skipReason: `Failed to fetch work item: ${err instanceof Error ? err.message : err}`,
    };
  }
}

/**
 * Fetch a work-item by id and shape it into a WorkItem for the pipeline
 * (used by the `--issue` direct path when the source is work_items).
 * Returns null on miss or fetch error.
 */
export async function fetchWorkItemDirectly(
  logger: WorkItemsLogger,
  cfg: ServerConfig,
  workItemId: string,
): Promise<WorkItem | null> {
  try {
    const resp = await axios.get<{
      id: string;
      title: string;
      description: string;
      status: string;
      tagsJson?: string | null;
      owner?: string;
    }>(`${cfg.apiUrl}/api/work-items/${workItemId}`, { headers: authHeaders(cfg) });

    const wi = resp.data;
    if (!wi || !wi.title) return null;

    const slug = wi.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "");
    const tags = parseWorkItemTagsJson(wi.tagsJson ?? null);

    return {
      id: wi.id,
      number: hashUuidToNumber(wi.id),
      title: wi.title,
      url: "",
      owner: wi.owner || "",
      repo: "",
      suggestedBranch: `ai/issue-wi-${slug}`,
      labels: tags,
      body: wi.description || "",
    };
  } catch (err) {
    logger.logError(
      `Failed to fetch work item ${workItemId}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
