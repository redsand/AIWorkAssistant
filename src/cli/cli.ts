#!/usr/bin/env tsx
/**
 * AI Assistant CLI
 * Command-line interface for direct agent communication
 */

import { Command } from "commander";
import { loadEnv } from "../config/env";
import { OllamaLauncher } from "../integrations/ollama-launcher";
import type { LaunchOptions } from "../integrations/ollama-launcher";
import {
  ticketToTaskGenerator,
  TicketToTaskAgent,
  MissingCodingPromptError,
} from "../engineering/ticket-to-task";
import { ticketBridge } from "../integrations/ticket-bridge/ticket-bridge";
import { branchRunner } from "../integrations/ticket-bridge/branch-runner";
import type { AgentType } from "../integrations/ticket-bridge/branch-runner";
import axios from "axios";
import * as fs from "fs";

// Load environment variables
const env = loadEnv();
const API_BASE_URL = `http://localhost:${env.PORT}`;

function cliAuthHeaders(): Record<string, string> {
  const providerKeys: Record<string, string> = {
    opencode: env.OPENCODE_API_KEY,
    zai: env.ZAI_API_KEY,
    ollama: env.OLLAMA_API_KEY,
  };
  const token = providerKeys[env.AI_PROVIDER] || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

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

async function chatWithAgent(
  message: string,
  mode: "productivity" | "engineering" = "productivity",
): Promise<void> {
  try {
    console.log("Agent:", message);

    const response = await axios.post(`${API_BASE_URL}/chat`, {
      message,
      mode,
      userId: "cli-user",
      sessionId: currentSessionId || undefined,
      includeTools: true,
      includeMemory: true,
    });

    const data = response.data as ChatResponse;

    if (data.sessionId) {
      currentSessionId = data.sessionId;
      console.log(`Session: ${data.sessionId.substring(0, 8)}...`);
    }

    console.log("");
    console.log("Response:");
    console.log(data.content);

    if (data.toolCalls && data.toolCalls.length > 0) {
      console.log("");
      console.log("Tool Calls:");
      data.toolCalls.forEach((tool, index) => {
        console.log(`  ${index + 1}. ${tool.name}`);
        console.log(`     Params: ${JSON.stringify(tool.params, null, 2)}`);
      });
    }

    if (data.usage) {
      console.log("");
      console.log("Token Usage:", data.usage.totalTokens);
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const data = error.response?.data as any;

      if (status === 503) {
        console.error("Agent not available. Is the server running?");
        console.log("   Start the server with: npm run dev");
      } else if (data?.error) {
        console.error("Error:", data.error);
      } else {
        console.error("Request failed:", error.message);
      }
    } else {
      console.error("Error:", error);
    }
  }
}

async function streamChatWithAgent(
  message: string,
  mode: "productivity" | "engineering" = "productivity",
): Promise<void> {
  try {
    console.log("Agent:", message);
    console.log("Streaming response...");
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
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }

    console.log("");
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 503) {
        console.error("Agent not available. Is the server running?");
      } else {
        console.error("Request failed:", error.message);
      }
    } else {
      console.error("Error:", error);
    }
  }
}

async function getApprovals(): Promise<void> {
  try {
    const response = await axios.get(
      `${API_BASE_URL}/approvals?status=pending`,
    );
    const approvals = response.data.approvals || [];

    if (approvals.length === 0) {
      console.log("No pending approvals");
      return;
    }

    console.log(`Pending Approvals (${approvals.length}):`);
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
  } catch (error) {
    console.error("Failed to get approvals:", error);
  }
}

async function checkHealth(): Promise<void> {
  try {
    const response = await axios.get(`${API_BASE_URL}/health`);
    const health = response.data;

    console.log("System Health Check");
    console.log(`   Status: ${health.status}`);
    console.log(`   Version: ${health.version}`);
    console.log(`   Server: ${API_BASE_URL}`);

    if (health.provider) {
      console.log("");
      console.log(`AI Provider (${health.provider.active}):`);
      console.log(
        `   Configured: ${health.provider.configured ? "Yes" : "No"}`,
      );
      console.log(`   Valid: ${health.provider.valid ? "Yes" : "No"}`);
    }
  } catch {
    console.error("Agent not available");
    console.log("   Start the server with: npm run dev");
  }
}

