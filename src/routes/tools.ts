import { FastifyInstance } from "fastify";
import {
  getAllToolsForMode,
  getPlatformForTool,
  Tool,
} from "../agent/tool-registry";
import { AGENT_MODES } from "../config/constants";

export interface AgentCapability {
  id: string;
  name: string;
  description: string;
  type: "chat_mode" | "specialized_api";
  mode?: string;
  endpoint?: string;
  features: string[];
  toolCategories: string[];
}

const AGENT_CAPABILITIES: AgentCapability[] = [
  {
    id: "productivity",
    name: "Productivity",
    type: "chat_mode",
    mode: "productivity",
    description:
      "Personal productivity copilot. Manages calendar, tasks, Jira issues, GitLab MRs, GitHub PRs, todos, knowledge base, roadmaps, and memory. The default chat mode for daily work.",
    features: [
      "Daily and weekly planning",
      "Calendar event management and focus blocks",
      "Jira issue tracking and transitions",
      "GitLab merge request tracking",
      "GitHub PR and issue management",
      "Todo list management",
      "Knowledge base storage and search",
      "Roadmap tracking",
      "Web search and page fetching",
      "Memory and entity tracking",
      "Graph-based knowledge relationships",
      "Work item tracking across platforms",
    ],
    toolCategories: [
      "calendar",
      "jira",
      "gitlab",
      "github",
      "todo",
      "knowledge",
      "roadmap",
      "web",
      "memory",
      "graph",
      "work_items",
      "productivity",
    ],
  },
  {
    id: "engineering",
    name: "Engineering",
    type: "chat_mode",
    mode: "engineering",
    description:
      "Full engineering suite. Inherits all productivity tools and adds architecture proposals, workflow briefs, scaffolding plans, Jira ticket generation, codebase search, LSP integration, local file access, and code execution via Codex.",
    features: [
      "Architecture proposal generation",
      "Workflow brief generation",
      "Scaffolding plan creation",
      "Jira ticket generation from project ideas",
      "Codebase search and statistics",
      "Language server protocol (definitions, references, diagnostics)",
      "Local file system access",
      "Codex code execution",
      "MCP tool integration",
      "All Productivity mode tools",
    ],
    toolCategories: [
      "engineering",
      "codebase",
      "lsp",
      "local",
      "codex",
      "mcp",
      "calendar",
      "jira",
      "gitlab",
      "github",
    ],
  },
  {
    id: "cto_daily_command",
    name: "CTO Daily Command",
    type: "specialized_api",
    endpoint: "/api/cto/daily-command-center",
    description:
      "Cross-functional daily brief aggregating calendar, Jira, GitLab, GitHub, roadmap, work items, and Jitbit into a single command-center view. Surfaces key decisions, blockers, and follow-ups.",
    features: [
      "Aggregated cross-platform daily brief",
      "Calendar and meeting context",
      "Active Jira issues and blockers",
      "GitLab and GitHub pipeline/PR status",
      "Roadmap progress tracking",
      "Work item tracking",
      "Jitbit support ticket summary",
      "CTO-suggested work item creation",
    ],
    toolCategories: ["cto", "calendar", "jira", "gitlab", "github", "jitbit", "roadmap"],
  },
  {
    id: "personal_os",
    name: "Personal OS",
    type: "specialized_api",
    endpoint: "/api/personal-os",
    description:
      "Personal operating system layer. Generates situational awareness briefs, surfaces open loops and incomplete items, detects behavioural patterns, and suggests focus priorities.",
    features: [
      "Situational awareness brief generation",
      "Open loop detection and tracking",
      "Behavioural pattern analysis",
      "Focus area suggestions",
      "Work item creation from brief",
    ],
    toolCategories: ["personal_os", "calendar", "jira", "gitlab", "github", "work_items"],
  },
  {
    id: "code_review",
    name: "Code Review",
    type: "specialized_api",
    endpoint: "/api/code-review",
    description:
      "Automated code review assistant for GitHub pull requests, GitLab merge requests, and release readiness analysis.",
    features: [
      "GitHub PR review with inline comments",
      "GitLab MR review and analysis",
      "Release readiness report generation",
      "Security and quality analysis",
      "Work item creation from review findings",
    ],
    toolCategories: ["code_review", "github", "gitlab"],
  },
  {
    id: "product_chief_of_staff",
    name: "Product Chief of Staff",
    type: "specialized_api",
    endpoint: "/api/product",
    description:
      "Product strategy and roadmap intelligence. Generates workflow briefs, roadmap proposals, customer signal analysis, shipped vs planned tracking, and weekly product updates.",
    features: [
      "Product workflow brief generation",
      "Roadmap proposal from theme and evidence",
      "Roadmap drift detection",
      "Customer signal aggregation from Jitbit",
      "Shipped vs planned comparison",
      "Weekly product update generation",
      "Work item creation from product findings",
    ],
    toolCategories: ["product", "roadmap", "jitbit", "jira", "github"],
  },
  {
    id: "customer_intelligence",
    name: "Customer Intelligence",
    type: "specialized_api",
    endpoint: "/api/product/customer-signals",
    description:
      "Aggregates and analyses customer signals from support tickets (Jitbit) and product feedback channels. Surfaces trending issues, top customers, and feature requests.",
    features: [
      "Customer snapshot and account summary",
      "Support ticket trend analysis",
      "Feature request aggregation",
      "Jitbit company and ticket search",
      "Customer segmentation by activity",
      "Signal-to-roadmap correlation",
    ],
    toolCategories: ["jitbit", "product", "knowledge"],
  },
  {
    id: "detection_engineering",
    name: "Detection Engineering & IR",
    type: "specialized_api",
    endpoint: "/api (via HAWK IR tools)",
    description:
      "HAWK Incident Response integration for security operations. Supports case management, log search, dashboard queries, host quarantine/unquarantine, identity and asset investigation.",
    features: [
      "HAWK IR case creation, assignment, and lifecycle",
      "Case escalation and de-escalation",
      "Log search and histogram analysis",
      "Dashboard and saved search execution",
      "Host quarantine and unquarantine",
      "Asset and identity investigation",
      "Weekly and monthly IR reports",
      "Hybrid tool execution on HAWK nodes",
      "Active node inventory",
    ],
    toolCategories: ["hawk_ir"],
  },
  {
    id: "weekly_digest",
    name: "Weekly Digest",
    type: "specialized_api",
    endpoint: "/api (via productivity/hawk_ir tools)",
    description:
      "Automated weekly digest generation combining productivity planning with HAWK IR weekly report. Provides a consolidated view of the week's work, security incidents, and upcoming priorities.",
    features: [
      "Productivity weekly plan generation",
      "HAWK IR weekly security report",
      "Cross-platform work summary",
      "Upcoming week prioritisation",
      "Calendar and meeting planning",
    ],
    toolCategories: ["productivity", "hawk_ir", "calendar", "jira"],
  },
  {
    id: "agent_runner",
    name: "Agent Runner",
    type: "specialized_api",
    endpoint: "/api/agent-runs",
    description:
      "Long-running background agent execution framework. Supports spawning sub-agents for autonomous multi-step tasks with real-time status tracking.",
    features: [
      "Background agent task execution",
      "Real-time run status and step tracking",
      "Stale run detection and cleanup",
      "Agent run history and statistics",
      "Sub-agent spawning from chat",
    ],
    toolCategories: ["agent", "workflow"],
  },
];

