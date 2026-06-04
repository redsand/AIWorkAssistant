/**
 * SubagentSpawner: spawns isolated sub-agent sessions for parallel work.
 *
 * Each subagent runs in its own context window with a tool loop that excludes
 * `agent.spawn` and `cron.manage` to prevent recursion and uncontrolled
 * scheduling.  Results are returned as structured {@link SubagentResult}.
 */

import { aiClient } from "./opencode-client";
import { agentMemory } from "../memory/agent-memory";
import { soulManager } from "../memory/soul-manager";
import { skillManager } from "../skills/skill-manager";
import { getAllToolsForMode } from "./tool-registry";
import { dispatchToolCall } from "./tool-dispatcher";
import { SUBAGENT_SYSTEM_PROMPT } from "./prompts";

import type { ChatMessage, Tool as ProviderTool } from "./providers/types";

// ── Public types ─────────────────────────────────────────────────────────

export interface SubagentConfig {
  /** What the subagent should do. Must be self-contained. */
  prompt: string;
  /** Skill names to load and inject into the subagent context. */
  skills?: string[];
  /** Profile override (different SOUL.md). Not yet wired — reserved. */
  profile?: string;
  /** Max runtime in ms. Default 600 000 (10 min). */
  timeout?: number;
  /** Max tool calls before forcing stop. Default 30. */
  maxToolCalls?: number;
  /** Whether to inherit parent's MEMORY.md + SOUL.md. Default true. */
  inheritMemory?: boolean;
}

export interface SubagentResult {
  success: boolean;
  output: string;
  toolCallsUsed: number;
  duration: number;
  error?: string;
  memoryUpdates?: string[];
}

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TOOL_CALLS = 30;
const BLOCKED_TOOLS = new Set(["agent.spawn", "cron.manage"]);

// ── Implementation ───────────────────────────────────────────────────────

export class SubagentSpawner {
  /**
   * Spawn an isolated sub-agent session and return the result.
   *
   * The subagent runs its own tool loop (up to `maxToolCalls` iterations),
   * after which the final assistant content is collected and returned.
   */
  async spawn(config: SubagentConfig): Promise<SubagentResult> {
    // ── Validate ────────────────────────────────────────────────────────
    if (!config.prompt || typeof config.prompt !== "string") {
      return this.fail("prompt is required and must be a string");
    }

    if ((config as any)._isSubagent) {
      return this.fail("Recursive spawning is blocked — subagents cannot spawn further subagents.");
    }

    if (!aiClient.isConfigured()) {
      return this.fail("AI provider not configured");
    }

    const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    const maxToolCalls = config.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;

    // ── Build context ───────────────────────────────────────────────────
    const systemPrompt = this.buildSystemPrompt(config);
    const tools = this.buildToolSet();
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: config.prompt },
    ];

    const startTime = Date.now();
    let toolCallsUsed = 0;

    // ── Run with timeout ────────────────────────────────────────────────
    try {
      const result = await Promise.race([
        this.runToolLoop(messages, tools, maxToolCalls, (count) => {
          toolCallsUsed = count;
        }),
        this.createTimeout(timeout),
      ]);

      if ("timedOut" in result) {
        return {
          success: false,
          output: "",
          toolCallsUsed,
          duration: Date.now() - startTime,
          error: `Subagent timed out after ${timeout}ms`,
        };
      }

      return {
        success: true,
        output: result.output,
        toolCallsUsed,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        toolCallsUsed,
        duration: Date.now() - startTime,
        error: `Subagent failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private buildSystemPrompt(config: SubagentConfig): string {
    let prompt = SUBAGENT_SYSTEM_PROMPT;

    if (config.inheritMemory !== false) {
      // Inject MEMORY.md entries
      const memoryEntries = agentMemory.getEntries("memory");
      if (memoryEntries.length > 0) {
        prompt += "\n\n## Inherited Memory\n";
        for (const entry of memoryEntries) {
          prompt += `- ${entry.key}: ${entry.value}\n`;
        }
      }

      // Inject USER.md entries
      const userEntries = agentMemory.getEntries("user");
      if (userEntries.length > 0) {
        prompt += "\n\n## User Profile\n";
        for (const entry of userEntries) {
          prompt += `- ${entry.key}: ${entry.value}\n`;
        }
      }

      // Inject SOUL.md
      const soul = soulManager.load();
      if (soul) {
        prompt += `\n\n## Identity (SOUL.md)\n${soul}`;
      }
    }

    // Inject skill summaries if specified
    if (config.skills && config.skills.length > 0) {
      const summaries = skillManager.getSummariesText();
      if (summaries) {
        prompt += `\n\n## Loaded Skills\n${summaries}`;
      }
    }

    return prompt;
  }

  private buildToolSet(): ProviderTool[] {
    const allTools = getAllToolsForMode("productivity");
    return allTools
      .filter((t) => !BLOCKED_TOOLS.has(t.name))
      .map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.params,
        },
      }));
  }

  private async runToolLoop(
    messages: ChatMessage[],
    tools: ProviderTool[],
    maxToolCalls: number,
    onToolCount: (count: number) => void,
  ): Promise<{ output: string }> {
    let toolCallCount = 0;

    while (toolCallCount < maxToolCalls) {
      const response = await aiClient.chat({
        messages,
        tools,
        temperature: 0.7,
      });

      // If no tool calls, return the final content
      if (!response.toolCalls || response.toolCalls.length === 0) {
        onToolCount(toolCallCount);
        return { output: response.content || "" };
      }

      // Process tool calls
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: response.content || "",
        tool_calls: response.toolCalls,
      };
      messages.push(assistantMsg);

      for (const tc of response.toolCalls) {
        let params: Record<string, unknown>;
        try {
          params = JSON.parse(tc.function.arguments);
        } catch {
          params = {};
        }

        const result = await dispatchToolCall(
          tc.function.name,
          params,
          "subagent",
          true, // skipPolicyCheck for subagent
          { isSubagent: true },
        );

        const toolMsg: ChatMessage = {
          role: "tool",
          content: result.error
            ? JSON.stringify({ error: result.error })
            : JSON.stringify(result.data ?? { success: result.success }),
          tool_call_id: tc.id,
        };
        messages.push(toolMsg);
        toolCallCount++;
        onToolCount(toolCallCount);
      }

      // If we've hit the limit, get one final response
      if (toolCallCount >= maxToolCalls) {
        const finalResponse = await aiClient.chat({
          messages,
          tools,
          temperature: 0.7,
        });
        onToolCount(toolCallCount);
        return { output: finalResponse.content || "" };
      }
    }

    onToolCount(toolCallCount);
    return { output: "" };
  }

  private createTimeout(ms: number): Promise<{ timedOut: true }> {
    return new Promise((resolve) =>
      setTimeout(() => resolve({ timedOut: true as const }), ms),
    );
  }

  private fail(error: string): SubagentResult {
    return {
      success: false,
      output: "",
      toolCallsUsed: 0,
      duration: 0,
      error,
    };
  }
}

export const subagentSpawner = new SubagentSpawner();
