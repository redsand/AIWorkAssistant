import { config } from "dotenv";
import fs from "fs";
import path from "path";
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
  OPENCODE_API_URL: z.string().url().default("https://opencode.ai/zen/go/v1"),
  OPENCODE_API_KEY: z.string().default(""),
  OPENCODE_MODEL: z.string().default(""),
  OPENCODE_MAX_CONTEXT_TOKENS: z.coerce.number().default(128000),
  // Per-model context limit overrides for OpenCode models (JSON map of model name -> max tokens)
  // Example: {"glm-5.1": 200000, "kimi-k2.6": 262144}
  OPENCODE_MODEL_CONTEXT_LIMITS: z.string().default('{"glm-5.1": 200000, "kimi-k2.6": 262144}'),

  // AI Provider Selection
  AI_PROVIDER: z.enum(["opencode", "zai", "ollama", "openai"]).default("opencode"),

  // Global AI concurrency limit (applies to all providers)
  AI_MAX_CONCURRENT: z.coerce.number().default(3),
  AI_QUEUE_TIMEOUT_MS: z.coerce.number().default(120000),

  // Total wallclock time a provider will keep waiting on HTTP 429 before
  // giving up. 429 is rate-limiting (not failure), so the providers retry
  // indefinitely up to this budget instead of surfacing a terminal error.
  // Per-attempt sleep is capped separately (see provider code: 300s).
  AI_RATE_LIMIT_MAX_WAIT_MS: z.coerce.number().default(900000),

  // OpenAI
  OPENAI_API_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default("gpt-4o"),
  OPENAI_MAX_CONTEXT_TOKENS: z.coerce.number().default(128000),

  // Z.ai (GLM models)
  ZAI_API_URL: z.string().url().default("https://api.z.ai/api/coding/paas/v4"),
  ZAI_API_KEY: z.string().default(""),
  ZAI_MODEL: z.string().default("GLM-5"),
  ZAI_TEMPERATURE: z.string().transform(Number).default("0.95"),
  ZAI_TOP_P: z.string().transform(Number).default("0.9"),
  ZAI_MAX_CONTEXT_TOKENS: z.coerce.number().default(200000),
  // Known token budget for ZAI account (set to your plan's total tokens; 0 = unknown)
  ZAI_TOKEN_BUDGET: z.coerce.number().default(0),

  // Ollama (local and cloud models)
  OLLAMA_API_URL: z.string().url().default("http://localhost:11434"),
  OLLAMA_API_KEY: z.string().default(""),
  OLLAMA_MODEL: z.string().default("llama3"),
  OLLAMA_TEMPERATURE: z.string().transform(Number).default("0.7"),
  OLLAMA_MAX_CONTEXT_TOKENS: z.coerce.number().default(200000),

  // Per-model context limit overrides (JSON map of model name -> max tokens)
  // Example: {"glm-5.1:cloud": 202752, "llama3:70b": 8192}
  // kimi-k2.6:cloud supports 200k+ context
  OLLAMA_MODEL_CONTEXT_LIMITS: z.string().default('{"glm-5.1:cloud": 202752, "kimi-k2.6:cloud": 200000}'),

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

  // Agent Memory (MEMORY.md / USER.md)
  AGENT_MEMORY_PATH: z.string().default("data/memories"),

  // Agent Soul (SOUL.md)
  SOUL_PATH: z.string().default(""),
  DEFAULT_SOUL: z.string().default(""),

  // Agent Skills (SKILL.md)
  SKILLS_PATH: z.string().default(""),
  // Community skill hub registry — raw base URL of the GitHub repo holding
  // index.json and skills/<category>/<name>/SKILL.md.
  SKILLS_HUB_URL: z
    .string()
    .default(
      "https://raw.githubusercontent.com/redsand/aiworkassistant-skills/main",
    ),
  // Gate for pushing skills to the shared community registry. Off by default so
  // an agent cannot publish to the public repo without an explicit opt-in.
  SKILLS_HUB_PUBLISH_ENABLED: z
    .string()
    .default("false")
    .transform((s) => s === "true"),
  // Timeout (ms) for hub HTTP fetches so a slow/malicious server cannot hang.
  SKILLS_HUB_TIMEOUT_MS: z.coerce.number().default(15000),

  // Agent Profiles
  DEFAULT_PROFILE: z.string().default("default"),
  PROFILES_PATH: z.string().default("data/profiles"),

  // Profile isolation — root for all profile-scoped state and the active profile.
  // resolvePath() composes these into HERMES_HOME/profiles/{ACTIVE_PROFILE}/<relative>.
  HERMES_HOME: z.string().default("data"),
  ACTIVE_PROFILE: z.string().default("default"),

  // Audit
  AUDIT_LOG_FILE: z.string().default("./logs/audit.log"),
  AUDIT_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  ERROR_LOG_FILE: z.string().default("./logs/errors.jsonl"),

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

  // Messaging Gateway
  GATEWAY_ENABLED: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  GATEWAY_DATA_PATH: z.string().default("data/gateway"),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  SLACK_BOT_TOKEN: z.string().default(""),
  SLACK_APP_TOKEN: z.string().default(""),

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
  CODEX_MODEL: z.string().default("gpt-5.5"),

  // Ollama Launcher (meta-launcher for AI coding tools)
  OLLAMA_LAUNCHER_DEFAULT_MODEL: z.string().default("glm-5.1:cloud"),
  OLLAMA_LAUNCHER_CLAUDE_CLI_PATH: z.string().default("claude"),
  OLLAMA_LAUNCHER_CODEX_CLI_PATH: z.string().default("codex"),
  OLLAMA_LAUNCHER_OPENCODE_CLI_PATH: z.string().default("opencode"),

  // Claude CLI
  ANTHROPIC_API_KEY: z.string().default(""),

  // Context assembly mode: "rag" (current behavior) or "engine" (budget-aware context engine)
  CONTEXT_MODE: z.enum(["rag", "engine"]).default("rag"),
  // V2 context budget: explicit slots for every section, fractions sum to 1.0,
  // unknown sections are capped instead of Infinity. Default false until validated.
  CONTEXT_PACKET_V2_BUDGET: z
    .string()
    .transform((s) => s === "true")
    .default("false"),

  // RAG / Codebase Indexing
  RAG_INDEX_ON_STARTUP: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  // Master safeguard: when false, RAG/ClaimKit DO NOT retrieve or ingest
  // anything derived from local files on disk in this folder. Specifically:
  //   - codebaseIndexer.search() is skipped during chat retrieval
  //   - KnowledgeEntry rows with source="file_read" are filtered out of
  //     knowledge retrieval results
  //   - ingestSingleKnowledgeEntry() refuses file_read entries so the
  //     content never reaches ClaimKit's claim store
  //   - ingestKnowledgeStore() at startup filters out file_read entries
  // Use case: running this assistant in its own source folder, where the
  // user does NOT want their own code or local docs (hermes references,
  // architecture notes, etc.) to be part of RAG/CK context. Only data
  // received through chat tool calls (Jira issues, calendar events, web
  // searches, etc.) becomes retrieval material. Default false for that
  // safety; set to true when running against a project folder you DO
  // want indexed.
  RAG_INCLUDE_LOCAL_SOURCES: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  RAG_EMBEDDING_MODEL: z.string().default(""),
  EMBEDDING_PROVIDER: z.enum(["auto","opencode","zai","ollama","openai"]).default("auto"),
  EMBEDDING_MODEL: z.string().default("nomic-embed-text"),
  EMBEDDING_OLLAMA_FALLBACK_MODEL: z.string().default("nomic-embed-text"),
  EMBEDDING_ALLOW_PROVIDER_SWITCH: z.coerce.boolean().default(false),
  RAG_MAX_FILE_SIZE_KB: z.coerce.number().default(256),
  RAG_CHUNK_SIZE: z.coerce.number().default(500),
  RAG_CHUNK_OVERLAP: z.coerce.number().default(50),

  // ClaimKit (RAG replacement)
  CLAIMKIT_ENABLED: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  CLAIMKIT_LLM_PROVIDER: z
    .enum(["memory", "comparison", "ollama"])
    .default("comparison"),
  CLAIMKIT_REDIS_URL: z.string().default(""),
  CLAIMKIT_REDIS_PREFIX: z.string().default("aiworkassistant"),
  // If true, a dimension mismatch triggers a background flush of stale Redis
  // keys under the model-specific prefix. Uses SCAN + UNLINK in batches to
  // avoid blocking the server.
  CLAIMKIT_REPAIR_ON_DIMENSION_MISMATCH: z
    .string()
    .transform((s) => s === "true")
    .default("true"),
  CLAIMKIT_TOP_K: z.coerce.number().default(10),
  CLAIMKIT_MIN_SCORE: z.coerce.number().default(0.0),
  CLAIMKIT_MAX_EVIDENCE_ITEMS: z.coerce.number().default(20),
  CLAIMKIT_QUERY_SEED_LIMIT: z.coerce.number().default(5),
  CLAIMKIT_QUERY_TIMEOUT_MS: z.coerce.number().default(120000),
  CLAIMKIT_AWAIT_SEED: z.string().transform((s) => s === "true").default("false"),
  // Hard cap on the time the query path will wait for seed ingestion when
  // CLAIMKIT_AWAIT_SEED=true. Without this, a slow LLM-backed extractor on
  // CLAIMKIT_QUERY_SEED_LIMIT documents can take tens of minutes per
  // query before the outer query timeout fires. 12s is enough for a fast
  // provider on a small seed; slower providers should set CLAIMKIT_AWAIT_SEED=false
  // and let seeding run in the background. Set to 0 to disable the cap.
  CLAIMKIT_SEED_TIMEOUT_MS: z.coerce.number().default(12_000),
  CLAIMKIT_DISABLE_PLANNER_LLM: z.string().transform((s) => s === "true").default("false"),
  CLAIMKIT_DISABLE_VERIFIER_LLM: z.string().transform((s) => s === "true").default("false"),
  CLAIMKIT_DISABLE_CONTRADICTION_LLM: z.string().transform((s) => s === "true").default("false"),
  CLAIMKIT_INIT_TIMEOUT_MS: z.coerce.number().default(5000),
  CLAIMKIT_LLM_MODEL: z.string().default(""),
  // Per-attempt timeout for each ClaimKit LLM call.
  CLAIMKIT_LLM_TIMEOUT_MS: z.coerce.number().default(60000),
  // Total elapsed budget across all ClaimKit LLM attempts. 0 = no global ceiling.
  CLAIMKIT_LLM_TOTAL_TIMEOUT_MS: z.coerce.number().default(0),
  CLAIMKIT_LLM_MAX_ATTEMPTS: z.coerce.number().default(5),
  // If true, all LLM errors (including auth/schema/model failures) fall back
  // to the MemoryLLMAdapter. Default false — non-retryable errors propagate
  // so misconfiguration is visible.
  CLAIMKIT_LLM_FATAL_FALLBACK: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  // Live shadow grounding — fraction of live queries to run ground() on after
  // the agent responds. Populates rag_hallucination_rate / rag_grounded in
  // comparison_cases without affecting foreground latency. 0 disables; 1.0
  // grounds every query. Default 0.1 — measured signal without saturating
  // providers or ballooning cost.
  CLAIMKIT_LIVE_GROUNDING_RATE: z.coerce.number().default(0.1),
  // Max RAG evidence documents passed to shadow grounding. Fewer docs bounds
  // the ingest+extract LLM cost per sample.
  CLAIMKIT_LIVE_GROUNDING_MAX_EVIDENCE_DOCS: z.coerce.number().default(6),
  // Max characters per evidence doc in shadow grounding. Truncation keeps
  // each ingestion fast.
  CLAIMKIT_LIVE_GROUNDING_MAX_CHARS_PER_DOC: z.coerce.number().default(1500),
  // Routing thresholds for the ClaimKit/RAG blend decision.
  // CK wins when confidence is strictly above the high threshold and the
  // answer is answerable/partially-answerable. RAG wins when confidence is
  // strictly below the low threshold or the answer is not_answerable.
  CLAIMKIT_ROUTE_HIGH_CONFIDENCE: z.coerce.number().default(0.5),
  CLAIMKIT_ROUTE_LOW_CONFIDENCE: z.coerce.number().default(0.3),
  // Cascading retrieval (Idea 4): when ClaimKit's answer comes back with
  // confidence below this threshold and a non-empty missingEvidence list,
  // do a targeted second-pass RAG retrieval against each missing-evidence
  // item to fill the gap. Set to 0 to disable; 1.0 always cascades.
  CLAIMKIT_GAP_FILL_THRESHOLD: z.coerce.number().default(0.5),
  // Max missing-evidence items to use as second-pass RAG queries per turn.
  // Each adds one knowledge-store search; cap small to bound latency.
  CLAIMKIT_GAP_FILL_MAX_QUERIES: z.coerce.number().default(3),

  // Knowledge graph retrieval controls
  KNOWLEDGE_GRAPH_QUERY_ENABLED: z
    .string()
    .transform((s) => s === "true")
    .default("true"),
  KNOWLEDGE_GRAPH_FTS5_ENABLED: z
    .string()
    .transform((s) => s === "true")
    .default("true"),
  KNOWLEDGE_GRAPH_CACHE_TTL_MS: z.coerce.number().default(30_000),
  KNOWLEDGE_GRAPH_DOC_LIMIT: z.coerce.number().default(5),
  KNOWLEDGE_GRAPH_COMMUNITY_LIMIT: z.coerce.number().default(10),

  // If true, server.listen() is preceded by `await claimKitAdapter.initialize()`
  // and a hard process.exit(1) on failure. If false, init runs in the background
  // and failures are logged but non-fatal (existing 60s retry backoff applies).
  CLAIMKIT_REQUIRE_INIT: z
    .string()
    .transform((s) => s === "true")
    .default("true"),
  // If true, knowledge/codebase/graph ingestion runs synchronously before
  // server.listen(), so the store is fully populated on first request.
  // If false, ingestion is fire-and-forget after listen.
  CLAIMKIT_BLOCK_ON_INGESTION: z
    .string()
    .transform((s) => s === "true")
    .default("true"),

  // Dedicated Ollama provider for ClaimKit (isolates LLM calls from main chat)
  CLAIMKIT_OLLAMA_API_URL: z.string().url().default("http://localhost:11434"),
  CLAIMKIT_OLLAMA_API_KEY: z.string().default(""),
  CLAIMKIT_OLLAMA_MODEL: z.string().default("llama3"),

  // Nightly calendar planning
  NIGHTLY_PLAN_ENABLED: z
    .string()
    .transform((s) => s === "true")
    .default("true"),
  NIGHTLY_PLAN_WEEKS: z.coerce.number().default(2),
  NIGHTLY_PLAN_USER: z.string().default("user"),

  // Cron engine (scheduled automation)
  CRON_ENABLED: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  CRON_PATH: z.string().default("data/cron"),

  // HAWK Incident Response (ir.hawk.io)
  HAWK_IR_BASE_URL: z.string().default(""),
  HAWK_IR_ACCESS_TOKEN: z.string().default(""),
  HAWK_IR_SECRET_KEY: z.string().default(""),
  HAWK_IR_ENABLED: z
    .string()
    .transform((s) => s === "true")
    .default("false"),

  // Tenable Cloud (cloud.tenable.com)
  TENABLE_CLOUD_ACCESS_KEY: z.string().default(""),
  TENABLE_CLOUD_SECRET_KEY: z.string().default(""),

  // Ivanti Neurons Cloud
  IVANTI_ENABLED: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  IVANTI_HOST: z.string().default("nvuprd-sfc.ivanticloud.com"),
  IVANTI_TENANT_ID_OR_PATH: z.string().default(""),
  IVANTI_CLIENT_ID: z.string().default(""),
  IVANTI_CLIENT_SECRET: z.string().default(""),
  IVANTI_AUTH_URL: z.string().default(""),
  IVANTI_SCOPE: z.string().default(""),
  IVANTI_BOTS_HOST: z.string().default(""),
  IVANTI_PATCH_HOST: z.string().default(""),
  IVANTI_APPDIST_HOST: z.string().default(""),
  IVANTI_TIMEOUT: z.coerce.number().default(60_000),
  IVANTI_DEBUG: z
    .string()
    .transform((s) => s === "true")
    .default("false"),

  // Optional Ivanti Neurons for MDM Cloud module (device/user groups)
  IVANTI_MDM_ENABLED: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  IVANTI_MDM_HOST: z.string().default(""),
  IVANTI_MDM_USERNAME: z.string().default(""),
  IVANTI_MDM_PASSWORD: z.string().default(""),
  IVANTI_MDM_PARTITION_ID: z.string().default(""),

  // Optional Ivanti nZTA (Neurons for Secure Access) analytics/policy proxy
  IVANTI_NZTA_ENABLED: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  IVANTI_NZTA_HOST: z.string().default(""),
  IVANTI_NZTA_DSID: z.string().default(""),

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

  // Azure Communication Services (email via M365)
  ACS_CONNECTION_STRING: z.string().default(""),
  ACS_SENDER_ADDRESS: z.string().default(""),

  // Email provider selection: "auto" (prefer ACS, fall back to SMTP), "acs", or "smtp"
  EMAIL_PROVIDER: z.enum(["acs", "smtp", "auto"]).default("auto"),

  // Push notification polling
  PUSH_POLL_INTERVAL_MIN: z.coerce.number().default(5),
  PUSH_ESCALATION_L2_MINUTES: z.coerce.number().default(5),
  PUSH_ESCALATION_L3_MINUTES: z.coerce.number().default(15),

  // Tool loop limit (max iterations before forcing a final response)
  MAX_TOOL_LOOPS: z.coerce.number().default(75),

  // Job timeout (ms) — wall-clock limit for a single agent job before it is forcibly failed.
  // Set to 0 to disable the ceiling and allow multi-hour runs.
  AGENT_JOB_TIMEOUT_MS: z.coerce.number().default(600000),

  // Admin user IDs (comma-separated) — users allowed to override system prompts
  ADMIN_USER_IDS: z.string().default(""),

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
  AICODER_STALE_TIMEOUT_MINUTES: z.coerce.number().default(30),
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
  REVIEW_SOURCE: z.enum(["github", "gitlab"]).default("github"),
  SECURITY_AGENT_CMD: z.string().default("review-agent --category security"),
  QA_AGENT_CMD: z.string().default("review-agent --category qa"),
  QUALITY_AGENT_CMD: z.string().default("review-agent --category quality"),
  REGRESSION_AGENT_CMD: z.string().default(""),

  // Musician Assistant (MVP)
  MUSICIAN_ASSISTANT_ENABLED: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  MUSICIAN_AUDIO_UPLOAD_DIR: z.string().default("data/audio/uploads"),
  MUSICIAN_AUDIO_ANALYSIS_DIR: z.string().default("data/audio/analysis"),
  MUSICIAN_GENERATED_AUDIO_DIR: z.string().default("data/audio/generated"),
  MUSICIAN_GENERATION_ENABLED: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  MUSICIAN_GENERATION_PROVIDER: z
    .enum(["mock", "local", "huggingface", "external"])
    .default("mock"),
  MUSICIAN_MAX_UPLOAD_MB: z.coerce.number().default(100),
  MUSICIAN_MAX_GENERATION_SECONDS: z.coerce.number().default(30),
  MUSICIAN_DEFAULT_SAMPLE_RATE: z.coerce.number().default(44100),
  MUSICIAN_ENABLE_BASIC_PITCH: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  MUSICIAN_ENABLE_ESSENTIA: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  MUSICIAN_ENABLE_MUSICGEN: z
    .string()
    .transform((s) => s === "true")
    .default("false"),
  MUSICIAN_PYTHON_WORKER_URL: z.string().default(""),
  HUGGINGFACE_API_TOKEN: z.string().default(""),
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

