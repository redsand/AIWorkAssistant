import { config } from "dotenv";
import { z } from "zod";

// Load environment variables from .env file (don't override existing env vars)
config({ override: false });

const envSchema = z.object({
  // Server
  PORT: z.string().transform(Number).default("3050"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  // Authentication
  AUTH_USERNAME: z.string().default("admin"),
  AUTH_PASSWORD: z.string().default(""),
  AUTH_SESSION_SECRET: z.string().default("change-me-in-production"),

  // OpenCode API
  OPENCODE_API_URL: z.string().url().default("https://api.opencode.com/v1"),
  OPENCODE_API_KEY: z.string().default(""),

  // AI Provider Selection
  AI_PROVIDER: z.enum(["opencode", "zai", "ollama"]).default("opencode"),

  // Z.ai (GLM models)
  ZAI_API_URL: z.string().url().default("https://api.z.ai/api/coding/paas/v4"),
  ZAI_API_KEY: z.string().default(""),
  ZAI_MODEL: z.string().default("GLM-5"),
  ZAI_TEMPERATURE: z.string().transform(Number).default("0.95"),
  ZAI_TOP_P: z.string().transform(Number).default("0.9"),
  ZAI_MAX_CONTEXT_TOKENS: z.coerce.number().default(64000),

  // Ollama (local and cloud models)
  OLLAMA_API_URL: z.string().url().default("http://localhost:11434"),
  OLLAMA_API_KEY: z.string().default(""),
  OLLAMA_MODEL: z.string().default("llama3"),
  OLLAMA_TEMPERATURE: z.string().transform(Number).default("0.7"),
  OLLAMA_MAX_CONTEXT_TOKENS: z.coerce.number().default(128000),

  // Per-model context limit overrides (JSON map of model name -> max tokens)
  // Example: {"glm-5.1:cloud": 202752, "llama3:70b": 8192}
  OLLAMA_MODEL_CONTEXT_LIMITS: z.string().default('{"glm-5.1:cloud": 202752}'),

  // Microsoft 365
  MICROSOFT_TENANT_ID: z.string().default(""),
  MICROSOFT_CLIENT_ID: z.string().default(""),
  MICROSOFT_CLIENT_SECRET: z.string().default(""),
  MICROSOFT_REDIRECT_URI: z
    .string()
    .url()
    .default("http://localhost:3000/auth/microsoft/callback"),

  // Jira
  JIRA_BASE_URL: z.string().url().default("https://your-domain.atlassian.net"),
  JIRA_EMAIL: z.string().default(""),
  JIRA_API_TOKEN: z.string().default(""),
  JIRA_PROJECT_KEYS: z
    .string()
    .default("")
    .transform((s) => (s ? s.split(",").map((k) => k.trim()) : [])),

  // GitLab
  GITLAB_BASE_URL: z.string().url().default("https://gitlab.com"),
  GITLAB_TOKEN: z.string().default(""),
  GITLAB_WEBHOOK_SECRET: z.string().default(""),
  GITLAB_DEFAULT_PROJECT: z.string().default(""),

  // GitHub
  GITHUB_TOKEN: z.string().default(""),
  GITHUB_DEFAULT_OWNER: z.string().default(""),
  GITHUB_DEFAULT_REPO: z.string().default(""),
  GITHUB_BASE_URL: z.string().url().default("https://api.github.com"),

  // Jitbit
  JITBIT_BASE_URL: z.string().default(""),
  JITBIT_API_TOKEN: z.string().default(""),
  JITBIT_ENABLED: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  JITBIT_DEFAULT_CATEGORY_ID: z
    .string()
    .default("")
    .transform((s) => (s ? Number(s) : undefined)),

  // Policy
  POLICY_APPROVAL_MODE: z
    .enum(["strict", "balanced", "permissive"])
    .default("strict"),
  POLICY_JIRA_AUTO_CLOSE: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  POLICY_CALENDAR_ALLOW_DELETE: z
    .string()
    .transform((s) => s === "true")
    .default("false"),

  // Database
  DATABASE_URL: z.string().default("sqlite:./data/app.db"),

  // Audit
  AUDIT_LOG_FILE: z.string().default("./logs/audit.log"),
  AUDIT_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Feature flags
  ENABLE_CALENDAR_WRITE: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  ENABLE_JIRA_TRANSITIONS: z
    .string()
    .transform((s) => s === "true")
    .default("true"),
  ENABLE_GITLAB_WEBHOOKS: z
    .string()
    .transform((s) => s === "true")
    .default("true"),

  // Discord
  DISCORD_BOT_TOKEN: z.string().default(""),
  DISCORD_CLIENT_ID: z.string().default(""),
  DISCORD_GUILD_ID: z.string().default(""),
  DISCORD_ALLOWED_USER_ID: z.string().default(""),

  // Signal
  SIGNAL_PHONE_NUMBER: z.string().default(""),
  SIGNAL_DATA_PATH: z.string().default("~/.config/Signal"),
  SIGNAL_WEBHOOK_PORT: z.string().transform(Number).default("3001"),

  // Calendar tunnel
  TUNNEL_ENABLED: z
    .string()
    .transform((s) => s === "true")
    .default("true"),
  TUNNEL_PROVIDER: z.enum(["localtunnel", "cloudflare"]).default("localtunnel"),
  TUNNEL_SUBDOMAIN: z.string().default(""),
  TUNNEL_DOMAIN: z.string().default(""),
  TUNNEL_URL: z.string().default(""),

  // Google Calendar
  GOOGLE_CALENDAR_API_KEY: z.string().default(""),
  GOOGLE_CALENDAR_CLIENT_ID: z.string().default(""),
  GOOGLE_CALENDAR_CLIENT_SECRET: z.string().default(""),
  GOOGLE_CALENDAR_REDIRECT_URI: z
    .string()
    .url()
    .default("http://localhost:3050/auth/google/callback"),
  GOOGLE_CALENDAR_CALENDAR_ID: z.string().default("primary"),

  // Web Search (Tavily - primary, Google Custom Search - fallback)
  TAVILY_API_KEY: z.string().default(""),
  GOOGLE_SEARCH_API_KEY: z.string().default(""),
  GOOGLE_SEARCH_ENGINE_ID: z.string().default(""),

  // Codex CLI
  CODEX_CLI_PATH: z.string().default("codex"),
  CODEX_API_KEY: z.string().default(""),
  CODEX_MODEL: z.string().default("o4-mini"),

  // Ollama Launcher (meta-launcher for AI coding tools)
  OLLAMA_LAUNCHER_DEFAULT_MODEL: z.string().default("glm-5.1:cloud"),
  OLLAMA_LAUNCHER_CLAUDE_CLI_PATH: z.string().default("claude"),
  OLLAMA_LAUNCHER_CODEX_CLI_PATH: z.string().default("codex"),
  OLLAMA_LAUNCHER_OPENCODE_CLI_PATH: z.string().default("opencode"),

  // Claude CLI
  ANTHROPIC_API_KEY: z.string().default(""),

  // Context assembly mode: "rag" (current behavior) or "engine" (budget-aware context engine)
  CONTEXT_MODE: z.enum(["rag", "engine"]).default("rag"),

  // RAG / Codebase Indexing
  RAG_INDEX_ON_STARTUP: z
    .string()
    .transform((s) => s === "true")
    .default("true"),
  RAG_EMBEDDING_MODEL: z.string().default(""),
  RAG_MAX_FILE_SIZE_KB: z.coerce.number().default(256),
  RAG_CHUNK_SIZE: z.coerce.number().default(500),
  RAG_CHUNK_OVERLAP: z.coerce.number().default(50),

  // Nightly calendar planning
  NIGHTLY_PLAN_ENABLED: z
    .string()
    .transform((s) => s === "true")
    .default("true"),
  NIGHTLY_PLAN_WEEKS: z.coerce.number().default(2),
  NIGHTLY_PLAN_USER: z.string().default("user"),

  // HAWK Incident Response (ir.hawk.io)
  HAWK_IR_BASE_URL: z.string().default(""),
  HAWK_IR_ACCESS_TOKEN: z.string().default(""),
  HAWK_IR_SECRET_KEY: z.string().default(""),
  HAWK_IR_ENABLED: z
    .string()
    .transform((s) => s === "true")
    .default("false"),

  // Web Push (VAPID)
  VAPID_PUBLIC_KEY: z.string().default(""),
  VAPID_PRIVATE_KEY: z.string().default(""),
  VAPID_ADMIN_EMAIL: z
    .string()
    .default("mailto:admin@ai-work-assistant.example"),
  VAPID_SUBJECT: z.string().default(""),

  // Escalation email (SMTP)
  ESCALATION_SMTP_HOST: z.string().default(""),
  ESCALATION_SMTP_PORT: z.coerce.number().default(587),
  ESCALATION_SMTP_SECURE: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  ESCALATION_SMTP_USER: z.string().default(""),
  ESCALATION_SMTP_PASS: z.string().default(""),
  ESCALATION_EMAIL_FROM: z.string().default("alerts@ai-work-assistant.example"),
  ESCALATION_EMAIL_TO: z.string().default(""),
  ESCALATION_EMAIL_TO_L3: z.string().default(""),

  // Push notification polling
  PUSH_POLL_INTERVAL_MIN: z.coerce.number().default(5),
  PUSH_ESCALATION_L2_MINUTES: z.coerce.number().default(5),
  PUSH_ESCALATION_L3_MINUTES: z.coerce.number().default(15),

  // Tool loop limit (max iterations before forcing a final response)
  MAX_TOOL_LOOPS: z.coerce.number().default(75),

  // Autonomous loop — shared (aicoder + reviewer)
  AIWORKASSISTANT_URL: z.string().url().default("http://localhost:3050"),
  AIWORKASSISTANT_API_KEY: z.string().default(""),

  // Autonomous loop — aicoder agent
  AICODER_AGENT: z.enum(["codex", "opencode", "claude"]).default("claude"),
  AICODER_OWNER: z.string().default(""),
  AICODER_REPO: z.string().default(""),
  AICODER_LABEL: z.string().default("ready-for-agent"),
  AICODER_PRIORITY: z.enum(["label", "auto"]).default("label"),
  AICODER_SOURCE: z.enum(["github", "gitlab", "jira", "jitbit", "auto"]).default("auto"),
  AICODER_LOOKUP: z.enum(["memory", "llm"]).default("memory"),
  AICODER_POLL_MS: z.coerce.number().default(60000),
  AICODER_MAX_CYCLES: z.coerce.number().default(0),
  AICODER_WORKSPACE: z.string().default(""),
  AICODER_OLLAMA: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  AICODER_MODEL: z.string().default(""),
  FIN_SIGNAL: z.string().default("FIN"),

  // Reviewer agent (src/reviewer.ts)
  REVIEW_REPOS: z.string().default(""),
  REVIEW_POLL_INTERVAL_MS: z.coerce.number().default(30000),
  REVIEW_MAX_CYCLES: z.coerce.number().default(5),
  REVIEW_SOURCE: z.enum(["github", "gitlab"]).default("github"),
  SECURITY_AGENT_CMD: z.string().default("review-agent --category security"),
  QA_AGENT_CMD: z.string().default("review-agent --category qa"),
  QUALITY_AGENT_CMD: z.string().default("review-agent --category quality"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error("❌ Invalid environment configuration:");
    parsed.error.errors.forEach((err) => {
      console.error(`  - ${err.path.join(".")}: ${err.message}`);
    });
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();
