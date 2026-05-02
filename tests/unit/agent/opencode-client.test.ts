/**
 * OpenCode API client unit tests
 */

import { describe, it, expect, beforeAll } from "vitest";
import { aiClient } from "../../../src/agent/opencode-client";
import type { ChatMessage, Tool } from "../../../src/agent/opencode-client";

describe("OpenCode Client", () => {
  beforeAll(() => {
    // Set test API key if not already set
    if (!process.env.OPENCODE_API_KEY) {
      console.warn("OPENCODE_API_KEY not set - skipping integration tests");
    }
  });

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
      if (!aiClient.isConfigured()) {
        console.warn("Skipping chat test - API not configured");
        return;
      }

      const messages: ChatMessage[] = [
        { role: "user", content: 'Say "OK" and nothing else' },
      ];

      const response = await aiClient.chat({ messages });

      expect(response).toBeDefined();
      expect(response.content).toBeTruthy();
      expect(response.done).toBe(true);
      expect(response.usage).toBeDefined();
      console.log("Response:", response.content);
    }, 30000);

    it("should handle productivity mode prompt", async () => {
      if (!aiClient.isConfigured()) {
        console.warn("Skipping productivity test - API not configured");
        return;
      }

      const messages: ChatMessage[] = [
        {
          role: "system",
          content:
            "You are a personal productivity assistant. Keep responses brief and actionable.",
        },
        {
          role: "user",
          content:
            "I have 3 meetings today and 5 Jira tickets assigned. What should I prioritize?",
        },
      ];

      const response = await aiClient.chat({ messages });

      expect(response.content).toBeTruthy();
      expect(response.content.length).toBeGreaterThan(0);
      console.log("Productivity advice:", response.content);
    }, 30000);

    it("should handle tool calling", async () => {
      if (!aiClient.isConfigured()) {
        console.warn("Skipping tool test - API not configured");
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

      const response = await aiClient.chat({ messages, tools });

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
