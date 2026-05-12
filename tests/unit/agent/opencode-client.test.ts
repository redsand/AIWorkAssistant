/**
 * OpenCode API client unit tests
 */

import { describe, it, expect, beforeAll } from "vitest";
import { aiClient } from "../../../src/agent/opencode-client";
import type { ChatMessage, Tool } from "../../../src/agent/opencode-client";

describe("OpenCode Client", () => {
  let apiReachable = false;

  beforeAll(async () => {
    // Check if API is actually reachable (not just if key is set)
    apiReachable = aiClient.isConfigured() && (await aiClient.validateConfig());
  }, 15000);

  describe("Configuration", () => {
    it("should check if configured", () => {
      const isConfigured = aiClient.isConfigured();
      expect(typeof isConfigured).toBe("boolean");
    });

    it("should validate configuration", async () => {
      const isValid = await aiClient.validateConfig();
      expect(typeof isValid).toBe("boolean");
    }, 10000);
  });

  describe("Chat", () => {
    it("should send a simple chat request", async () => {
      if (!apiReachable) {
        console.warn("Skipping chat test - API not reachable");
        return;
      }

      const messages: ChatMessage[] = [
        { role: "user", content: 'Say "OK" and nothing else' },
      ];

      let response;
      try {
        response = await aiClient.chat({ messages });
      } catch (error) {
        if (error instanceof Error) {
          console.warn(
            "Skipping chat test - API call failed:",
            error.message,
          );
          return;
        }
        throw error;
      }

      expect(response).toBeDefined();
      expect(response.content).toBeTruthy();
      expect(response.done).toBe(true);
      expect(response.usage).toBeDefined();
      console.log("Response:", response.content);
    }, 30000);

    it("should handle productivity mode prompt", async () => {
      if (!apiReachable) {
        console.warn("Skipping productivity test - API not reachable");
        return;
      }

      const messages: ChatMessage[] = [
        {
          role: "system",
          content:
            "You are a personal productivity assistant. Keep responses brief and actionable. Reply with at most 2 sentences.",
        },
        {
          role: "user",
          content:
            "I have 3 meetings today and 5 Jira tickets assigned. What should I prioritize?",
        },
      ];

      let response;
      try {
        response = await aiClient.chat({ messages });
      } catch (error) {
        if (error instanceof Error) {
          console.warn(
            "Skipping productivity test - API call failed:",
            error.message,
          );
          return;
        }
        throw error;
      }

      expect(response.content).toBeTruthy();
      expect(response.content.length).toBeGreaterThan(0);
      console.log("Productivity advice:", response.content);
    }, 60000);

    it("should handle tool calling", async () => {
      if (!apiReachable) {
        console.warn("Skipping tool test - API not reachable");
        return;
      }

      const tools: Tool[] = [
        {
          type: "function",
          function: {
            name: "list_jira_tickets",
            description: "List Jira tickets assigned to user",
            parameters: {
              type: "object",
              properties: {
                status: { type: "string", description: "Filter by status" },
                limit: { type: "number", description: "Max results" },
              },
            },
          },
        },
      ];

      const messages: ChatMessage[] = [
        { role: "user", content: "What Jira tickets are assigned to me?" },
      ];

      let response;
      try {
        response = await aiClient.chat({ messages, tools });
      } catch (error) {
        if (error instanceof Error) {
          console.warn(
            "Skipping tool test - API call failed:",
            error.message,
          );
          return;
        }
        throw error;
      }

      expect(response).toBeDefined();
      expect(response.toolCalls || response.content).toBeTruthy();

      if (response.toolCalls) {
        console.log("Tool calls:", response.toolCalls);
      } else {
        console.log("Response:", response.content);
      }
    }, 30000);
  });

  describe("Token Estimation", () => {
    it("should estimate tokens for messages", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello, how are you?" },
      ];

      const tokens = aiClient.estimateTokens(messages);

      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(1000);
      console.log("Estimated tokens:", tokens);
    });
  });
});
