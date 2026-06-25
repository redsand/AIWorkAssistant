/**
 * Prompt-construction helpers extracted from src/aicoder.ts (2026-06-25).
 *
 * `enrichPromptWithMemory` prepends recent relevant memories (saved past
 * sessions / work items) so the coding agent has continuity across runs.
 * `buildAgentPrompt` chains memory enrichment with the cross-cutting
 * `enrichPrompt` (project rules, agents.md, etc.) into the final string
 * that gets handed to the agent CLI.
 */
import type { WorkItem } from "../autonomous-loop/types";
import { enrichPrompt } from "../autonomous-loop/prompt-enricher";

export interface MemorySource {
  getRelevantMemories(
    userId: string,
    context: string,
    limit: number,
  ): string[];
}

/**
 * Prepend up to 5 relevant past-session memories to `prompt`. The memory
 * lookup is best-effort — if `memorySource` throws (DB unavailable, etc.)
 * the original prompt is returned unchanged so a single transient error
 * never blocks a coding cycle.
 */
export function enrichPromptWithMemory(
  memorySource: MemorySource,
  prompt: string,
  item?: WorkItem,
): string {
  try {
    const context = item
      ? `${item.title}\n${item.body || ""}\n${prompt}`
      : prompt;
    const memories = memorySource.getRelevantMemories("aicoder", context, 5);
    if (!memories.length) return prompt;

    const memoryBlock = [
      "## Relevant Past Work",
      ...memories,
      "## Current Task",
    ].join("\n");

    return `${memoryBlock}\n\n${prompt}`;
  } catch {
    return prompt;
  }
}

/**
 * Build the final prompt string for the coding agent: memory-enriched
 * prompt + project-level rules from `prompt-enricher` (which reads
 * agents.md, claimkit rules, etc. based on the workspace).
 */
export async function buildAgentPrompt(
  memorySource: MemorySource,
  workspace: string,
  prompt: string,
  item?: WorkItem,
): Promise<string> {
  const withMemory = enrichPromptWithMemory(memorySource, prompt, item);
  return enrichPrompt(withMemory, workspace);
}
