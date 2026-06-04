import type { ChatMessage, ToolCall } from "./providers/types";
import { aiClient } from "./opencode-client";
import { agentMemory } from "../memory/agent-memory";

export interface ReflectionResult {
  taskSucceeded: boolean;
  toolCallCount: number;
  wins: string[];
  losses: string[];
  lessons: string[];
  skillCandidate: boolean;
  memoryEntries: Array<{ key: string; value: string; target: "memory" | "user" }>;
}

const REFLECTION_THRESHOLD = 3;
const SKILL_CANDIDATE_THRESHOLD = 5;
const SELF_NUDGE_INTERVAL = 15;
const CHARS_PER_TOKEN = 1.8;

export class ReflectionEngine {
  /**
   * Reflect on a completed task by evaluating the conversation, tool calls, and outcome.
   * Uses the AI model with low temperature (0.3) for consistent self-evaluation.
   */
  async reflectOnTask(
    messages: ChatMessage[],
    toolCalls: ToolCall[],
    result: string,
  ): Promise<ReflectionResult> {
    console.log(`[ReflectionEngine] Starting reflection on ${toolCalls.length} tool calls`);

    const conversationText = this.serializeConversation(messages);
    const toolCallSummary = toolCalls
      .map((tc) => `${tc.function.name}(...)`)
      .join(", ");

    const reflectionPrompt = `You are an AI agent reviewing your own performance on a completed task.
Analyze the conversation, tool calls made, and the final result. Answer these questions:

1. Did the task succeed? (true/false)
2. What went well? (wins)
3. What went wrong? (losses)
4. What should be remembered for future sessions? (lessons)

IMPORTANT: Return ONLY valid JSON matching this schema:
{
  "taskSucceeded": boolean,
  "wins": string[],
  "losses": string[],
  "lessons": string[],
  "memoryEntries": [{ "key": "<date>_<type>", "value": "<content>", "target": "memory" }]
}

Key format: use "<date>_win" for wins, "<date>_avoid" for losses (prefix with "AVOID:"), "<date>_lesson" for lessons.
Today's date: ${new Date().toISOString().split("T")[0]}

Tool calls made (${toolCalls.length}): ${toolCallSummary}

Final result:
${result.substring(0, 1000)}

Conversation:
---
${conversationText.substring(0, 3000)}
---`;

    try {
      const response = await aiClient.chat({
        messages: [
          {
            role: "system",
            content:
              "You are a precise self-evaluation system. Analyze the task outcome and return structured JSON. Be honest about failures and specific about successes. Keep entries concise — each win/loss/lesson should be one clear sentence.",
          },
          { role: "user", content: reflectionPrompt },
        ],
        temperature: 0.3,
      });

      if (!response.content || response.content.trim().length === 0) {
        console.log("[ReflectionEngine] AI returned empty response, using fallback");
        return this.fallbackResult(toolCalls.length, "AI returned empty response");
      }

      const parsed = this.parseReflectionResponse(response.content);
      const skillCandidate = parsed.taskSucceeded && toolCalls.length >= SKILL_CANDIDATE_THRESHOLD;
      const finalResult: ReflectionResult = {
        ...parsed,
        toolCallCount: toolCalls.length,
        skillCandidate,
      };

      console.log(
        `[ReflectionEngine] Reflection complete: success=${finalResult.taskSucceeded}, ` +
        `wins=${finalResult.wins.length}, losses=${finalResult.losses.length}, ` +
        `lessons=${finalResult.lessons.length}, skillCandidate=${finalResult.skillCandidate}`,
      );

      return finalResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.log(`[ReflectionEngine] Reflection failed: ${message}`);
      return this.fallbackResult(toolCalls.length, message);
    }
  }

  /**
   * Save reflection results to agent memory.
   * Writes win/avoid/lesson entries via agentMemory.add (consolidation handled by addReflection).
   */
  async saveReflection(result: ReflectionResult): Promise<void> {
    console.log(
      `[ReflectionEngine] Saving reflection: ${result.memoryEntries.length} entries`,
    );

    if (result.memoryEntries.length === 0) {
      console.log("[ReflectionEngine] No memory entries to save");
      return;
    }

    // Save each memory entry
    for (const entry of result.memoryEntries) {
      const addResult = agentMemory.add(entry.target, entry.key, entry.value);
      if (!addResult.success) {
        console.warn(
          `[ReflectionEngine] Failed to save entry '${entry.key}': ${addResult.error}`,
        );
      } else {
        console.log(`[ReflectionEngine] Saved entry '${entry.key}' to ${entry.target}`);
      }
    }
  }

