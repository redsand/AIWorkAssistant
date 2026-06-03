/**
 * Shared utility for sanitizing tool names and repairing orphaned tool-call / tool-response pairs.
 * Extracted from ollama-provider, openai-provider, opencode-provider, and zai-provider to avoid duplication.
 */

export interface ToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
  type?: string;
  [key: string]: unknown;
}

export interface BaseMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  [key: string]: unknown;
}

export interface AssistantMessage extends BaseMessage {
  role: "assistant";
  tool_calls?: ToolCall[];
}

export interface ToolMessage extends BaseMessage {
  role: "tool";
  tool_call_id?: string;
}

export type ChatMessage = BaseMessage | AssistantMessage | ToolMessage;

export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function repairToolMessagePairs(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "assistant" && Array.isArray((msg as AssistantMessage).tool_calls) && ((msg as AssistantMessage).tool_calls!.length > 0)) {
      const toolCalls = (msg as AssistantMessage).tool_calls!;
      const expectedIds = new Set<string>(toolCalls.map((tc) => tc.id).filter((id): id is string => Boolean(id)));
      const toolResponses: ToolMessage[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        toolResponses.push(messages[j] as ToolMessage);
        j++;
      }

      const respondedIds = new Set<string>(toolResponses.map((m) => m.tool_call_id).filter((id): id is string => Boolean(id)));
      const allPresent = [...expectedIds].every((id) => respondedIds.has(id));

      if (allPresent && toolResponses.length > 0) {
        result.push(msg);
        toolResponses.forEach((m) => result.push(m));
      } else if (toolResponses.length > 0) {
        const filteredCalls = toolCalls.filter((tc) => tc.id && respondedIds.has(tc.id));
        if (filteredCalls.length > 0) {
          result.push({ ...msg, tool_calls: filteredCalls } as AssistantMessage);
          toolResponses
            .filter((m) => filteredCalls.some((tc) => tc.id === m.tool_call_id))
            .forEach((m) => result.push(m));
        } else {
          const { tool_calls, ...rest } = msg as AssistantMessage;
          if (rest.content) result.push(rest);
        }
      } else {
        const { tool_calls, ...rest } = msg as AssistantMessage;
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
