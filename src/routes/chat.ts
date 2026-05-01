/**
 * Chat route for AI Assistant integration
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSystemPrompt, opencodeClient } from "../agent";
import { getTools } from "../agent/tool-registry";
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

      // Check if OpenCode API is configured
      if (!opencodeClient.isConfigured()) {
        reply.code(503);
        return {
          error: "OpenCode API not configured",
          message: "Please set OPENCODE_API_KEY environment variable",
        };
      }

      let sessionId = body.sessionId;
      let messages: ChatMessage[];

      // Use session if provided and still exists, otherwise create new one
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

      // Get tools for mode if enabled
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

      // Call AI provider
      let response = await opencodeClient.chat({
        messages,
        tools,
        temperature: 0.7,
        top_p: 0.95,
      });

      let allToolCalls: Array<{ id: string; name: string; params: any }> = [];
      let allToolResults: Record<string, unknown> = {};

      // Tool call loop: dispatch tools, feed results back, repeat until AI gives text
      let loopCount = 0;
      const maxLoops = 5;

      while (
        response.toolCalls &&
        response.toolCalls.length > 0 &&
        loopCount < maxLoops
      ) {
        loopCount++;

        // Add assistant response to session
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

        // Dispatch tool calls and collect results
        for (const tc of toolCalls) {
          const result = await dispatchToolCall(
            tc.name,
            tc.params,
            body.userId,
          );
          allToolResults[tc.id] = result;

          if (sessionId) {
            conversationManager.addMessage(sessionId, {
              role: "tool",
              content: JSON.stringify(result),
              tool_call_id: tc.id,
            });
          }
        }

        // Feed tool results back to AI for a text response
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
          tools,
          temperature: 0.7,
          top_p: 0.95,
        });
      }

      // Add final assistant response to session
      if (sessionId) {
        conversationManager.addMessage(sessionId, {
          role: "assistant",
          content: response.content,
        });
      }

      // Return response
      return {
        sessionId,
        content: response.content,
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
    try {
      const body = chatRequestSchema.parse(request.body);

      // Check if OpenCode API is configured
      if (!opencodeClient.isConfigured()) {
        reply.code(503);
        return {
          error: "OpenCode API not configured",
          message: "Please set OPENCODE_API_KEY environment variable",
        };
      }

      // Set headers for streaming
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");

      // Get system prompt for mode
      const systemPrompt = getSystemPrompt(body.mode);

      // Build messages array
      const messages = [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: body.message },
      ];

      // Stream response
      for await (const chunk of opencodeClient.chatStream({
        messages,
        temperature: 0.7,
        top_p: 0.95,
      })) {
        reply.raw.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
      }

      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return reply;
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to process chat stream",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
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