function getToolsForAllModes(): Tool[] {
  const seen = new Set<string>();
  const tools: Tool[] = [];
  for (const mode of Object.values(AGENT_MODES)) {
    for (const tool of getAllToolsForMode(mode)) {
      if (!seen.has(tool.name)) {
        seen.add(tool.name);
        tools.push(tool);
      }
    }
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

function getCategory(toolName: string): string {
  const dot = toolName.indexOf(".");
  return dot > 0 ? toolName.substring(0, dot) : "other";
}

function getModesForTool(toolName: string): string[] {
  return Object.values(AGENT_MODES).filter((mode) =>
    getAllToolsForMode(mode).some((t) => t.name === toolName),
  );
}

function serializeTool(tool: Tool) {
  return {
    name: tool.name,
    description: tool.description,
    category: getCategory(tool.name),
    platform: getPlatformForTool(tool),
    actionType: tool.actionType,
    riskLevel: tool.riskLevel,
    params: Object.entries(tool.params || {}).map(([name, meta]) => ({
      name,
      type: meta.type,
      description: meta.description,
      required: meta.required ?? false,
    })),
    modes: getModesForTool(tool.name),
  };
}

export async function toolsRoutes(server: FastifyInstance) {
  // GET /api/tools — all tools from all modes, deduped and serialized
  server.get("/tools", async () => {
    const tools = getToolsForAllModes();
    return {
      total: tools.length,
      tools: tools.map(serializeTool),
    };
  });

  // GET /api/tools/categories — tools grouped by category
  server.get("/tools/categories", async () => {
    const tools = getToolsForAllModes();
    const categories: Record<string, ReturnType<typeof serializeTool>[]> = {};
    for (const tool of tools) {
      const cat = getCategory(tool.name);
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(serializeTool(tool));
    }
    return {
      totalCategories: Object.keys(categories).length,
      totalTools: tools.length,
      categories,
    };
  });

  // GET /api/agents — all documented agent capabilities
  server.get("/agents", async () => {
    const allTools = getToolsForAllModes();
    return AGENT_CAPABILITIES.map((agent) => {
      const toolCount = agent.mode
        ? getAllToolsForMode(agent.mode).length
        : allTools.filter((t) =>
            agent.toolCategories.some((cat) => getCategory(t.name) === cat),
          ).length;
      return { ...agent, toolCount };
    });
  });
}