  /**
   * Whether reflection should be triggered based on tool call count.
   * Triggers after REFLECTION_THRESHOLD (3+) tool calls.
   */
  shouldReflect(toolCallCount: number): boolean {
    return toolCallCount >= REFLECTION_THRESHOLD;
  }

  /**
   * Whether to suggest skill creation.
   * After SKILL_CANDIDATE_THRESHOLD (5+) tool calls with successful outcome.
   */
  shouldSuggestSkill(toolCallCount: number, taskSucceeded: boolean): boolean {
    return toolCallCount >= SKILL_CANDIDATE_THRESHOLD && taskSucceeded;
  }

  /**
   * Whether to trigger a periodic self-nudge.
   * Fires at multiples of SELF_NUDGE_INTERVAL (15).
   */
  shouldSelfNudge(totalToolCalls: number): boolean {
    return totalToolCalls > 0 && totalToolCalls % SELF_NUDGE_INTERVAL === 0;
  }

  /**
   * Load recent reflection entries from memory for inclusion in context packet.
   * Returns formatted string of the last `count` reflection entries, truncated to token budget.
   */
  getRecentReflections(count: number = 3, tokenBudget: number = 300): string {
    const entries = agentMemory.getEntries("memory");
    const reflectionEntries = entries.filter(
      (e: { key: string }) =>
        e.key.includes("_win") || e.key.includes("_avoid") || e.key.includes("_lesson") || e.key.startsWith("consolidated_"),
    );

    if (reflectionEntries.length === 0) return "";

    const recent = reflectionEntries.slice(-count);
    const formatted = recent
      .map((e: { key: string; value: string }) => `§ ${e.key}\n${e.value}`)
      .join("\n\n");

    const maxChars = Math.floor(tokenBudget * CHARS_PER_TOKEN);
    if (formatted.length > maxChars) {
      const truncated = formatted.substring(0, maxChars);
      const lastNewline = truncated.lastIndexOf("\n\n");
      return (lastNewline > 0 ? truncated.substring(0, lastNewline) : truncated) + "\n\n...(truncated)";
    }

    return formatted;
  }

  private parseReflectionResponse(content: string): Omit<ReflectionResult, "toolCallCount" | "skillCandidate"> {
    // Try to extract JSON from the response (may be wrapped in markdown code blocks)
    let jsonStr = content.trim();

    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    // Find first { and last } to extract JSON object
    const firstBrace = jsonStr.indexOf("{");
    const lastBrace = jsonStr.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
    }

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        taskSucceeded: Boolean(parsed.taskSucceeded),
        wins: Array.isArray(parsed.wins) ? parsed.wins.map(String) : [],
        losses: Array.isArray(parsed.losses) ? parsed.losses.map(String) : [],
        lessons: Array.isArray(parsed.lessons) ? parsed.lessons.map(String) : [],
        memoryEntries: Array.isArray(parsed.memoryEntries)
          ? parsed.memoryEntries.map((e: Record<string, unknown>) => ({
              key: String(e.key ?? ""),
              value: String(e.value ?? ""),
              target: e.target === "user" ? "user" as const : "memory" as const,
            }))
          : [],
      };
    } catch {
      console.log("[ReflectionEngine] Failed to parse reflection JSON, using fallback");
      return {
        taskSucceeded: false,
        wins: [],
        losses: ["Reflection response could not be parsed"],
        lessons: [],
        memoryEntries: [],
      };
    }
  }

  private fallbackResult(toolCallCount: number, error: string): ReflectionResult {
    return {
      taskSucceeded: false,
      toolCallCount,
      wins: [],
      losses: [`Reflection failed: ${error}`],
      lessons: [],
      skillCandidate: false,
      memoryEntries: [],
    };
  }

  private serializeConversation(messages: ChatMessage[]): string {
    return messages
      .map((m) => {
        const toolCallsStr = m.tool_calls
          ? ` [tools: ${m.tool_calls.map((tc) => tc.function.name).join(", ")}]`
          : "";
        return `${m.role}${toolCallsStr}: ${m.content.substring(0, 200)}`;
      })
      .join("\n");
  }
}

export const reflectionEngine = new ReflectionEngine();
