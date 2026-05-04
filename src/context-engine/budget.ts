import {
  CHARS_PER_TOKEN,
  DEFAULT_SLOT_DEFINITIONS,
  type AllocatedBudget,
  type BudgetSlotDefinition,
  type ContextSection,
} from "./types";

const SAFETY_MARGIN = 0.7;

export function createBudget(
  slotDefinitions: BudgetSlotDefinition[] = DEFAULT_SLOT_DEFINITIONS,
  totalTokenBudget: number,
  toolTokens: number,
): AllocatedBudget {
  const safeLimit = Math.floor(totalTokenBudget * SAFETY_MARGIN);
  const availableTokens = safeLimit - toolTokens;
  const slots = slotDefinitions
    .sort((a, b) => b.priority - a.priority)
    .map((def) => ({
      name: def.name,
      priority: def.priority,
      maxTokens: Math.floor(availableTokens * def.fraction),
      allocatedTokens: 0,
      overflowTarget: def.overflowTarget,
    }));

  let remainingTokens = availableTokens;
  for (const slot of slots) {
    const allocation = Math.min(slot.maxTokens, remainingTokens);
    slot.allocatedTokens = allocation;
    remainingTokens -= allocation;
  }

  if (remainingTokens > 0) {
    const historySlot = slots.find((s) => s.name === "history");
    if (historySlot) {
      const extra = Math.min(remainingTokens, historySlot.maxTokens - historySlot.allocatedTokens);
      historySlot.allocatedTokens += extra;
      remainingTokens -= extra;
    }
    if (remainingTokens > 0) {
      const docSlot = slots.find((s) => s.name === "documents");
      if (docSlot) {
        const extra = Math.min(remainingTokens, docSlot.maxTokens - docSlot.allocatedTokens);
        docSlot.allocatedTokens += extra;
        remainingTokens -= extra;
      }
    }
  }

  return {
    totalBudget: totalTokenBudget,
    safetyMargin: SAFETY_MARGIN,
    slots,
    remainingTokens,
  };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function enforceBudget(
  sections: ContextSection[],
  budget: AllocatedBudget,
): ContextSection[] {
  const result: ContextSection[] = [];
  for (const section of sections) {
    const slot = budget.slots.find((s) => s.name === section.name);
    const maxTokens = slot ? slot.allocatedTokens : Infinity;
    const originalTokens = estimateTokens(section.content);

    if (originalTokens <= maxTokens) {
      result.push({
        ...section,
        tokens: originalTokens,
      });
    } else {
      const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
      const truncated = section.content.substring(0, maxChars);
      const lastNewline = truncated.lastIndexOf("\n");
      const cutPoint = lastNewline > maxChars * 0.5 ? lastNewline : maxChars;
      const finalContent = section.content.substring(0, cutPoint) + "\n...[truncated]";
      result.push({
        ...section,
        content: finalContent,
        tokens: maxTokens,
        compressionRatio: originalTokens / maxTokens,
        sourceCount: section.sourceCount,
      });
    }
  }
  return result;
}