async function planDay(date?: string): Promise<void> {
  const targetDate = date || new Date().toISOString().split("T")[0];
  await chatWithAgent(`Plan my day for ${targetDate}`, "productivity");
}

async function generateCtoDailyCommand(date?: string): Promise<void> {
  const targetDate = date || new Date().toISOString().split("T")[0];
  try {
    const response = await axios.get(
      `${API_BASE_URL}/api/cto/daily-command-center`,
      {
        params: {
          userId: "cli-user",
          date: targetDate,
        },
        headers: cliAuthHeaders(),
      },
    );
    console.log(response.data.markdown);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(
        "Failed to generate CTO daily command center:",
        error.response?.data?.error || error.message,
      );
    } else {
      console.error("Failed to generate CTO daily command center:", error);
    }
  }
}

async function generateEngineeringStrategy(idea: string): Promise<void> {
  await chatWithAgent(
    `I want to build: ${idea}\n\nPlease help me design this properly by starting with workflow analysis.`,
    "engineering",
  );
}

async function generateWorkflowBrief(idea: string): Promise<void> {
  await chatWithAgent(
    `Generate a workflow brief for: ${idea}\n\nFocus on:\n- Users and actors\n- Jobs-to-be-done\n- Current vs desired workflow\n- Friction points\n- Decisions the system must support\n- Automation opportunities`,
    "engineering",
  );
}

async function generateArchitecture(idea: string): Promise<void> {
  await chatWithAgent(
    `Generate an architecture proposal for: ${idea}\n\nRecommend:\n- Tech stack (with justification)\n- System boundaries\n- Data model\n- API design\n- Security considerations`,
    "engineering",
  );
}

async function generateImplementationPlan(idea: string): Promise<void> {
  await chatWithAgent(
    `Generate an implementation plan for: ${idea}\n\nInclude:\n- Milestones\n- First vertical slice\n- Jira ticket breakdown\n- Acceptance criteria\n- Testing strategy`,
    "engineering",
  );
}