/**
 * Resolve a profile-scoped path. Every subsystem (memory, skills, sessions)
 * should route file paths through this function instead of hardcoding `data/`,
 * so that switching the active profile transparently isolates all state.
 *
 * Returns `HERMES_HOME/profiles/{ACTIVE_PROFILE}/{relativePath}`.
 *
 * Active profile resolution order:
 *   1. process.env.ACTIVE_PROFILE — runtime override set by the long-running
 *      server after it loads the active profile.
 *   2. The `profiles/active` marker file — written by `profile switch`. This is
 *      what makes CLI commands honor a switch: a one-shot CLI invocation never
 *      sets the env var, so without reading the marker every CLI command would
 *      fall back to 'default'.
 *   3. env.ACTIVE_PROFILE (env schema default) → 'default'.
 */
export function resolvePath(relativePath: string): string {
  const home = process.env.HERMES_HOME || env.HERMES_HOME || "data";
  const requested =
    process.env.ACTIVE_PROFILE ||
    readActiveProfileName(home) ||
    env.ACTIVE_PROFILE ||
    "default";
  return path.join(home, "profiles", safeProfileName(requested), relativePath);
}

// A plain identifier: letters, digits, dot, underscore, hyphen. Note this
// pattern alone still matches "." and "..", which are filesystem traversal
// tokens, so safeProfileName() rejects those explicitly below.
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Normalize an untrusted profile name (from an env var or the on-disk `active`
 * marker) into a safe directory segment. Anything that isn't a plain identifier
 * — or is "." / ".." — falls back to "default" so a tampered value can't escape
 * the profile root and read or clobber another profile's state (which would
 * silently defeat isolation). "." is the critical case: path.join(home,
 * "profiles", ".", "memories") collapses to HERMES_HOME/profiles/memories,
 * escaping the per-profile boundary.
 */
