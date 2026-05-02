#!/usr/bin/env tsx
/**
 * AI Assistant CLI
 * Command-line interface for direct agent communication
 */

import { Command } from "commander";
import { loadEnv } from "../config/env";
import axios from "axios";

// Load environment variables
const env = loadEnv();
const API_BASE_URL = `http://localhost:${env.PORT}`;

interface ChatResponse {
  sessionId?: string;
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    params: Record<string, unknown>;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// Store active session for CLI
let currentSessionId: string | null = null;

/**
 * Chat with the agent
 */
async function chatWithAgent(
  message: string,
  mode: "productivity" | "engineering" = "productivity",
): Promise<void> {
  try {
    console.log("🤖 Agent:", message);

    const response = await axios.post(`${API_BASE_URL}/chat`, {
      message,
      mode,
      userId: "cli-user",
      sessionId: currentSessionId || undefined,
      includeTools: true,
      includeMemory: true,
    });

    const data = response.data as ChatResponse;

    // Store session ID for continued conversation
    if (data.sessionId) {
      currentSessionId = data.sessionId;
      console.log(`💾 Session: ${data.sessionId.substring(0, 8)}...`);
    }

    console.log("");
    console.log("📋 Response:");
    console.log(data.content);

    if (data.toolCalls && data.toolCalls.length > 0) {
      console.log("");
      console.log("🔧 Tool Calls:");
      data.toolCalls.forEach((tool, index) => {
        console.log(`  ${index + 1}. ${tool.name}`);
        console.log(`     Params: ${JSON.stringify(tool.params, null, 2)}`);
      });
    }

    if (data.usage) {
      console.log("");
      console.log("📊 Token Usage:", data.usage.totalTokens);
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const data = error.response?.data as any;

      if (status === 503) {
        console.error("❌ Agent not available. Is the server running?");
        console.log("   Start the server with: npm run dev");
      } else if (data?.error) {
        console.error("❌ Error:", data.error);
      } else {
        console.error("❌ Request failed:", error.message);
      }
    } else {
      console.error("❌ Error:", error);
    }
  }
}

/**
 * Stream chat with the agent
 */
async function streamChatWithAgent(
  message: string,
  mode: "productivity" | "engineering" = "productivity",
): Promise<void> {
  try {
    console.log("🤖 Agent:", message);
    console.log("📡 Streaming response...");
    console.log("");

    const response = await axios.post(
      `${API_BASE_URL}/chat/stream`,
      {
        message,
        mode,
        userId: "cli-user",
      },
      {
        responseType: "stream",
      },
    );

    let fullContent = "";

    for await (const chunk of response.data) {
      if (chunk.toString().startsWith("data: ")) {
        const data = chunk.toString().slice(6);

        if (data === "[DONE]") {
          break;
        }

        try {
          const parsed = JSON.parse(data);
          if (parsed.content) {
            process.stdout.write(parsed.content);
            fullContent += parsed.content;
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
    }

    console.log("");
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 503) {
        console.error("❌ Agent not available. Is the server running?");
      } else {
        console.error("❌ Request failed:", error.message);
      }
    } else {
      console.error("❌ Error:", error);
    }
  }
}

/**
 * Get pending approvals
 */
async function getApprovals(): Promise<void> {
  try {
    const response = await axios.get(
      `${API_BASE_URL}/approvals?status=pending`,
    );
    const approvals = response.data.approvals || [];

    if (approvals.length === 0) {
      console.log("✅ No pending approvals");
      return;
    }

    console.log(`📋 Pending Approvals (${approvals.length}):`);
    approvals.forEach((approval: any, index: number) => {
      console.log(`  ${index + 1}. ${approval.action.description}`);
      console.log(`     Risk: ${approval.decision.riskLevel}`);
      console.log(`     Action: ${approval.action.type}`);
      console.log(
        `     Requested: ${new Date(approval.requestedAt).toLocaleString()}`,
      );
      console.log(`     ID: ${approval.id}`);
      console.log("");
    });
    console.log(
      `💡 Approve: curl -X POST ${API_BASE_URL}/approvals/${approvals[0].id}/approve -H "Content-Type: application/json" -d '{"userId":"cli-user"}'`,
    );
    console.log(
      `   Reject: curl -X POST ${API_BASE_URL}/approvals/${approvals[0].id}/reject -H "Content-Type: application/json" -d '{"userId":"cli-user"}'`,
    );
  } catch (error) {
    console.error("❌ Failed to get approvals:", error);
  }
}

/**
 * Check system health
 */
async function checkHealth(): Promise<void> {
  try {
    const response = await axios.get(`${API_BASE_URL}/health`);
    const health = response.data;

    console.log("✅ System Health Check");
    console.log(`   Status: ${health.status}`);
    console.log(`   Version: ${health.version}`);
    console.log(`   Server: ${API_BASE_URL}`);

    if (health.provider) {
      console.log("");
      console.log(`🤖 AI Provider (${health.provider.active}):`);
      console.log(
        `   Configured: ${health.provider.configured ? "Yes" : "No"}`,
      );
      console.log(`   Valid: ${health.provider.valid ? "Yes" : "No"}`);
    }
  } catch (error) {
    console.error("❌ Agent not available");
    console.log("   Start the server with: npm run dev");
  }
}

/**
 * Plan the day
 */
async function planDay(date?: string): Promise<void> {
  const targetDate = date || new Date().toISOString().split("T")[0];
  await chatWithAgent(`Plan my day for ${targetDate}`, "productivity");
}

/**
 * Generate engineering strategy
 */
async function generateEngineeringStrategy(idea: string): Promise<void> {
  await chatWithAgent(
    `I want to build: ${idea}

Please help me design this properly by starting with workflow analysis.`,
    "engineering",
  );
}

/**
 * Generate workflow brief
 */
async function generateWorkflowBrief(idea: string): Promise<void> {
  await chatWithAgent(
    `Generate a workflow brief for: ${idea}

Focus on:
- Users and actors
- Jobs-to-be-done
- Current vs desired workflow
- Friction points
- Decisions the system must support
- Automation opportunities`,
    "engineering",
  );
}

/**
 * Generate architecture proposal
 */
async function generateArchitecture(idea: string): Promise<void> {
  await chatWithAgent(
    `Generate an architecture proposal for: ${idea}

Recommend:
- Tech stack (with justification)
- System boundaries
- Data model
- API design
- Security considerations`,
    "engineering",
  );
}

/**
 * Generate implementation plan
 */
async function generateImplementationPlan(idea: string): Promise<void> {
  await chatWithAgent(
    `Generate an implementation plan for: ${idea}

Include:
- Milestones
- First vertical slice
- Jira ticket breakdown
- Acceptance criteria
- Testing strategy`,
    "engineering",
  );
}

/**
 * Create main CLI program
 */
const program = new Command();

program
  .name("ai-assistant")
  .description(
    "AI Assistant CLI - Personal productivity and engineering copilot",
  )
  .version("0.1.0");

// Chat command
program
  .command("chat <message>")
  .description("Chat with the agent")
  .option(
    "-m, --mode <mode>",
    "Productivity or engineering mode",
    "productivity",
  )
  .option("-s, --stream", "Stream the response in real-time")
  .action(async (options, message) => {
    if (options.stream) {
      await streamChatWithAgent(message, options.mode as any);
    } else {
      await chatWithAgent(message, options.mode as any);
    }
  });

// Plan command
program
  .command("plan [date]")
  .description("Plan your day")
  .action(async (_options, date) => {
    await planDay(date);
  });

// Engineering commands
program
  .command("strategy <idea>")
  .description("Generate engineering strategy for an idea")
  .action(async (_options, idea) => {
    await generateEngineeringStrategy(idea);
  });

program
  .command("workflow <idea>")
  .description("Generate workflow brief for an idea")
  .action(async (_options, idea) => {
    await generateWorkflowBrief(idea);
  });

program
  .command("architecture <idea>")
  .description("Generate architecture proposal")
  .action(async (_options, idea) => {
    await generateArchitecture(idea);
  });

program
  .command("implementation <idea>")
  .description("Generate implementation plan")
  .action(async (_options, idea) => {
    await generateImplementationPlan(idea);
  });

// Management commands
program
  .command("approvals")
  .description("Show pending approvals")
  .action(async () => {
    await getApprovals();
  });

program
  .command("health")
  .description("Check agent health")
  .action(async () => {
    await checkHealth();
  });

// Productivity shortcuts
program
  .command("today")
  .description('Alias for "plan today"')
  .action(async () => {
    await planDay();
  });

program
  .command("focus <duration>")
  .description('Create a focus block (e.g., "2h")')
  .action(async (_options, duration) => {
    await chatWithAgent(
      `Create a ${duration} focus block for deep work`,
      "productivity",
    );
  });

program
  .command("break <duration>")
  .description('Take a break (e.g., "15min")')
  .action(async (_options, duration) => {
    await chatWithAgent(`Schedule a ${duration} break`, "productivity");
  });

// Session management commands
program
  .command("session start")
  .description("Start a new conversation session")
  .option(
    "-m, --mode <mode>",
    "Productivity or engineering mode",
    "productivity",
  )
  .action(async (options) => {
    try {
      const response = await axios.post(`${API_BASE_URL}/chat/sessions`, {
        userId: "cli-user",
        mode: options.mode,
        title: `CLI Session ${new Date().toLocaleString()}`,
      });

      currentSessionId = response.data.sessionId;
      console.log("✅ Session started:", currentSessionId);
      console.log("💾 Use this session ID for continued conversations");
    } catch (error) {
      console.error("❌ Failed to start session:", error);
    }
  });

program
  .command("session end")
  .description("End current conversation session")
  .action(async () => {
    if (!currentSessionId) {
      console.log("ℹ️ No active session");
      return;
    }

    try {
      await axios.post(`${API_BASE_URL}/chat/sessions/${currentSessionId}/end`);
      console.log("✅ Session ended and saved to long-term memory");
      currentSessionId = null;
    } catch (error) {
      console.error("❌ Failed to end session:", error);
    }
  });

program
  .command("session info")
  .description("Show current session information")
  .action(async () => {
    if (!currentSessionId) {
      console.log("ℹ️ No active session");
      return;
    }

    try {
      const response = await axios.get(
        `${API_BASE_URL}/chat/sessions/${currentSessionId}`,
      );
      const session = response.data.session;

      console.log("📋 Session Information:");
      console.log(`   ID: ${session.id}`);
      console.log(`   Mode: ${session.mode}`);
      console.log(`   Messages: ${session.messageCount}`);
      console.log(
        `   Created: ${new Date(session.createdAt).toLocaleString()}`,
      );
      console.log(
        `   Updated: ${new Date(session.updatedAt).toLocaleString()}`,
      );
    } catch (error) {
      console.error("❌ Failed to get session info:", error);
    }
  });

// Memory management commands
program
  .command("memory search <query>")
  .description("Search long-term memory")
  .option("-l, --limit <number>", "Number of results", "10")
  .action(async (options, query) => {
    try {
      const response = await axios.get(`${API_BASE_URL}/chat/memory/search`, {
        params: {
          userId: "cli-user",
          query,
          limit: options.limit,
        },
      });

      const results = response.data.results;

      if (results.length === 0) {
        console.log("ℹ️ No memories found");
        return;
      }

      console.log(`🔍 Found ${results.length} memories:`);
      results.forEach((memory: any, index: number) => {
        console.log(`\n${index + 1}. ${memory.title}`);
        console.log(
          `   ${new Date(memory.startDate).toLocaleDateString()} - ${new Date(memory.endDate).toLocaleDateString()}`,
        );
        console.log(`   Topics: ${memory.keyTopics.join(", ")}`);
        console.log(`   Summary: ${memory.summary.substring(0, 150)}...`);
      });
    } catch (error) {
      console.error("❌ Failed to search memory:", error);
    }
  });

program
  .command("memory stats")
  .description("Show memory statistics")
  .action(async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/chat/memory/stats`);
      const stats = response.data.stats;

      console.log("📊 Memory Statistics:");
      console.log(`   Active Sessions: ${stats.activeSessions}`);
      console.log(`   Total Summaries: ${stats.totalSummaries}`);
      console.log(`   Users: ${stats.usersCount}`);
    } catch (error) {
      console.error("❌ Failed to get memory stats:", error);
    }
  });

// Parse and execute
program.parseAsync(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
