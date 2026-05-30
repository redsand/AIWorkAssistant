/**
 * Chat route for AI Assistant integration
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSystemPrompt, aiClient } from "../agent";
import { shouldUseContextEngine, assembleContext } from "../context-engine";
import {
  getToolsForRequest,
  getToolsByCategory,
  getToolCategories,
} from "../agent/tool-registry";
import { todoManager } from "../agent/todo-manager";
import { knowledgeStore } from "../agent/knowledge-store";
import { knowledgeGraph } from "../agent/knowledge-graph";
import { codebaseIndexer } from "../agent/codebase-indexer";
import { dispatchToolCall } from "../agent/tool-dispatcher";
import { AGENT_MODES } from "../config/constants";
import type { Tool, ChatMessage } from "../agent/opencode-client";
import { githubClient } from "../integrations/github/github-client";
import { jitbitClient } from "../integrations/jitbit/jitbit-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { jiraClient } from "../integrations/jira/jira-client";
import { conversationManager } from "../memory/conversation-manager";
import { env } from "../config/env";
import { agentRunDatabase } from "../agent-runs/database";
import { sanitizeValue } from "../agent-runs/sanitizer";

const MAX_SYSTEM_PROMPT_LENGTH = 4000;

const adminUserIds: Set<string> = new Set(
  (env.ADMIN_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
);

function canOverrideSystemPrompt(userId: string): boolean {
  return adminUserIds.size > 0 && adminUserIds.has(userId);
}


const chatRequestSchema = z.object({
  message: z.string(),
  mode: z
    .enum([AGENT_MODES.PRODUCTIVITY, AGENT_MODES.ENGINEERING])
    .default(AGENT_MODES.PRODUCTIVITY),
  userId: z.string().default("user"),
  sessionId: z.string().nullable().optional(),
  context: z.object({}).optional(),
  includeTools: z.boolean().default(true),
  includeMemory: z.boolean().default(true),
  systemPrompt: z.string().max(MAX_SYSTEM_PROMPT_LENGTH).optional(),
  model: z.string().optional(),
});

const createSessionSchema = z.object({
  userId: z.string(),
  mode: z.enum([AGENT_MODES.PRODUCTIVITY, AGENT_MODES.ENGINEERING]),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  context: z.object({}).optional(),
});

const MAX_TOOL_LOOPS = env.MAX_TOOL_LOOPS;

class ToolLoopLimitError extends Error {
  constructor(limit: number) {
    super(
      `The agent reached the maximum of ${limit} tool loops before producing a final response. Ask it to continue with a narrower scope or fewer searches.`,
    );
    this.name = "ToolLoopLimitError";
  }
}

class JobCancelledError extends Error {
  constructor(message = "Run cancelled by user") {
    super(message);
    this.name = "JobCancelledError";
  }
}

interface ProcessingJob {
  sessionId: string;
  status: "processing" | "completed" | "failed";
  startedAt: Date;
  lastActivityAt: Date;
  completedAt?: Date;
  runId?: string | null;
  cancelled: boolean;
  cancelReason?: string;
  events: Array<{ event: string; data: unknown }>;
  subscribers: Set<(event: string, data: unknown) => void>;
}

const processingJobs = new Map<string, ProcessingJob>();

// Persists which tool categories have been discovered per session so they are
// pre-expanded on subsequent requests instead of requiring a repeat discover_tools call.
const sessionDiscoveredCategories = new Map<string, Set<string>>();

function buildCategoryToolDefs(mode: string, category: string) {
  return getToolsByCategory(mode, category).map((tool) => {
    const properties: Record<string, unknown> = {};
    for (const [key, param] of Object.entries(tool.params)) {
      const { required: _, ...rest } = param as any;
      properties[key] = rest;
    }
    return {
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties,
          required: Object.entries(tool.params)
            .filter(([_, param]) => (param as any).required)
            .map(([name]) => name),
        },
      },
    };
  });
}

function preExpandFromSession(sessionId: string, mode: string, expandedTools: Tool[]) {
  const knownCategories = sessionDiscoveredCategories.get(sessionId);
  if (!knownCategories) return;
  const existingNames = new Set(expandedTools.map((t) => t.function.name));
  for (const category of knownCategories) {
    for (const td of buildCategoryToolDefs(mode, category)) {
      if (!existingNames.has(td.function.name)) {
        expandedTools.push(td);
        existingNames.add(td.function.name);
      }
    }
  }
}

function recordDiscoveredCategory(sessionId: string, category: string) {
  if (!sessionDiscoveredCategories.has(sessionId)) {
    sessionDiscoveredCategories.set(sessionId, new Set());
  }
  sessionDiscoveredCategories.get(sessionId)!.add(category);
}

function getOrCreateJob(sessionId: string): ProcessingJob {
  let job = processingJobs.get(sessionId);
  if (!job) {
    job = {
      sessionId,
      status: "processing",
      startedAt: new Date(),
      lastActivityAt: new Date(),
      cancelled: false,
      events: [],
      subscribers: new Set(),
    };
    processingJobs.set(sessionId, job);
  }
  return job;
}

function emitJobEvent(sessionId: string, event: string, data: unknown) {
  const job = processingJobs.get(sessionId);
  if (!job) return;
  job.lastActivityAt = new Date();
  if (job.runId) {
    try { agentRunDatabase.touchRun(job.runId); } catch (e) { console.error("[AgentRuns]", e); }
  }
  job.events.push({ event, data });
  for (const subscriber of job.subscribers) {
    try {
      subscriber(event, data);
    } catch {}
  }
}

function assertJobActive(job: ProcessingJob) {
  if (job.cancelled) {
    throw new JobCancelledError(job.cancelReason);
  }
}

function cancelProcessingJob(
  sessionId: string,
  reason = "Run cancelled by user",
): boolean {
  const job = processingJobs.get(sessionId);
  if (!job || job.status !== "processing") return false;

  job.cancelled = true;
  job.cancelReason = reason;
  job.status = "failed";
  job.completedAt = new Date();
  job.lastActivityAt = new Date();

  if (job.runId) {
    try { agentRunDatabase.cancelRun(job.runId, reason); } catch (e) { console.error("[AgentRuns]", e); }
  }

  emitJobEvent(sessionId, "error", {
    error: "Run cancelled",
    message: reason,
    cancelled: true,
  });

  return true;
}

function parseStoredToolContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function compactToolResultForContext(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const obj = result as Record<string, unknown>;
  const data = obj.data as Record<string, unknown> | undefined;
  if (data && typeof data === "object" && data.summary) {
    return {
      success: obj.success,
      data: {
        summary: data.summary,
        export_uuid: data.export_uuid,
        chunks_downloaded: data.chunks_downloaded,
        total_vulnerabilities: data.total_vulnerabilities,
        total_assets: data.total_assets,
        elapsed_seconds: data.elapsed_seconds,
        _guidance: data._guidance,
      },
    };
  }
  return result;
}

function stringifyToolResultForContext(result: unknown): string {
  const content = JSON.stringify(compactToolResultForContext(result));
  const maxChars = 25_000;
  if (content.length <= maxChars) return content;
  return `${content.substring(0, maxChars)}\n...[tool result truncated for chat context: ${content.length - maxChars} chars omitted]`;
}

function buildSessionRecovery(sessionId: string) {
  const session = conversationManager.getSession(sessionId);
  if (!session) return null;

  const messages = session.messages.map((message) => ({
    role: message.role,
    content: message.content,
    timestamp: message.timestamp.toISOString(),
    toolCalls: message.toolCalls,
    toolCallId: message.tool_call_id,
  }));
  const assistantMessages = messages
    .filter(
      (message) =>
        message.role === "assistant" && message.content.trim().length > 0,
    )
    .slice(-20);
  const toolResults = session.messages
    .filter((message) => message.role === "tool")
    .slice(-50)
    .map((message) => ({
      toolCallId: message.tool_call_id ?? null,
      timestamp: message.timestamp.toISOString(),
      result: parseStoredToolContent(message.content),
    }));
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const runs = agentRunDatabase.listRuns({ sessionId, limit: 20 }).runs;
  const job = processingJobs.get(sessionId);

  return {
    success: true,
    session: {
      id: session.id,
      userId: session.userId,
      mode: session.mode,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      messageCount: session.messages.length,
      lastUserMessage,
    },
    processing: job?.status === "processing",
    job: job
      ? {
          status: job.status,
          startedAt: job.startedAt.toISOString(),
          lastActivityAt: job.lastActivityAt.toISOString(),
          completedAt: job.completedAt?.toISOString() ?? null,
          cancelled: job.cancelled,
          eventCount: job.events.length,
        }
      : null,
    latestRun: runs[0] ?? null,
    runs,
    assistantMessages,
    toolResults,
    messages,
  };
}

async function runChatJob(
  sessionId: string,
  messages: ChatMessage[],
  tools: Tool[] | undefined,
  mode: string,
  userId: string,
  model?: string,
) {
  console.log("[Chat/Job] runChatJob entered for", sessionId);
  const job = getOrCreateJob(sessionId);
  if (job.cancelled) return;
  job.status = "processing";
  job.events = [];
  job.cancelled = false;
  job.cancelReason = undefined;
  job.startedAt = new Date();
  job.lastActivityAt = new Date();
  job.completedAt = undefined;

  // Preserve the original user query for logging (survives message pruning)
  const originalUserQuery = messages.find((m) => m.role === "user")?.content ?? "Unknown query";

  let runId: string | null = job.runId ?? null;
  if (!runId) {
    try { runId = agentRunDatabase.startRun({ sessionId, userId, mode }).id; job.runId = runId; } catch (e) { console.error("[AgentRuns]", e); }
  }

  try {
    let stepOrder = 0;
    assertJobActive(job);
    try { if (runId) agentRunDatabase.addStep({ runId, stepType: "model_request", content: { user_message: originalUserQuery }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
    console.log("[Chat/Job] Calling aiClient.chat for", sessionId);
    let response = await aiClient.chat({
      messages: messages,
      tools,
      temperature: 0.7,
      top_p: 0.95,
      model,
    });
    console.log("[Chat/Job] aiClient.chat completed for", sessionId);
    assertJobActive(job);
    try { if (runId) agentRunDatabase.addStep({ runId, stepType: "model_response", content: { model: response.model, usage: response.usage, responsePreview: typeof response.content === "string" ? response.content.slice(0, 500) : undefined }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }

    let allToolResults: Record<string, unknown> = {};
    let expandedTools = [...(tools || [])];
    preExpandFromSession(sessionId, mode, expandedTools);
    let loopCount = 0;

    const getLoadedToolNames = () =>
      expandedTools.map((t: Tool) => t.function.name);

    while (response.toolCalls && response.toolCalls.length > 0) {
      assertJobActive(job);
      loopCount++;

      if (loopCount > MAX_TOOL_LOOPS) {
        console.warn(
          `[Chat/Job] Tool loop limit (${MAX_TOOL_LOOPS}) reached for ${sessionId}`,
        );
        throw new ToolLoopLimitError(MAX_TOOL_LOOPS);
      }

      if (response.thinking) {
        emitJobEvent(sessionId, "thinking", { thinking: response.thinking });
        try { if (runId) agentRunDatabase.addStep({ runId, stepType: "thinking", content: { thinking: response.thinking }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
      }
      if (response.content && response.content.trim()) {
        emitJobEvent(sessionId, "content", { content: response.content });
        try { if (runId) agentRunDatabase.addStep({ runId, stepType: "content", content: { content: response.content }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
      }

      conversationManager.addMessage(sessionId, {
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls.map((tc) => {
          let parsedArgs: any = {};
          try {
            parsedArgs = JSON.parse(tc.function.arguments);
          } catch {
            parsedArgs = { raw: tc.function.arguments };
          }
          return {
            id: tc.id,
            name: tc.function.name,
            params: parsedArgs,
          };
        }),
      });

      const toolCalls = response.toolCalls.map((tc) => {
        let parsedArgs: any = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments);
        } catch {
          parsedArgs = { raw: tc.function.arguments };
        }
        return { id: tc.id, name: tc.function.name, params: parsedArgs };
      });

      const spawnCalls = toolCalls.filter((tc) => tc.name === "agent.spawn");
      const regularCalls = toolCalls.filter((tc) => tc.name !== "agent.spawn");

      for (const tc of regularCalls) {
        assertJobActive(job);
        emitJobEvent(sessionId, "tool_start", {
          id: tc.id,
          name: tc.name,
          params: tc.params,
        });

        try { if (runId) agentRunDatabase.addStep({ runId, stepType: "tool_call", toolName: tc.name, sanitizedParams: sanitizeValue(tc.params), stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
        const toolStart = Date.now();
        const dispatchParams = { ...tc.params, _mode: mode, _loadedTools: getLoadedToolNames() };
        const result = await dispatchToolCall(tc.name, dispatchParams, userId, false, { messages, mode });
        assertJobActive(job);
        const toolDuration = Date.now() - toolStart;
        const contextResult = compactToolResultForContext(result);
        allToolResults[tc.id] = contextResult;

        try { if (runId) agentRunDatabase.addStep({ runId, stepType: "tool_result", toolName: tc.name, success: result.success !== false, errorMessage: result.error, durationMs: toolDuration, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }

        emitJobEvent(sessionId, "tool_result", { id: tc.id, result });

        if (tc.name.startsWith("todo.")) {
          emitJobEvent(sessionId, "todo_changed", { action: tc.name });
        }

        if (tc.name === "discover_tools" && result.success) {
          const category = tc.params.category as string | undefined;
          if (category) {
            recordDiscoveredCategory(sessionId, category);
            const categoryToolDefs = buildCategoryToolDefs(mode, category);
            const existingNames = new Set(expandedTools.map((t) => t.function.name));
            for (const td of categoryToolDefs) {
              if (!existingNames.has(td.function.name)) {
                expandedTools.push(td);
                existingNames.add(td.function.name);
              }
            }
          }
        }

        conversationManager.addMessage(sessionId, {
          role: "tool",
          content: stringifyToolResultForContext(result),
          tool_call_id: tc.id,
        });
      }

      if (spawnCalls.length > 0) {
        for (const tc of spawnCalls) {
          emitJobEvent(sessionId, "tool_start", {
            id: tc.id,
            name: tc.name,
            params: tc.params,
          });
        }

        const spawnPromises = spawnCalls.map(async (tc) => {
          assertJobActive(job);
          try { if (runId) agentRunDatabase.addStep({ runId, stepType: "tool_call", toolName: tc.name, sanitizedParams: sanitizeValue(tc.params), stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
          const spawnStart = Date.now();
          const dispatchParams = { ...tc.params, _mode: mode, _loadedTools: getLoadedToolNames() };
          const result = await dispatchToolCall(
            tc.name,
            dispatchParams,
            userId,
            false,
            { messages, mode },
          );
          assertJobActive(job);
          const spawnDuration = Date.now() - spawnStart;
          try { if (runId) agentRunDatabase.addStep({ runId, stepType: "tool_result", toolName: tc.name, success: result.success !== false, errorMessage: result.error, durationMs: spawnDuration, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
          return { id: tc.id, result };
        });

        const spawnResults = await Promise.all(spawnPromises);

        for (const { id, result } of spawnResults) {
          allToolResults[id] = result;
          emitJobEvent(sessionId, "tool_result", { id, result });

          conversationManager.addMessage(sessionId, {
            role: "tool",
            content: stringifyToolResultForContext(result),
            tool_call_id: id,
          });
        }
      }

      messages = [
        ...messages,
        {
          role: "assistant",
          content: response.content,
          tool_calls: response.toolCalls,
        },
        ...toolCalls.map((tc) => ({
          role: "tool" as const,
          content: stringifyToolResultForContext(allToolResults[tc.id]),
          tool_call_id: tc.id,
        })),
      ];

      // Re-prune to stay within context limits during tool loops.
      // The chat() call prunes via buildRequestBody, but messages accumulate
      // across iterations and expandedTools can grow via discover_tools.
      const currentTools =
        expandedTools.length > 0 ? expandedTools : tools || undefined;
      messages = aiClient.pruneMessages(messages, currentTools) as ChatMessage[];

      // Use preserved original query (pruning may remove user messages)
      try { if (runId) agentRunDatabase.addStep({ runId, stepType: "model_request", content: { user_message: originalUserQuery }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
      assertJobActive(job);
      response = await aiClient.chat({
        messages: messages,
        tools: expandedTools.length > 0 ? expandedTools : undefined,
        temperature: 0.7,
        top_p: 0.95,
        model,
      });
      assertJobActive(job);
      try { if (runId) agentRunDatabase.addStep({ runId, stepType: "model_response", content: { model: response.model, usage: response.usage, responsePreview: typeof response.content === "string" ? response.content.slice(0, 500) : undefined }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
    }

    assertJobActive(job);
    conversationManager.addMessage(sessionId, {
      role: "assistant",
      content: response.content,
    });

    if (response.thinking) {
      emitJobEvent(sessionId, "thinking", { thinking: response.thinking });
      try { if (runId) agentRunDatabase.addStep({ runId, stepType: "thinking", content: { thinking: response.thinking }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
    }
    if (response.content && response.content.trim()) {
      try { if (runId) agentRunDatabase.addStep({ runId, stepType: "content", content: { content: response.content }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
    }
    job.status = "completed";
    job.completedAt = new Date();

    try { if (runId) agentRunDatabase.completeRun(runId, { model: response.model, promptTokens: response.usage?.promptTokens, completionTokens: response.usage?.completionTokens, totalTokens: response.usage?.totalTokens, toolLoopCount: loopCount }); } catch (e) { console.error("[AgentRuns]", e); }

    emitJobEvent(sessionId, "content", { content: response.content });
    emitJobEvent(sessionId, "done", {
      usage: response.usage,
      model: response.model,
    });
  } catch (error) {
    console.error(`[Chat/Job] Failed for session ${sessionId}:`, error);
    const cancelled = error instanceof JobCancelledError;
    if (!cancelled || job.events[job.events.length - 1]?.event !== "error") {
      emitJobEvent(sessionId, "error", {
      error: "Failed to process request",
      message: error instanceof Error ? error.message : "Unknown error",
      cancelled,
      });
    }

    job.status = "failed";
    job.completedAt = new Date();
    emitJobEvent(sessionId, "state", { processing: false, sessionId });

    try {
      if (runId && !cancelled) {
        agentRunDatabase.failRun(runId, error instanceof Error ? error.message : "Unknown error");
      }
    } catch (e) { console.error("[AgentRuns]", e); }
  }
}

export async function chatRoutes(fastify: FastifyInstance) {
  /**
   * Main chat endpoint
   */
  fastify.post("/chat", async (request, reply) => {
    let runId: string | null = null;
    try {
      const body = chatRequestSchema.parse(request.body);


      try { runId = agentRunDatabase.startRun({ sessionId: body.sessionId ?? null, userId: body.userId, mode: body.mode }).id; } catch (e) { console.error("[AgentRuns]", e); }

      if (!aiClient.isConfigured()) {
        try { if (runId) agentRunDatabase.failRun(runId, "AI provider not configured"); } catch (e) { console.error("[AgentRuns]", e); }
        reply.code(503);
        const provider = env.AI_PROVIDER;
        const keyHint =
          provider === "zai"
            ? "ZAI_API_KEY"
            : provider === "ollama"
              ? "OLLAMA_API_URL"
              : "OPENCODE_API_KEY";
        return {
          error: `AI provider (${provider}) not configured`,
          message: `Please set the ${keyHint} environment variable`,
        };
      }

      let sessionId = body.sessionId;
      let messages: ChatMessage[];

      const existingSession = sessionId
        ? conversationManager.getSession(sessionId)
        : null;

      const systemPrompt = (body.systemPrompt && canOverrideSystemPrompt(body.userId))
        ? body.systemPrompt
        : getSystemPrompt(body.mode, body.message);

      if (existingSession) {
        conversationManager.addMessage(sessionId!, {
          role: "user",
          content: body.message,
        });

        if (body.includeMemory && shouldUseContextEngine()) {
          const sessionMessages = await conversationManager.getSessionMessages(
            sessionId!,
            body.includeMemory,
            "engine",
          );
          const estimatedToolTokens = body.includeTools
            ? Math.min(aiClient.estimateTokens([], getToolsForRequest(body.mode, body.message) as any) || 12000, 12000)
            : 0;
          const packet = await assembleContext({
            mode: body.mode,
            query: body.message,
            sessionMessages,
            sessionId: sessionId!,
            includeMemory: body.includeMemory,
            toolInventory: "",
            providerMaxTokens: aiClient.getMaxContextTokens(),
            toolTokens: estimatedToolTokens,
            userId: body.userId,
          });
          messages = packet.messages;
          console.log(
            `[ContextEngine] Packet assembled: ${packet.diagnostics.finalMessageCount} messages, ${packet.totalTokens} tokens, compression=${packet.diagnostics.compressionRatio.toFixed(2)}, budget=${JSON.stringify(packet.diagnostics.budgetUtilization)}`,
          );
        } else {
          const sessionMessages = await conversationManager.getSessionMessages(
            sessionId!,
            body.includeMemory,
          );
          messages = [
            { role: "system", content: systemPrompt },
            ...sessionMessages,
          ];
        }
      } else {
        if (sessionId) {
          console.log(
            `[Chat] Session ${sessionId} not found, creating new session`,
          );
        }

        sessionId = conversationManager.startSession(body.userId, body.mode, {
          title: `Chat on ${new Date().toLocaleDateString()}`,
          context: body.context,
        });

        conversationManager.addMessage(sessionId, {
          role: "user",
          content: body.message,
        });

        messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: body.message },
        ];
      }

      let tools: Tool[] | undefined = undefined;
      if (body.includeTools) {
        const modeTools = getToolsForRequest(body.mode, body.message);
        tools = modeTools.map((tool) => {
          const properties: Record<string, unknown> = {};
          for (const [key, param] of Object.entries(tool.params)) {
            const { required: _, ...rest } = param as any;
            properties[key] = rest;
          }
          return {
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: {
                type: "object",
                properties,
                required: Object.entries(tool.params)
                  .filter(([_, param]) => (param as any).required)
                  .map(([name]) => name),
              },
            },
          };
        });
      }

      // Preserve the original user query for logging (survives message pruning)
      const originalUserQuery = body.message;
      let stepOrder = 0;
      try { if (runId) agentRunDatabase.addStep({ runId, stepType: "model_request", content: { user_message: originalUserQuery }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
      let response = await aiClient.chat({
        messages: messages,
        tools,
        temperature: 0.7,
        top_p: 0.95,
        model: body.model,
      });
      try { if (runId) agentRunDatabase.addStep({ runId, stepType: "model_response", content: { model: response.model, usage: response.usage, responsePreview: typeof response.content === "string" ? response.content.slice(0, 500) : undefined }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }

      let allToolCalls: Array<{ id: string; name: string; params: any }> = [];
      let allToolResults: Record<string, unknown> = {};
      let expandedTools = [...(tools || [])];
      if (sessionId) preExpandFromSession(sessionId, body.mode, expandedTools);

      const getLoadedToolNames = () =>
        expandedTools.map((t: Tool) => t.function.name);

      let loopCount = 0;

      while (response.toolCalls && response.toolCalls.length > 0) {
        loopCount++;

        if (loopCount > MAX_TOOL_LOOPS) {
          console.warn(
            `[Chat] Tool loop limit (${MAX_TOOL_LOOPS}) reached, breaking`,
          );
          throw new ToolLoopLimitError(MAX_TOOL_LOOPS);
        }

        if (response.thinking) {
          try { if (runId) agentRunDatabase.addStep({ runId, stepType: "thinking", content: { thinking: response.thinking }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
        }
        if (response.content && response.content.trim()) {
          try { if (runId) agentRunDatabase.addStep({ runId, stepType: "content", content: { content: response.content }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
        }

        if (sessionId) {
          conversationManager.addMessage(sessionId, {
            role: "assistant",
            content: response.content,
            toolCalls: response.toolCalls.map((tc) => {
              let parsedArgs: any = {};
              try {
                parsedArgs = JSON.parse(tc.function.arguments);
              } catch {
                parsedArgs = { raw: tc.function.arguments };
              }
              return {
                id: tc.id,
                name: tc.function.name,
                params: parsedArgs,
              };
            }),
          });
        }

        const toolCalls = response.toolCalls.map((tc) => {
          let parsedArgs: any = {};
          try {
            parsedArgs = JSON.parse(tc.function.arguments);
          } catch {
            parsedArgs = { raw: tc.function.arguments };
          }
          return { id: tc.id, name: tc.function.name, params: parsedArgs };
        });

        allToolCalls = allToolCalls.concat(toolCalls);

        for (const tc of toolCalls) {
          try { if (runId) agentRunDatabase.addStep({ runId, stepType: "tool_call", toolName: tc.name, sanitizedParams: sanitizeValue(tc.params), stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
          const toolStart = Date.now();
          const dispatchParams = { ...tc.params, _mode: body.mode, _loadedTools: getLoadedToolNames() };
          const result = await dispatchToolCall(
            tc.name,
            dispatchParams,
            body.userId,
            false,
            { messages: messages || [], mode: body.mode },
          );
          const toolDuration = Date.now() - toolStart;
          const contextResult = compactToolResultForContext(result);
          allToolResults[tc.id] = contextResult;

          try { if (runId) agentRunDatabase.addStep({ runId, stepType: "tool_result", toolName: tc.name, success: result.success !== false, errorMessage: result.error, durationMs: toolDuration, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }

          if (tc.name === "discover_tools" && result.success) {
            const category = tc.params.category as string | undefined;
            if (category) {
              if (sessionId) recordDiscoveredCategory(sessionId, category);
              const categoryToolDefs = buildCategoryToolDefs(body.mode, category);
              const existingNames = new Set(expandedTools.map((t) => t.function.name));
              for (const td of categoryToolDefs) {
                if (!existingNames.has(td.function.name)) {
                  expandedTools.push(td);
                  existingNames.add(td.function.name);
                }
              }
            }
          }

          if (sessionId) {
            conversationManager.addMessage(sessionId, {
              role: "tool",
              content: stringifyToolResultForContext(result),
              tool_call_id: tc.id,
            });
          }
        }

        messages = [
          ...messages,
          {
            role: "assistant",
            content: response.content,
            tool_calls: response.toolCalls,
          },
          ...toolCalls.map((tc) => ({
            role: "tool" as const,
            content: stringifyToolResultForContext(allToolResults[tc.id]),
            tool_call_id: tc.id,
          })),
        ];

        const currentTools =
          expandedTools.length > 0 ? expandedTools : tools || undefined;
        messages = aiClient.pruneMessages(messages, currentTools) as ChatMessage[];

        // Use preserved original query (pruning may remove user messages)
        try { if (runId) agentRunDatabase.addStep({ runId, stepType: "model_request", content: { user_message: originalUserQuery }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
        response = await aiClient.chat({
          messages: messages,
          tools: expandedTools.length > 0 ? expandedTools : undefined,
          temperature: 0.7,
          top_p: 0.95,
          model: body.model,
        });
        try { if (runId) agentRunDatabase.addStep({ runId, stepType: "model_response", content: { model: response.model, usage: response.usage, responsePreview: typeof response.content === "string" ? response.content.slice(0, 500) : undefined }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
      }

      if (sessionId) {
        conversationManager.addMessage(sessionId, {
          role: "assistant",
          content: response.content,
        });
      }

      if (response.thinking) {
        try { if (runId) agentRunDatabase.addStep({ runId, stepType: "thinking", content: { thinking: response.thinking }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
      }
      if (response.content && response.content.trim()) {
        try { if (runId) agentRunDatabase.addStep({ runId, stepType: "content", content: { content: response.content }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
      }

      try { if (runId) agentRunDatabase.completeRun(runId, { model: response.model, promptTokens: response.usage?.promptTokens, completionTokens: response.usage?.completionTokens, totalTokens: response.usage?.totalTokens, toolLoopCount: loopCount }); } catch (e) { console.error("[AgentRuns]", e); }

      return {
        sessionId,
        content: response.content,
        thinking: response.thinking,
        toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
        toolResults:
          Object.keys(allToolResults).length > 0 ? allToolResults : undefined,
        usage: response.usage,
        model: response.model,
        done: response.done,
      };
    } catch (error) {
      fastify.log.error(error);
      try { if (runId) agentRunDatabase.failRun(runId, error instanceof Error ? error.message : "Unknown error"); } catch (e) { console.error("[AgentRuns]", e); }
      return {
        error: "Failed to process chat request",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  /**
   * Stream chat endpoint
   */
  fastify.post("/chat/stream", async (request, reply): Promise<void> => {
    const body = chatRequestSchema.parse(request.body);

    if (!aiClient.isConfigured()) {
      reply.code(503);
      const provider = env.AI_PROVIDER;
      const keyHint =
        provider === "zai"
          ? "ZAI_API_KEY"
          : provider === "ollama"
            ? "OLLAMA_API_URL"
            : "OPENCODE_API_KEY";
      return reply.send({
        error: `AI provider (${provider}) not configured`,
        message: `Please set the ${keyHint} environment variable`,
      });
    }

    reply.hijack();

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders();
    if (reply.raw.socket) {
      reply.raw.socket.setNoDelay(true);
    }

    const sendEvent = (event: string, data: unknown) => {
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {}
    };

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);

    const cleanupConnection = () => {
      clearInterval(heartbeat);
      try {
        reply.raw.end();
      } catch {}
    };

    try {
      let sessionId = body.sessionId;
      const activeJob = sessionId ? processingJobs.get(sessionId) : null;

      if (activeJob?.status === "processing") {
        sendEvent("session", { sessionId });
        for (const evt of activeJob.events) {
          sendEvent(evt.event, evt.data);
        }

        const subscriber = (event: string, data: unknown) => {
          sendEvent(event, data);
          if (event === "done" || event === "error") {
            setTimeout(() => {
              cleanupConnection();
            }, 100);
          }
        };
        activeJob.subscribers.add(subscriber);

        const socket = reply.raw.socket || request.raw.socket;
        if (socket) {
          socket.on("close", () => {
            activeJob.subscribers.delete(subscriber);
            cleanupConnection();
          });
        }
        return;
      }

      const systemPrompt = (body.systemPrompt && canOverrideSystemPrompt(body.userId))
        ? body.systemPrompt
        : getSystemPrompt(body.mode, body.message);

      const existingSession = sessionId
        ? conversationManager.getSession(sessionId)
        : null;

      let messages: ChatMessage[];

      if (existingSession) {
        if (body.includeMemory && shouldUseContextEngine()) {
          sendEvent("processing", { message: "Assembling context..." });
          const sessionMessages = await conversationManager.getSessionMessages(
            sessionId!,
            body.includeMemory,
            "engine",
          );
          const estimatedToolTokens = body.includeTools
            ? Math.min(aiClient.estimateTokens([], getToolsForRequest(body.mode, body.message) as any) || 12000, 12000)
            : 0;
          const packet = await assembleContext({
            mode: body.mode,
            query: body.message,
            sessionMessages,
            sessionId: sessionId!,
            includeMemory: body.includeMemory,
            toolInventory: "",
            providerMaxTokens: aiClient.getMaxContextTokens(),
            toolTokens: estimatedToolTokens,
            userId: body.userId,
          });
          messages = packet.messages;
          messages.push({ role: "user", content: body.message });
          console.log(
            `[ContextEngine] Packet assembled: ${packet.diagnostics.finalMessageCount} messages, ${packet.totalTokens} tokens, compression=${packet.diagnostics.compressionRatio.toFixed(2)}, budget=${JSON.stringify(packet.diagnostics.budgetUtilization)}`,
          );
        } else {
          const sessionMessages = await conversationManager.getSessionMessages(
            sessionId!,
            body.includeMemory,
          );
          messages = [
            { role: "system", content: systemPrompt },
            ...sessionMessages,
            { role: "user", content: body.message },
          ];
        }
      } else {
        sessionId = conversationManager.startSession(body.userId, body.mode);
        messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: body.message },
        ];
      }

      conversationManager.addMessage(sessionId!, {
        role: "user",
        content: body.message,
      });

      sendEvent("session", { sessionId });

      // Create job and DB run early so the client sees activity and the
      // agent-runs page shows the run immediately — before the slow context
      // assembly begins.
      const job = getOrCreateJob(sessionId!);
      const subscriber = (event: string, data: unknown) => {
        sendEvent(event, data);
        if (event === "done" || event === "error") {
          console.log(`[Chat/Stream] Subscriber received ${event}, scheduling cleanup`);
          setTimeout(() => {
            cleanupConnection();
          }, 100);
        }
      };
      job.subscribers.add(subscriber);
      let earlyRunId: string | null = null;
      try { earlyRunId = agentRunDatabase.startRun({ sessionId, userId: body.userId, mode: body.mode }).id; job.runId = earlyRunId; } catch (e) { console.error("[AgentRuns]", e); }

      let tools: Tool[] | undefined = undefined;
      if (body.includeTools) {
        const modeTools = getToolsForRequest(body.mode, body.message);
        tools = modeTools.map((tool) => {
          const properties: Record<string, unknown> = {};
          for (const [key, param] of Object.entries(tool.params)) {
            const { required: _, ...rest } = param as any;
            properties[key] = rest;
          }
          return {
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: {
                type: "object",
                properties,
                required: Object.entries(tool.params)
                  .filter(([_, param]) => (param as any).required)
                  .map(([name]) => name),
              },
            },
          };
        });
      }

      console.log("[Chat/Stream] Starting runChatJob for", sessionId);
      runChatJob(sessionId!, messages, tools, body.mode, body.userId, body.model)
        .then(() => console.log("[Chat/Stream] runChatJob completed for", sessionId))
        .catch((err) => {
          console.error("[Chat/Stream] Background job error:", err);
        })
        .finally(() => {
          job.subscribers.delete(subscriber);
          setTimeout(() => {
            if (job.subscribers.size === 0) {
              processingJobs.delete(sessionId!);
            }
          }, 5000);
        });

      // Detect actual client disconnect via the underlying socket.
      // Do NOT use request.raw.on("close") — Fastify destroys the request
      // stream after body parsing, which fires long before the client leaves.
      const socket = reply.raw.socket || request.raw.socket;
      if (socket) {
        socket.on("close", () => {
          job.subscribers.delete(subscriber);
          cleanupConnection();
        });
        socket.on("error", () => {
          job.subscribers.delete(subscriber);
          cleanupConnection();
        });
      }

      // Keep the SSE connection alive until the client disconnects or the
      // job completes and cleanupConnection() ends the response.
      await new Promise<void>((resolve) => {
        if (socket) {
          socket.once("close", resolve);
        } else {
          setTimeout(() => resolve(), 300000);
        }
      });
    } catch (error) {
      fastify.log.error(error);
      sendEvent("error", {
        error: "Failed to process stream request",
        message: error instanceof Error ? error.message : "Unknown error",
      });
      cleanupConnection();
    }
  });

  fastify.post("/chat/sessions/:sessionId/cancel", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = conversationManager.getSession(sessionId);

    if (!session) {
      reply.code(404);
      return { error: "Session not found" };
    }

    const cancelled = cancelProcessingJob(sessionId);
    return {
      success: true,
      sessionId,
      cancelled,
      message: cancelled ? "Run cancelled" : "No active run for session",
    };
  });

  fastify.get("/chat/sessions/:sessionId/recovery", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const recovery = buildSessionRecovery(sessionId);

    if (!recovery) {
      reply.code(404);
      return { error: "Session not found" };
    }

    return recovery;
  });

  fastify.get("/chat/sessions/:sessionId/status", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const job = processingJobs.get(sessionId);

    if (!job) {
      const session = conversationManager.getSession(sessionId);
      return {
        sessionId,
        processing: false,
        exists: session !== null,
      };
    }

    return {
      sessionId,
      processing: job.status === "processing",
      status: job.status,
      startedAt: job.startedAt,
      lastActivityAt: job.lastActivityAt,
      completedAt: job.completedAt,
      cancelled: job.cancelled,
      eventCount: job.events.length,
    };
  });

  fastify.get("/chat/sessions/:sessionId/stream", async (request, reply): Promise<void> => {
    const { sessionId } = request.params as { sessionId: string };
    const session = conversationManager.getSession(sessionId);

    if (!session) {
      reply.code(404);
      return reply.send({ error: "Session not found" });
    }

    reply.hijack();

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders();
    if (reply.raw.socket) {
      reply.raw.socket.setNoDelay(true);
    }

    const sendEvent = (event: string, data: unknown) => {
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {}
    };

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);

    const cleanupConnection = () => {
      clearInterval(heartbeat);
      try {
        reply.raw.end();
      } catch {}
    };

    const job = processingJobs.get(sessionId);
    if (job && job.status === "processing") {
      for (const evt of job.events) {
        sendEvent(evt.event, evt.data);
      }

      const subscriber = (event: string, data: unknown) => {
        sendEvent(event, data);
        if (event === "done" || event === "error") {
          setTimeout(() => {
            cleanupConnection();
          }, 100);
        }
      };
      job.subscribers.add(subscriber);

      const socket1 = reply.raw.socket || request.raw.socket;
      if (socket1) {
        socket1.on("close", () => {
          job.subscribers.delete(subscriber);
          cleanupConnection();
        });
      }
    } else {
      sendEvent("state", { processing: false, sessionId });

      const waitInterval = setInterval(() => {
        const currentJob = processingJobs.get(sessionId);
        if (currentJob && currentJob.status === "processing") {
          clearInterval(waitInterval);
          for (const evt of currentJob.events) {
            sendEvent(evt.event, evt.data);
          }
          const subscriber = (event: string, data: unknown) => {
            sendEvent(event, data);
            if (event === "done" || event === "error") {
              setTimeout(() => {
                cleanupConnection();
              }, 100);
            }
          };
          currentJob.subscribers.add(subscriber);
          const socket2 = reply.raw.socket || request.raw.socket;
          if (socket2) {
            socket2.on("close", () => {
              currentJob.subscribers.delete(subscriber);
              cleanupConnection();
            });
          }
        }
      }, 500);

      const socket3 = reply.raw.socket || request.raw.socket;
      if (socket3) {
        socket3.on("close", () => {
          clearInterval(waitInterval);
          cleanupConnection();
        });
      }
    }
  });

  fastify.get("/chat/health", async (_request, _reply) => {
    const provider = env.AI_PROVIDER;
    const isConfigured = aiClient.isConfigured();
    const isValid = isConfigured ? await aiClient.validateConfig() : false;

    const [githubConfigured, gitlabConfigured, jiraConfigured, jitbitConfigured] = await Promise.all([
      githubClient.isConfigured(),
      gitlabClient.isConfigured(),
      jiraClient.isConfigured(),
      jitbitClient.isConfigured(),
    ]);

    const [githubValid, gitlabValid, jiraValid, jitbitValid] = await Promise.all([
      githubConfigured ? githubClient.validateConfig().catch(() => false) : false,
      gitlabConfigured ? gitlabClient.validateConfig().catch(() => false) : false,
      jiraConfigured ? jiraClient.validateConfig().catch(() => false) : false,
      jitbitConfigured ? jitbitClient.validateConfig().catch(() => false) : false,
    ]);

    const providerKeyMap: Record<string, { key: string; url: string }> = {
      opencode: { key: env.OPENCODE_API_KEY, url: env.OPENCODE_API_URL },
      zai: { key: env.ZAI_API_KEY, url: env.ZAI_API_URL },
      ollama: { key: env.OLLAMA_API_KEY || "local", url: env.OLLAMA_API_URL },
    };

    const info = providerKeyMap[provider] || providerKeyMap.opencode;

    return {
      provider: {
        active: provider,
        configured: isConfigured,
        valid: isValid,
        baseUrl: info.url,
      },
      integrations: {
        github: { configured: githubConfigured, valid: githubValid },
        gitlab: { configured: gitlabConfigured, valid: gitlabValid },
        jira: { configured: jiraConfigured, valid: jiraValid },
        jitbit: { configured: jitbitConfigured, valid: jitbitValid },
      },
    };
  });

  /**
   * Create new conversation session
   */
  fastify.post("/chat/sessions", async (request, reply) => {
    try {
      const body = createSessionSchema.parse(request.body);

      const sessionId = conversationManager.startSession(
        body.userId,
        body.mode,
        {
          title: body.title,
          tags: body.tags,
          context: body.context,
        },
      );

      reply.code(201);
      return {
        success: true,
        sessionId,
        message: "Session created successfully",
      };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to create session",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  /**
   * Get conversation session details
   */
  fastify.get("/chat/sessions/:sessionId", async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };

      const session = conversationManager.getSession(sessionId);

      if (!session) {
        reply.code(404);
        return {
          error: "Session not found",
        };
      }

      return {
        success: true,
        session: {
          id: session.id,
          userId: session.userId,
          mode: session.mode,
          messageCount: session.messages.length,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          metadata: session.metadata,
        },
      };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to get session",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  /**
   * End conversation session
   */
  fastify.post("/chat/sessions/:sessionId/end", async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };

      await conversationManager.endSession(sessionId);

      return {
        success: true,
        message: "Session ended and saved to long-term memory",
      };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to end session",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  fastify.get("/chat/sessions", async (request, reply) => {
    try {
      const { userId } = request.query as { userId?: string };
      const sessions = conversationManager.listSessionsForUser(
        userId || "web-user",
      );
      return { success: true, sessions };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to list sessions",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  fastify.get("/chat/sessions/:sessionId/messages", async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };
      const messages =
        conversationManager.getSessionMessagesForDisplay(sessionId);
      return { success: true, sessionId, messages };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to get messages",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  fastify.delete("/chat/sessions/:sessionId", async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };
      conversationManager.deleteSession(sessionId);
      return { success: true };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to delete session",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  /**
   * Search long-term memory
   */
  fastify.get("/chat/memory/search", async (request, reply) => {
    try {
      const { userId, query, limit } = request.query as {
        userId: string;
        query?: string;
        limit?: string;
      };

      if (!userId) {
        reply.code(400);
        return {
          error: "userId is required",
        };
      }

      const results = conversationManager.searchMemories(
        userId,
        query || "",
        limit ? parseInt(limit) : 10,
      );

      return {
        success: true,
        results,
        count: results.length,
      };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to search memory",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  /**
   * Get relevant memories for context
   */
  fastify.post("/chat/memory/relevant", async (request, reply) => {
    try {
      const { userId, context, limit } = request.body as {
        userId: string;
        context: string;
        limit?: number;
      };

      if (!userId || !context) {
        reply.code(400);
        return {
          error: "userId and context are required",
        };
      }

      const relevant = conversationManager.getRelevantMemories(
        userId,
        context,
        limit || 3,
      );

      return {
        success: true,
        relevant,
      };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to get relevant memories",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  /**
   * Get memory manager statistics
   */
  fastify.get("/chat/memory/stats", async (_request, reply) => {
    try {
      const stats = conversationManager.getStats();

      return {
        success: true,
        stats,
      };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to get stats",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  fastify.get("/chat/tools", async (request) => {
    const { mode } = request.query as { mode?: string };
    const toolMode = mode || "productivity";
    const categories = getToolCategories(toolMode);

    const toolsByCategory: Record<
      string,
      Array<{ name: string; description: string; params: string[] }>
    > = {};

    for (const [category] of Object.entries(categories).sort(([a], [b]) => a.localeCompare(b))) {
      const categoryTools = getToolsByCategory(toolMode, category);
      toolsByCategory[category] = categoryTools.map((t) => ({
        name: t.name,
        description: t.description,
        params: Object.keys(t.params),
      }));
    }

    return { success: true, mode: toolMode, categories: toolsByCategory };
  });

  fastify.get("/chat/todos", async (request) => {
    const { sessionId } = request.query as { sessionId?: string };
    const lists = todoManager.getLists(sessionId);
    return {
      success: true,
      lists: lists.map((l) => ({
        id: l.id,
        title: l.title,
        itemCount: l.items.length,
        progress: todoManager.getProgress(l.id),
        items: l.items,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      })),
    };
  });

  fastify.get("/chat/knowledge/search", async (request) => {
    const { query, limit, source } = request.query as {
      query?: string;
      limit?: string;
      source?: string;
    };
    if (!query) return { success: true, results: [], count: 0 };

    const results = knowledgeStore.search(query, {
      limit: limit ? parseInt(limit) : 5,
      source: source as any,
    });

    return {
      success: true,
      results: results.map((r) => ({
        id: r.entry.id,
        title: r.entry.title,
        content: r.entry.content.substring(0, 500),
        source: r.entry.source,
        tags: r.entry.tags,
        score: r.score,
        matchType: r.matchType,
        createdAt: r.entry.createdAt,
      })),
      count: results.length,
    };
  });

  fastify.get("/chat/knowledge/recent", async (request) => {
    const { limit, source } = request.query as {
      limit?: string;
      source?: string;
    };
    const entries = knowledgeStore.getRecent({
      limit: limit ? parseInt(limit) : 10,
      source: source as any,
    });
    return {
      success: true,
      entries: entries.map((e) => ({
        id: e.id,
        title: e.title,
        source: e.source,
        tags: e.tags,
        createdAt: e.createdAt,
        accessCount: e.accessCount,
      })),
      count: entries.length,
    };
  });

  fastify.get("/chat/knowledge/stats", async () => {
    return { success: true, stats: knowledgeStore.getStats() };
  });

  fastify.get("/chat/graph/summary", async () => {
    return { success: true, summary: knowledgeGraph.getGraphSummary() };
  });

  fastify.get("/chat/graph/nodes", async (request) => {
    const { type, status, search, limit } = request.query as {
      type?: string;
      status?: string;
      search?: string;
      limit?: string;
    };

    const nodes = knowledgeGraph.queryNodes({
      type: type as any,
      status: status as any,
      search,
      limit: limit ? parseInt(limit) : 20,
    });

    return {
      success: true,
      count: nodes.length,
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        status: n.status,
        tags: n.tags,
        createdAt: n.createdAt,
      })),
    };
  });

  fastify.get("/chat/graph/nodes/:nodeId", async (request, reply) => {
    const { nodeId } = request.params as { nodeId: string };
    const node = knowledgeGraph.getNode(nodeId);
    if (!node) {
      reply.code(404);
      return { error: "Node not found" };
    }

    const edges = knowledgeGraph.getEdgesForNode(nodeId);
    return { success: true, node, edges };
  });

  fastify.get("/chat/codebase/stats", async () => {
    return { success: true, stats: codebaseIndexer.getStats() };
  });

  fastify.get("/chat/codebase/search", async (request) => {
    const { query, language, filePath, limit } = request.query as {
      query?: string;
      language?: string;
      filePath?: string;
      limit?: string;
    };

    if (!query) return { success: true, results: [], count: 0 };

    const results = await codebaseIndexer.searchWithEmbeddings(query, {
      limit: limit ? parseInt(limit) : 10,
      language,
      filePath,
    });

    return {
      success: true,
      results: results.map((r) => ({
        filePath: r.filePath,
        startLine: r.startLine,
        endLine: r.endLine,
        language: r.language,
        content: r.content.substring(0, 300),
        score: Math.round(r.score * 100) / 100,
        matchType: r.matchType,
      })),
      count: results.length,
    };
  });
}