export function safeProfileName(requested: string): string {
  if (
    !PROFILE_NAME_PATTERN.test(requested) ||
    requested === "." ||
    requested === ".."
  ) {
    return "default";
  }
  return requested;
}

// Cache the active-marker read, keyed by the marker file's mtime. resolvePath()
// is called on every memory/skill/session access, so re-reading the file each
// time adds avoidable sync I/O. A `profile switch` rewrites the marker (bumping
// mtime), so the cache self-invalidates without an explicit reset.
let activeMarkerCache:
  | { file: string; mtimeMs: number; name: string | undefined }
  | null = null;

/** Read the active profile name from `HERMES_HOME/profiles/active`, if present. */
function readActiveProfileName(home: string): string | undefined {
  const activeFile = path.join(home, "profiles", "active");
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(activeFile).mtimeMs;
  } catch {
    activeMarkerCache = null;
    return undefined;
  }

  if (
    activeMarkerCache &&
    activeMarkerCache.file === activeFile &&
    activeMarkerCache.mtimeMs === mtimeMs
  ) {
    return activeMarkerCache.name;
  }

  let name: string | undefined;
  try {
    name = fs.readFileSync(activeFile, "utf-8").trim() || undefined;
  } catch {
    name = undefined;
  }
  activeMarkerCache = { file: activeFile, mtimeMs, name };
  return name;
}