async function generateTicketToTaskPrompt(
  issueNumber: string,
  options: {
    owner?: string;
    repo?: string;
    output?: string;
    agent?: TicketToTaskAgent;
    includeComments?: boolean;
    noComments?: boolean;
    includeRoadmap?: boolean;
    noRoadmap?: boolean;
    includeCodebase?: boolean;
    noCodebase?: boolean;
    maxCodebaseFiles?: string;
    autoBranch?: boolean;
    run?: string;
    dryRun?: boolean;
    workDir?: string;
    noComment?: boolean;
    postResults?: boolean;
    createWorkItem?: boolean;
    force?: boolean;
  },
): Promise<void> {
  const issue = Number(issueNumber);
  if (!Number.isInteger(issue) || issue <= 0) {
    console.error("Error: issue number must be a positive integer");
    process.exit(1);
  }

  try {
    const result = await ticketToTaskGenerator.generate({
      owner: options.owner || "",
      repo: options.repo || "",
      issueNumber: issue,
      agent: options.agent || "generic",
      includeComments: options.noComments ? false : (options.includeComments ?? true),
      includeRoadmap: options.noRoadmap ? false : (options.includeRoadmap ?? true),
      includeCodebase: options.noCodebase ? false : (options.includeCodebase ?? true),
      maxCodebaseFiles: options.maxCodebaseFiles ? Number(options.maxCodebaseFiles) : undefined,
      skipIfMissingPrompt: !options.force,
    });

    const agentRunner = resolveAgent(options as TicketToPromptOptions);
    const hasActions = options.autoBranch || agentRunner || options.dryRun;

    if (options.output) {
      fs.writeFileSync(options.output, result.body, "utf-8");
      console.log(`Wrote implementation prompt to ${options.output}`);
      if (!hasActions) return;
    }

    if (!hasActions) {
      console.log(result.body);
      return;
    }

    const sourceId = githubSourceIdFromMetadata(result.metadata.issueUrl, issue);

    if (options.dryRun) {
      const preview = branchRunner.dryRun({
        source: { type: "github", id: sourceId },
        prompt: result.body,
        title: result.title.replace(/^Implementation Task:\s*/i, ""),
        autoBranch: options.autoBranch ?? false,
        agent: agentRunner,
        workDir: options.workDir,
        postComment: !options.noComment,
        postResults: options.postResults ?? false,
        createWorkItem: options.createWorkItem ?? false,
      });
      for (const line of preview) {
        console.log(line);
      }
      return;
    }

    const runResult = await branchRunner.run({
      source: { type: "github", id: sourceId },
      prompt: result.body,
      title: result.title.replace(/^Implementation Task:\s*/i, ""),
      autoBranch: options.autoBranch ?? false,
      agent: agentRunner,
      workDir: options.workDir,
      postComment: !options.noComment,
      postResults: options.postResults ?? false,
      createWorkItem: options.createWorkItem ?? false,
      ticketUrl: result.metadata.issueUrl,
    });

    if (runResult.branchCreated) {
      console.log(`Created branch: ${runResult.branchName}`);
    }
    if (runResult.commentPosted) {
      console.log(`Posted comment to GitHub issue #${issue}`);
    }
    if (runResult.workItemId) {
      console.log(
        `Work Item: ${runResult.workItemCreated ? "Created" : "Updated"} (${runResult.workItemId})`,
      );
    }
    if (runResult.agentExitCode !== null) {
      process.exit(runResult.agentExitCode ?? 0);
    }
  } catch (error) {
    if (error instanceof MissingCodingPromptError) {
      console.log(`Skipped: Issue #${error.issueNumber} has label "missing-coding-prompt".`);
      console.log(`  Add a ## Coding Prompt section to the issue, then rerun.`);
      console.log(`  Use --force to generate anyway.`);
      process.exit(0);
    }
    console.error(
      "Failed to generate ticket-to-task prompt:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
}

function githubSourceIdFromMetadata(issueUrl: string, fallbackNumber: number): string {
  const match = issueUrl.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (match) return `${match[1]}/${match[2]}#${match[3]}`;
  const owner = env.GITHUB_DEFAULT_OWNER;
  const repo = env.GITHUB_DEFAULT_REPO;
  return owner && repo ? `${owner}/${repo}#${fallbackNumber}` : `unknown/unknown#${fallbackNumber}`;
}

interface TicketToPromptOptions {
  output?: string;
  outputDir?: string;
  milestone?: string;
  runCodex?: boolean;
  runOpencode?: boolean;
  run?: string;
  autoBranch?: boolean;
  dryRun?: boolean;
  workDir?: string;
  noComment?: boolean;
  postResults?: boolean;
  createWorkItem?: boolean;
  includeCodebase?: boolean;
  noCodebase?: boolean;
  maxFiles?: string;
}

async function runTicketToPrompt(
  sourceType: "github" | "jira" | "roadmap",
  sourceId: string,
  options: TicketToPromptOptions,
): Promise<void> {
  const ctx = {
    includeCodebaseIndex: options.noCodebase ? false : (options.includeCodebase ?? true),
    maxFiles: options.maxFiles ? Number(options.maxFiles) : 10,
  };

  if (sourceType === "roadmap" && options.outputDir) {
    try {
      const results = await ticketBridge.generateBatch(
        sourceId,
        options.milestone,
        options.outputDir,
        ctx,
      );
      console.log(`Generated ${results.length} prompt(s) in ${options.outputDir}:`);
      for (const r of results) {
        console.log(`  ${r.file} — ${r.title}`);
      }
    } catch (err) {
      console.error("Failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  const agent = resolveAgent(options);

  try {
    const generated = await ticketBridge.generatePrompt(
      { type: sourceType, id: sourceId },
      ctx,
    );

    if (options.output) {
      fs.writeFileSync(options.output, generated.prompt, "utf-8");
      console.log(`Wrote prompt to ${options.output}`);
      console.log(`  Files referenced: ${generated.filesReferenced.length}`);
      console.log(`  Tokens estimate:  ${generated.tokensEstimate}`);
      return;
    }

    if (!options.autoBranch && !agent && !options.dryRun) {
      process.stdout.write(generated.prompt);
      return;
    }

    if (options.dryRun) {
      const preview = branchRunner.dryRun({
        source: { type: sourceType, id: sourceId },
        prompt: generated.prompt,
        title: generated.title,
        autoBranch: options.autoBranch ?? false,
        agent,
        workDir: options.workDir,
        postComment: !options.noComment,
        postResults: options.postResults ?? false,
        createWorkItem: options.createWorkItem ?? false,
      });
      for (const line of preview) {
        console.log(line);
      }
      return;
    }

    const result = await branchRunner.run({
      source: { type: sourceType, id: sourceId },
      prompt: generated.prompt,
      title: generated.title,
      autoBranch: options.autoBranch ?? false,
      agent,
      workDir: options.workDir,
      postComment: !options.noComment,
      postResults: options.postResults ?? false,
      createWorkItem: options.createWorkItem ?? false,
    });

    if (result.branchCreated) {
      console.log(`Created branch: ${result.branchName}`);
    }
    if (result.commentPosted) {
      console.log(`Posted comment to ${sourceType} ${sourceId}`);
    }
    if (result.workItemId) {
      console.log(
        `Work Item: ${result.workItemCreated ? "Created" : "Updated"} (${result.workItemId})`,
      );
    }
    if (result.agentExitCode !== null) {
      process.exit(result.agentExitCode ?? 0);
    }
  } catch (err) {
    console.error("Failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

function resolveAgent(options: TicketToPromptOptions): AgentType | null {
  if (options.run) {
    const valid: AgentType[] = ["codex", "opencode", "claude"];
    if (valid.includes(options.run as AgentType)) return options.run as AgentType;
    console.error(`Unknown agent "${options.run}". Valid: codex, opencode, claude`);
    process.exit(1);
  }
  if (options.runCodex) return "codex";
  if (options.runOpencode) return "opencode";
  return null;
}

// ==================== Helper: launch provider ====================

const launcher = new OllamaLauncher();

async function launchProvider(options: LaunchOptions): Promise<void> {
  try {
    const child = await launcher.launchStream(options);
    const code = await launcher.waitForExit(child);
    process.exit(code ?? 0);
  } catch (err: any) {
    console.error("Launch failed:", err.message);
    process.exit(1);
  }
}

function requirePrompt(opts: { prompt?: string }): string {
  if (!opts.prompt) {
    console.error("Error: --prompt is required");
    process.exit(1);
  }
  return opts.prompt;
}

// ==================== Build CLI program ====================

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

program
  .command("ticket-to-task <issueNumber>")
  .description("Generate a coding-agent implementation prompt from a GitHub issue")
  .option("--owner <owner>", "GitHub repository owner")
  .option("--repo <repo>", "GitHub repository name")
  .option("--output <file>", "Write the generated prompt to a file")
  .option("--agent <agent>", "Target agent: codex, cursor, claude, generic", "generic")
  .option("--include-comments", "Include GitHub issue comments")
  .option("--no-comments", "Do not include GitHub issue comments")
  .option("--include-roadmap", "Include roadmap context")
  .option("--no-roadmap", "Do not include roadmap context")
  .option("--include-codebase", "Include codebase context")
  .option("--no-codebase", "Do not include codebase context")
  .option("--max-codebase-files <number>", "Maximum relevant files to include", "10")
  .option("--auto-branch", "Create a feature branch (ticket-{number}-{slug}) before running")
  .option("--run <agent>", "Run agent after generating prompt (codex|opencode|claude)")
  .option("--dry-run", "Preview what would happen without executing")
  .option("--work-dir <path>", "Working directory for git and agent (default: cwd)")
  .option("--no-comment", "Skip posting a comment back to the ticket source")
  .option("--post-results", "Post structured results summary back to the ticket source after agent run")
  .option("--create-work-item", "Create or update a Work Item tracking this handoff (idempotent)")
  .option(
    "--force",
    "Generate even if the issue has the missing-coding-prompt label",
  )
  .action(async (issueNumber, options) => {
    await generateTicketToTaskPrompt(issueNumber, options);
  });

const ttpCmd = program
  .command("ticket-to-prompt")
  .description(
    "Generate a coding-agent implementation prompt from a ticket (GitHub issue, Jira, or roadmap item)",
  );

const BRANCH_RUN_OPTIONS = (cmd: ReturnType<typeof ttpCmd.command>) =>
  cmd
    .option("--auto-branch", "Create a feature branch (ticket-{id}-{slug}) before running")
    .option("--run <agent>", "Run agent after generating (codex|opencode|claude)")
    .option("--dry-run", "Preview what would happen without executing")
    .option("--work-dir <path>", "Working directory for git and agent (default: cwd)")
    .option("--no-comment", "Skip posting a comment back to the ticket source")
    .option("--post-results", "Post structured results summary back to the ticket source after agent run")
    .option("--create-work-item", "Create or update a Work Item tracking this handoff (idempotent)");

BRANCH_RUN_OPTIONS(
  ttpCmd
    .command("github <repoAndIssue>")
    .description(
      'Generate prompt from a GitHub issue. Format: "owner/repo#25" or "owner/repo 25"',
    )
    .option("--output <file>", "Write prompt to a file")
    .option("--run-codex", "Pipe prompt directly to Codex CLI (deprecated: use --run codex)")
    .option("--run-opencode", "Pipe prompt directly to OpenCode CLI (deprecated: use --run opencode)")
    .option("--include-codebase", "Include codebase file context")
    .option("--no-codebase", "Skip codebase file context")
    .option("--max-files <number>", "Max codebase files to include", "10"),
).action(async (repoAndIssue: string, opts) => {
  await runTicketToPrompt("github", repoAndIssue, opts);
});

BRANCH_RUN_OPTIONS(
  ttpCmd
    .command("jira <key>")
    .description("Generate prompt from a Jira issue (e.g., PROJ-123)")
    .option("--output <file>", "Write prompt to a file")
    .option("--run-codex", "Pipe prompt directly to Codex CLI (deprecated: use --run codex)")
    .option("--run-opencode", "Pipe prompt directly to OpenCode CLI (deprecated: use --run opencode)")
    .option("--include-codebase", "Include codebase file context")
    .option("--no-codebase", "Skip codebase file context")
    .option("--max-files <number>", "Max codebase files to include", "10"),
).action(async (key: string, opts) => {
  await runTicketToPrompt("jira", key, opts);
});

BRANCH_RUN_OPTIONS(
  ttpCmd
    .command("roadmap <id>")
    .description(
      "Generate prompt from a roadmap item UUID, or batch-generate for a milestone",
    )
    .option("--milestone <name>", "Filter by milestone name (for batch mode)")
    .option("--output <file>", "Write prompt to a file (single item)")
    .option("--output-dir <dir>", "Write prompts to a directory (batch mode)")
    .option("--run-codex", "Pipe prompt directly to Codex CLI (deprecated: use --run codex)")
    .option("--run-opencode", "Pipe prompt directly to OpenCode CLI (deprecated: use --run opencode)")
    .option("--include-codebase", "Include codebase file context")
    .option("--no-codebase", "Skip codebase file context")
    .option("--max-files <number>", "Max codebase files to include", "10"),
).action(async (id: string, opts) => {
  await runTicketToPrompt("roadmap", id, opts);
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

const ctoCmd = program.command("cto").description("CTO operating brief commands");

ctoCmd
  .command("daily [date]")
  .description("Generate the CTO Daily Command Center")
  .action(async (date) => {
    await generateCtoDailyCommand(date);
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

// ==================== Session subcommands ====================

const sessionCmd = program.command("session").description("Manage conversation sessions");

sessionCmd
  .command("start")
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
      console.log("Session started:", currentSessionId);
    } catch (error) {
      console.error("Failed to start session:", error);
    }
  });

sessionCmd
  .command("end")
  .description("End current conversation session")
  .action(async () => {
    if (!currentSessionId) {
      console.log("No active session");
      return;
    }

    try {
      await axios.post(`${API_BASE_URL}/chat/sessions/${currentSessionId}/end`);
      console.log("Session ended and saved to long-term memory");
      currentSessionId = null;
    } catch (error) {
      console.error("Failed to end session:", error);
    }
  });

sessionCmd
  .command("info")
  .description("Show current session information")
  .action(async () => {
    if (!currentSessionId) {
      console.log("No active session");
      return;
    }

    try {
      const response = await axios.get(
        `${API_BASE_URL}/chat/sessions/${currentSessionId}`,
      );
      const session = response.data.session;

      console.log("Session Information:");
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
      console.error("Failed to get session info:", error);
    }
  });

// ==================== Memory subcommands ====================

const memoryCmd = program.command("memory").description("Long-term memory operations");

memoryCmd
  .command("search <query>")
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
        console.log("No memories found");
        return;
      }

      console.log(`Found ${results.length} memories:`);
      results.forEach((memory: any, index: number) => {
        console.log(`\n${index + 1}. ${memory.title}`);
        console.log(
          `   ${new Date(memory.startDate).toLocaleDateString()} - ${new Date(memory.endDate).toLocaleDateString()}`,
        );
        console.log(`   Topics: ${memory.keyTopics.join(", ")}`);
        console.log(`   Summary: ${memory.summary.substring(0, 150)}...`);
      });
    } catch (error) {
      console.error("Failed to search memory:", error);
    }
  });

memoryCmd
  .command("stats")
  .description("Show memory statistics")
  .action(async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/chat/memory/stats`);
      const stats = response.data.stats;

      console.log("Memory Statistics:");
      console.log(`   Active Sessions: ${stats.activeSessions}`);
      console.log(`   Total Summaries: ${stats.totalSummaries}`);
      console.log(`   Users: ${stats.usersCount}`);
    } catch (error) {
      console.error("Failed to get memory stats:", error);
    }
  });

// ==================== Ollama Launcher Commands ====================

const ollamaCmd = program.command("ollama").description("Ollama launcher commands");

ollamaCmd
  .command("status")
  .description("Check Ollama server and launcher status")
  .action(async () => {
    console.log("Checking Ollama launcher status...\n");

    const [ollamaCheck, codexInstalled, claudeInstalled, opencodeInstalled] =
      await Promise.all([
        launcher.checkOllama(),
        launcher.checkCliInstalled("codex"),
        launcher.checkCliInstalled("claude"),
        launcher.checkCliInstalled("opencode"),
      ]);

    if (ollamaCheck.reachable) {
      console.log("  Ollama: reachable at", process.env.OLLAMA_API_URL || "http://localhost:11434");
      const models = ollamaCheck.models.map((m) => m.name);
      if (models.length > 0) {
        console.log(`  Models: ${models.join(", ")}`);
      } else {
        console.log("  Models: (none found)");
      }
    } else {
      console.log("  Ollama: NOT reachable -", ollamaCheck.error);
      console.log("    Start with: ollama serve");
    }

    console.log("");
    console.log("  Provider CLIs:");
    console.log(`    codex:    ${codexInstalled ? "installed" : "NOT installed"}`);
    console.log(`    claude:   ${claudeInstalled ? "installed" : "NOT installed"}`);
    console.log(`    opencode: ${opencodeInstalled ? "installed" : "NOT installed"}`);

    console.log("");
    console.log("  Default model:", process.env.OLLAMA_LAUNCHER_DEFAULT_MODEL || process.env.OLLAMA_MODEL || "glm-5.1:cloud");
  });

const launchCmd = ollamaCmd.command("launch").description("Launch an AI coding tool via Ollama");

launchCmd
  .command("codex")
  .description("Launch Codex CLI routed through Ollama")
  .option("--model <model>", "Ollama model to use", process.env.OLLAMA_LAUNCHER_DEFAULT_MODEL || process.env.OLLAMA_MODEL || "glm-5.1:cloud")
  .option("--prompt <prompt>", "Prompt to send")
  .option("--approval-mode <mode>", "Codex approval mode", "full-auto")
  .option("--ollama-url <url>", "Ollama base URL", process.env.OLLAMA_API_URL || "http://localhost:11434")
  .option("--cwd <path>", "Working directory")
  .action(async (opts) => {
    requirePrompt(opts);
    const options: LaunchOptions = {
      provider: "codex",
      prompt: opts.prompt,
      model: opts.model,
      ollamaUrl: opts.ollamaUrl,
      codexApprovalMode: opts.approvalMode,
      cwd: opts.cwd,
    };
    console.log(`Launching Codex (model: ${opts.model}, approval: ${opts.approvalMode})...\n`);
    await launchProvider(options);
  });

launchCmd
  .command("claude")
  .description("Launch Claude CLI with --dangerously-skip-permissions")
  .option("--model <model>", "Claude model to use")
  .option("--prompt <prompt>", "Prompt to send")
  .option("--cwd <path>", "Working directory")
  .action(async (opts) => {
    requirePrompt(opts);
    const options: LaunchOptions = {
      provider: "claude",
      prompt: opts.prompt,
      model: opts.model,
      cwd: opts.cwd,
    };
    console.log("Launching Claude (with --dangerously-skip-permissions)...\n");
    await launchProvider(options);
  });

launchCmd
  .command("opencode")
  .description("Launch OpenCode CLI")
  .option("--prompt <prompt>", "Prompt to send")
  .option("--ollama-url <url>", "Ollama base URL (routes through Ollama if set)")
  .option("--cwd <path>", "Working directory")
  .action(async (opts) => {
    requirePrompt(opts);
    const options: LaunchOptions = {
      provider: "opencode",
      prompt: opts.prompt,
      ollamaUrl: opts.ollamaUrl,
      cwd: opts.cwd,
    };
    console.log("Launching OpenCode...\n");
    await launchProvider(options);
  });

// ==================== Direct Provider Shortcuts ====================

program
  .command("codex")
  .description("Launch Codex CLI via Ollama (shortcut for 'ollama launch codex')")
  .option("--model <model>", "Ollama model to use", process.env.OLLAMA_LAUNCHER_DEFAULT_MODEL || process.env.OLLAMA_MODEL || "glm-5.1:cloud")
  .option("--prompt <prompt>", "Prompt to send")
  .option("--approval-mode <mode>", "Codex approval mode", "full-auto")
  .option("--ollama-url <url>", "Ollama base URL", process.env.OLLAMA_API_URL || "http://localhost:11434")
  .option("--cwd <path>", "Working directory")
  .action(async (opts) => {
    requirePrompt(opts);
    const options: LaunchOptions = {
      provider: "codex",
      prompt: opts.prompt,
      model: opts.model,
      ollamaUrl: opts.ollamaUrl,
      codexApprovalMode: opts.approvalMode,
      cwd: opts.cwd,
    };
    console.log(`Launching Codex (model: ${opts.model}, approval: ${opts.approvalMode})...\n`);
    await launchProvider(options);
  });

program
  .command("claude")
  .description("Launch Claude CLI with --dangerously-skip-permissions (shortcut for 'ollama launch claude')")
  .option("--model <model>", "Claude model to use")
  .option("--prompt <prompt>", "Prompt to send")
  .option("--cwd <path>", "Working directory")
  .action(async (opts) => {
    requirePrompt(opts);
    const options: LaunchOptions = {
      provider: "claude",
      prompt: opts.prompt,
      model: opts.model,
      cwd: opts.cwd,
    };
    console.log("Launching Claude (with --dangerously-skip-permissions)...\n");
    await launchProvider(options);
  });

program
  .command("opencode")
  .description("Launch OpenCode CLI (shortcut for 'ollama launch opencode')")
  .option("--prompt <prompt>", "Prompt to send")
  .option("--ollama-url <url>", "Ollama base URL (routes through Ollama if set)")
  .option("--cwd <path>", "Working directory")
  .action(async (opts) => {
    requirePrompt(opts);
    const options: LaunchOptions = {
      provider: "opencode",
      prompt: opts.prompt,
      ollamaUrl: opts.ollamaUrl,
      cwd: opts.cwd,
    };
    console.log("Launching OpenCode...\n");
    await launchProvider(options);
  });

// Parse and execute
program.parseAsync(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
