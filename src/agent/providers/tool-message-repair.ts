/**
 * Shared utility for sanitizing tool names and repairing orphaned tool-call / tool-response pairs.
 * Extracted from ollama-provider, openai-provider, opencode-provider, and zai-provider to avoid duplication.
 */

export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function repairToolMessagePairs(messages: any[]): any[] {
  const result: any[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const expectedIds = new Set<string>(msg.tool_calls.map((tc: any) => tc.id).filter(Boolean));
      const toolResponses: any[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        toolResponses.push(messages[j]);
        j++;
      }

      const respondedIds = new Set(toolResponses.map((m: any) => m.tool_call_id).filter(Boolean));
      const allPresent = [...expectedIds].every((id) => respondedIds.has(id));

      if (allPresent && toolResponses.length > 0) {
        result.push(msg);
        toolResponses.forEach((m) => result.push(m));
      } else if (toolResponses.length > 0) {
        const filteredCalls = msg.tool_calls.filter((tc: any) => respondedIds.has(tc.id));
        if (filteredCalls.length > 0) {
          result.push({ ...msg, tool_calls: filteredCalls });
          toolResponses
            .filter((m) => filteredCalls.some((tc: any) => tc.id === m.tool_call_id))
            .forEach((m) => result.push(m));
        } else {
          const { tool_calls, ...rest } = msg;
          if (rest.content) result.push(rest);
        }
      } else {
        const { tool_calls, ...rest } = msg;
        if (rest.content) result.push(rest);
      }
      i = j;
    } else if (msg.role === "tool") {
      i++;
    } else {
      result.push(msg);
      i++;
    }
  }

  return result;
}
