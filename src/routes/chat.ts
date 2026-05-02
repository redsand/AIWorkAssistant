/**
 * Chat route for AI Assistant integration
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSystemPrompt, opencodeClient } from "../agent";
import { getTools, getToolsByCategory } from "../agent/tool-registry";
import { dispatchToolCall } from "../agent/tool-dispatcher";
import { AGENT_MODES } from "../config/constants";
import type { Tool, ChatMessage } from "../agent/opencode-client";
import { conversationManager } from "../memory/conversation-manager";

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
});

const createSessionSchema = z.object({
  userId: z.string(),
  mode: z.enum([AGENT_MODES.PRODUCTIVITY, AGENT_MODES.ENGINEERING]),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  context: z.object({}).optional(),
});

export async function chatRoutes(fastify: FastifyInstance) {
  /**
   * Main chat endpoint
   */
  fastify.post("/chat", async (request, reply) => {
    try {
      const body = chatRequestSchema.parse(request.body);

      if (!opencodeClient.isConfigured()) {
        reply.code(503);
        return {
          error: "OpenCode API not configured",
          message: "Please set OPENCODE_API_KEY environment variable",
        };
      }

      let sessionId = body.sessionId;
      let messages: ChatMessage[];

      const existingSession = sessionId
        ? conversationManager.getSession(sessionId)
        : null;

      if (existingSession) {
        conversationManager.addMessage(sessionId!, {
          role: "user",
          content: body.message,
        });

        messages = conversationManager.getSessionMessages(
          sessionId!,
          body.includeMemory,
        );
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

        messages = conversationManager.getSessionMessages(
          sessionId,
          body.includeMemory,
        );
      }

      let tools: Tool[] | undefined = undefined;
      if (body.includeTools) {
        const modeTools = getTools(body.mode);
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

      let response = await opencodeClient.chat({
        messages: messages,
        tools,
        temperature: 0.7,
        top_p: 0.95,
      });

      let allToolCalls: Array<{ id: string; name: string; params: any }> = [];
      let allToolResults: Record<string, unknown> = {};
      let expandedTools = [...(tools || [])];

      let loopCount = 0;
      const maxLoops = 10;

      while (
        response.toolCalls &&
        response.toolCalls.length > 0 &&
        loopCount < maxLoops
      ) {
        loopCount++;

        if (sessionId) {
          conversationManager.addMessage(sessionId, {
            role: "assistant",
            content: response.content,
            toolCalls: response.toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              params: JSON.parse(tc.function.arguments),
            })),
          });
        }

        const toolCalls = response.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          params: JSON.parse(tc.function.arguments),
        }));

        allToolCalls = allToolCalls.concat(toolCalls);

        for (const tc of toolCalls) {
          const dispatchParams = { ...tc.params, _mode: body.mode };
          const result = await dispatchToolCall(
            tc.name,
            dispatchParams,
            body.userId,
          );
          allToolResults[tc.id] = result;

          if (tc.name === "discover_tools" && result.success) {
            const category = tc.params.category as string | undefined;
            if (category) {
              const categoryTools = getToolsByCategory(body.mode, category);
              const categoryToolDefs = categoryTools.map((tool) => {
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
              content: JSON.stringify(result),
              tool_call_id: tc.id,
            });
          }
        }

        const followupMessages: ChatMessage[] = [
          ...messages,
          {
            role: "assistant",
            content: response.content,
            tool_calls: response.toolCalls,
          },
          ...toolCalls.map((tc) => ({
            role: "tool" as const,
            content: JSON.stringify(allToolResults[tc.id]),
            tool_call_id: tc.id,
          })),
        ];

        response = await opencodeClient.chat({
          messages: followupMessages,
          tools: expandedTools.length > 0 ? expandedTools : undefined,
          temperature: 0.7,
          top_p: 0.95,
        });
      }

      if (sessionId) {
        conversationManager.addMessage(sessionId, {
          role: "assistant",
          content: response.content,
        });
      }

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
      reply.code(500);
      return {
        error: "Failed to process chat request",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  /**
   * Stream chat endpoint
   */
  fastify.post("/chat/stream", async (request, reply) => {
    const body = chatRequestSchema.parse(request.body);

    if (!opencodeClient.isConfigured()) {
      reply.code(503);
      return {
        error: "AI provider not configured",
        message: "Please set the appropriate API key environment variable",
      };
    }

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");

    const sendEvent = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const systemPrompt = getSystemPrompt(body.mode);
      let sessionId = body.sessionId;

      const existingSession = sessionId
        ? conversationManager.getSession(sessionId)
        : null;

      let messages: ChatMessage[];

      if (existingSession) {
        messages = conversationManager.getSessionMessages(sessionId!);
        messages.push({ role: "user", content: body.message });
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

      let tools: Tool[] | undefined = undefined;
      if (body.includeTools) {
        const modeTools = getTools(body.mode);
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

      let response = await opencodeClient.chat({
        messages: messages,
        tools,
        temperature: 0.7,
        top_p: 0.95,
      });

      let allToolResults: Record<string, unknown> = {};
      let expandedTools = [...(tools || [])];
      let loopCount = 0;
      const maxLoops = 10;

      while (
        response.toolCalls &&
        response.toolCalls.length > 0 &&
        loopCount < maxLoops
      ) {
        loopCount++;

        // Send intermediate content (commentary like "Let me look up IR-55...")
        if (response.content && response.content.trim()) {
          sendEvent("content", { content: response.content });
        }
        if (response.thinking) {
          sendEvent("thinking", { thinking: response.thinking });
        }

        if (sessionId) {
          conversationManager.addMessage(sessionId, {
            role: "assistant",
            content: response.content,
            toolCalls: response.toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              params: JSON.parse(tc.function.arguments),
            })),
          });
        }

        const toolCalls = response.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          params: JSON.parse(tc.function.arguments),
        }));

        for (const tc of toolCalls) {
          sendEvent("tool_start", {
            id: tc.id,
            name: tc.name,
            params: tc.params,
          });

          const dispatchParams = { ...tc.params, _mode: body.mode };
          const result = await dispatchToolCall(
            tc.name,
            dispatchParams,
            body.userId,
          );
          allToolResults[tc.id] = result;

          sendEvent("tool_result", { id: tc.id, result });

          if (tc.name === "discover_tools" && result.success) {
            const category = tc.params.category as string | undefined;
            if (category) {
              const categoryTools = getToolsByCategory(body.mode, category);
              const categoryToolDefs = categoryTools.map((tool) => {
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
              content: JSON.stringify(result),
              tool_call_id: tc.id,
            });
          }
        }

        const followupMessages: ChatMessage[] = [
          ...messages,
          {
            role: "assistant",
            content: response.content,
            tool_calls: response.toolCalls,
          },
          ...toolCalls.map((tc) => ({
            role: "tool" as const,
            content: JSON.stringify(allToolResults[tc.id]),
            tool_call_id: tc.id,
          })),
        ];

        response = await opencodeClient.chat({
          messages: followupMessages,
          tools: expandedTools.length > 0 ? expandedTools : undefined,
          temperature: 0.7,
          top_p: 0.95,
        });
      }

      if (sessionId) {
        conversationManager.addMessage(sessionId, {
          role: "assistant",
          content: response.content,
        });
      }

      if (response.thinking) {
        sendEvent("thinking", { thinking: response.thinking });
      }
      sendEvent("content", { content: response.content });
      sendEvent("done", { usage: response.usage, model: response.model });
    } catch (error) {
      fastify.log.error(error);
      sendEvent("error", {
        error: "Failed to process stream request",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }

    reply.raw.end();
    return reply;
  });

  /**
   * Health check for OpenCode API
   */
  fastify.get("/chat/health", async (_request, _reply) => {
    const isConfigured = opencodeClient.isConfigured();
    const isValid = isConfigured
      ? await opencodeClient.validateConfig()
      : false;

    return {
      opencode: {
        configured: isConfigured,
        valid: isValid,
        baseUrl:
          process.env.OPENCODE_API_URL || "https://opencode.ai/zen/go/v1",
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
      await conversationManager.endSession(sessionId);
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
}
