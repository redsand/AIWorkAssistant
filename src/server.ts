/**
 * AI Assistant - Main server
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { env } from "./config/env";
import { healthRoutes } from "./routes/health";
import { chatRoutes } from "./routes/chat";
import { approvalRoutes } from "./routes/approvals";
import { gitlabWebhookRoutes } from "./routes/webhooks-gitlab";
import { roadmapRoutes } from "./roadmap/api";
import { initializeTemplates } from "./roadmap/templates";
import { guardrailsRoutes } from "./guardrails/api";
import { authRoutes } from "./routes/auth";
import { googleOAuthRoutes } from "./routes/google-oauth";
import { fileCalendarRoutes } from "./routes/file-calendar";
import { productivityRoutes } from "./routes/productivity";
import { engineeringRoutes } from "./routes/engineering";
import { agentRunsRoutes } from "./agent-runs/api";
import { agentRunDatabase } from "./agent-runs/database";
import { workItemRoutes } from "./routes/work-items";
import { extractionRoutes } from "./routes/extraction";
import { jitbitSyncRoutes } from "./routes/jitbit-sync";
import { detectionRoutes } from "./routes/detection";
import { ctoRoutes } from "./routes/cto";
import { personalOsRoutes } from "./routes/personal-os";
import { productRoutes } from "./routes/product";
import { memoryRoutes } from "./routes/memory";
import { codeReviewRoutes } from "./routes/code-review";
import { pushSubscriptionRoutes } from "./routes/push-subscriptions";
import { pushAcknowledgeRoutes } from "./routes/push-acknowledge";
import { escalationConfigRoutes } from "./routes/escalation-config";
import { acknowledgeRoutes } from "./routes/acknowledge";
import { initPushDispatcher } from "./push/dispatcher";
import { startPollingEngine, stopPollingEngine } from "./push/polling-engine";
import { toolsRoutes } from "./routes/tools";
import { ticketBridgeRoutes } from "./routes/ticket-bridge";
import { reviewerConfigRoutes } from "./routes/reviewer-config";
import { autonomousLoopRoutes } from "./routes/autonomous-loop";
import { projectAssessmentRoutes } from "./routes/project-assessment";
import { digestRoutes } from "./routes/digests";
import { musicianRoutes } from "./routes/musician";
import { recipeRoutes } from "./routes/recipes";
import { repoDashboardRoutes } from "./routes/repo-dashboard";
import { kanbanRoutes } from "./routes/kanban";
import { reportRoutes } from "./routes/reports";
import { errorsRoutes } from "./routes/errors";
import { workflowRoutes } from "./routes/workflow";
import { claimKitAdapter } from "./context-engine/adapters/claimkit-adapter";
import { comparisonRoutes } from "./comparison-runs/api";
import { evalCalibrationRoutes } from "./eval/calibration/api";
import { ingestKnowledgeStore, ingestGraphStore } from "./context-engine/claimkit-ingestion";
import { errorLog } from "./observability/error-log";
import {
  authMiddleware,
  isAuthConfigured,
  getApiKeyForAuth,
} from "./middleware/auth";
import { startTunnel } from "./integrations/file/tunnel";
import { startCalendarScheduler } from "./scheduler/calendar-midnight";
import { startKanbanCleanupScheduler } from "./scheduler/kanban-worktree-cleanup";
import { startStaleAgentRunReaper } from "./agent-runs/reaper";
import { cronEngine } from "./scheduler/cron-engine";
import { initializeMCP } from "./integrations/mcp";
import { codebaseIndexer } from "./agent/codebase-indexer";
import { providerSettings } from "./agent/provider-settings";
import { toolCallCache } from "./memory/tool-cache";
import { gatewayEngine } from "./integrations/gateway/gateway-engine";
import { TelegramAdapter } from "./integrations/gateway/telegram-adapter";
import { SlackAdapter } from "./integrations/gateway/slack-adapter";
import { DiscordGatewayAdapter } from "./integrations/discord/discord-gateway-adapter";
import { WhatsAppAdapter } from "./integrations/gateway/whatsapp-adapter";
import { getProfileManager } from "./profiles/profile-manager";
import { getConfigProfileManager } from "./config/profile-manager";
import path from "path";

export async function buildServer() {
  const server = Fastify({
    logger: {
      level: env.NODE_ENV === "development" ? "debug" : "info",
    },
    requestTimeout: 0,
    keepAliveTimeout: 120000,
    routerOptions: {
      ignoreTrailingSlash: true,
    },
  });

  server.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      if (!body || (typeof body === "string" && body.trim() === "")) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Enable CORS
  await server.register(cors, {
    origin: true,
    credentials: true,
  });

  // Auth middleware (credentials or API key for protected routes)
  if (isAuthConfigured() || getApiKeyForAuth()) {
    await authMiddleware(server);
  }

  // Register routes
  await server.register(healthRoutes);
  await server.register(chatRoutes);
  await server.register(approvalRoutes);
  await server.register(gitlabWebhookRoutes);
  await server.register(roadmapRoutes, { prefix: "/api" });
  await server.register(guardrailsRoutes, { prefix: "/api" });
  await server.register(fileCalendarRoutes);
  await server.register(productivityRoutes);
  await server.register(engineeringRoutes);
  await server.register(agentRunsRoutes, { prefix: "/api" });
  await server.register(workItemRoutes, { prefix: "/api/work-items" });
  await server.register(extractionRoutes, { prefix: "/api/extraction" });
  await server.register(jitbitSyncRoutes, { prefix: "/api/sync" });
  await server.register(detectionRoutes, { prefix: "/api" });
  await server.register(ctoRoutes, { prefix: "/api/cto" });
  await server.register(personalOsRoutes, { prefix: "/api/personal-os" });
  await server.register(productRoutes, { prefix: "/api/product" });
  await server.register(memoryRoutes, { prefix: "/api/memory" });
  await server.register(codeReviewRoutes, { prefix: "/api/code-review" });
  await server.register(pushSubscriptionRoutes, { prefix: "/api" });
  await server.register(pushAcknowledgeRoutes, { prefix: "/api" });
  await server.register(escalationConfigRoutes, { prefix: "/api" });
  await server.register(acknowledgeRoutes);
  await server.register(toolsRoutes, { prefix: "/api" });
  await server.register(ticketBridgeRoutes, { prefix: "/api/ticket-bridge" });
  await server.register(reviewerConfigRoutes, { prefix: "/api/reviewer" });
  await server.register(autonomousLoopRoutes, { prefix: "/api/autonomous-loop" });
  await server.register(projectAssessmentRoutes, { prefix: "/api/project-assessment" });
  await server.register(digestRoutes, { prefix: "/api/digests" });
  await server.register(musicianRoutes, { prefix: "/api/musician" });
  await server.register(recipeRoutes);
  await server.register(comparisonRoutes, { prefix: "/api/comparison" });
  await server.register(evalCalibrationRoutes, { prefix: "/api/eval-calibration" });
  await server.register(repoDashboardRoutes, { prefix: "/api/repo-dashboard" });
  await server.register(kanbanRoutes, { prefix: "/api/kanban" });
  await server.register(reportRoutes, { prefix: "/api/reports" });
  await server.register(errorsRoutes, { prefix: "/api" });
  await server.register(workflowRoutes, { prefix: "/api/workflow" });
  await server.register(authRoutes);
  await server.register(googleOAuthRoutes);

  // Serve static web files
  await server.register(fastifyStatic, {
    root: path.join(__dirname, "..", "web"),
    prefix: "/",
    cacheControl: false,
    lastModified: false,
    etag: false,
  });

  // Serve the capabilities page at /capabilities (no .html extension)
  server.get("/capabilities", async (_request, reply) => {
    return reply.sendFile("capabilities.html");
  });

  // Serve the musician assistant page at /musician (no .html extension)
  server.get("/musician", async (_request, reply) => {
    return reply.sendFile("musician.html");
  });

  // Serve the comparison dashboard at /comparison (no .html extension)
  server.get("/comparison", async (_request, reply) => {
    return reply.sendFile("comparison.html");
  });

  // Serve the calibration eval set at /eval (no .html extension)
  server.get("/eval", async (_request, reply) => {
    return reply.sendFile("eval.html");
  });

  // Serve the repository issue dashboard at /dashboard (no .html extension)
  server.get("/dashboard", async (_request, reply) => {
    return reply.sendFile("dashboard.html");
  });

  // Serve the kanban board at /kanban (no .html extension)
  server.get("/kanban", async (_request, reply) => {
    return reply.sendFile("kanban.html");
  });

  // Force no-cache on static assets so Cloudflare doesn't cache them
  server.addHook("onSend", async (_request, reply) => {
    const route = reply.request.url;
    if (route.match(/\.(js|css|html|ico|png|jpg|svg|woff2?)$/)) {
      reply.header("Cache-Control", "no-cache, no-store, must-revalidate");
      reply.header("Pragma", "no-cache");
      reply.header("Expires", "0");
    }
  });

  // Initialize roadmap templates
  try {
    initializeTemplates();
  } catch (error) {
    void errorLog.log({
      source: "server",
      category: "template_initialization",
      message: error instanceof Error ? error.message : "Failed to initialize roadmap templates",
      error,
    });
    console.error("Failed to initialize roadmap templates:", error);
  }

  server.setErrorHandler((error, request, reply) => {
    void errorLog.log({
      source: "server",
      category: "request_error",
      message: error instanceof Error ? error.message : "Request error",
      error,
      userId: request.userId,
      context: {
        method: request.method,
        url: request.url,
        statusCode: (error as any).statusCode || 500,
      },
    });
    server.log.error(error);
    const statusCode = (error as any).statusCode || 500;
    const message =
      env.NODE_ENV === "development" ? (error as any).message : undefined;
    reply.code(statusCode).send({
      error: "Internal Server Error",
      message,
    });
  });

  return server;
}

function logStartupPhase(phase: string, detail?: string) {
  const stamp = new Date().toISOString();
  const extra = detail ? ` — ${detail}` : "";
  console.log(`[Startup ${stamp}] ${phase}${extra}`);
}

async function start() {
  logStartupPhase("Building server");
  const server = await buildServer();

  try {
    logStartupPhase("Applying persisted provider selection");
    providerSettings.applyPersistedSelection();
    const port = env.PORT;
    const host = "0.0.0.0";
    let staleRunInterval: NodeJS.Timeout | undefined;
    server.addHook("onClose", async () => {
      if (staleRunInterval) {
        clearInterval(staleRunInterval);
      }
    });

    // Start codebase indexing async if explicitly enabled.
    // Not awaited — ingestion no longer depends on it.
    if (env.RAG_INDEX_ON_STARTUP) {
      codebaseIndexer
        .indexCodebase()
        .then((result) => {
          console.log(
            `[RAG] Codebase indexed: ${result.totalFiles} files, ${result.totalChunks} chunks (${result.embedded ? "embeddings" : "TF-IDF"}) in ${result.duration}ms`,
          );
          if (result.errors.length > 0) {
            console.warn(
              `[RAG] ${result.errors.length} indexing errors:`,
              result.errors.slice(0, 5),
            );
          }
        })
        .catch((err) => {
          void errorLog.log({
            source: "rag",
            category: "indexing_failed",
            message: err instanceof Error ? err.message : "RAG indexing failed",
            error: err,
          });
          console.error("[RAG] Indexing failed:", err);
        });
    }

    // ─── Tool cache: connect Redis for cross-restart persistence ───
    const redisUrl = process.env.CLAIMKIT_REDIS_URL || "";
    if (redisUrl) {
      void toolCallCache.connectRedis(redisUrl);
    }

    // ─── Profile systems ───
    // Two distinct managers coexist on purpose; they are NOT duplicates:
    //   • profiles/profile-manager (getProfileManager) — per-SESSION runtime
    //     selection of system prompt + allowed tools. Concurrent chat sessions
    //     can run under different personalities without a restart. In-memory,
    //     keyed by sessionId.
    //   • config/profile-manager (getConfigProfileManager) — on-disk profile
    //     ISOLATION: each profile owns a separate memories/skills/sessions
    //     directory tree, selected by the `active` marker and consumed by
    //     resolvePath(). This is process-global and chosen at boot.
    // The session manager decides *which prompt/tools* a request uses; the
    // config manager decides *which directory* all state lands in.

    // ─── Profile Manager: initialize profiles ───
    logStartupPhase("Initializing session profile manager");
    try {
      const pm = getProfileManager();
      const profiles = pm.listProfiles();
      logStartupPhase("Profile manager ready", `${profiles.length} profile(s), default: ${pm.getDefaultProfileId()}`);
    } catch (err) {
      console.warn("[Profiles] Failed to initialize, using default:", err);
    }

    // ─── Profile isolation: load the active profile (auto-creates default) ───
    // getActive() seeds data/profiles/<name>/ and writes the `active` marker.
    // Sync ACTIVE_PROFILE so resolvePath() routes all subsequent profile-scoped
    // state (memories, skills, sessions) into the active profile's directory.
    logStartupPhase("Loading active config profile");
    try {
      const active = getConfigProfileManager().getActive();
      process.env.ACTIVE_PROFILE = active.name;
      logStartupPhase(
        "Active profile loaded",
        `${active.name} (soul: ${active.hasCustomSoul ? "custom" : "default"}, memory: ${active.hasCustomMemory ? "custom" : "default"}, skills: ${active.skillCount})`,
      );
    } catch (err) {
      console.warn("[Profiles] Failed to load active profile:", err);
    }

    // ─── ClaimKit init: block server.listen() until init resolves ───
    // CLAIMKIT_REQUIRE_INIT=true (default) → process.exit(1) on failure
    // CLAIMKIT_REQUIRE_INIT=false → log warning, continue with CK disabled (60s retry backoff)
    logStartupPhase("ClaimKit init", `enabled=${env.CLAIMKIT_ENABLED}, provider=${env.CLAIMKIT_LLM_PROVIDER}, blockOnIngestion=${env.CLAIMKIT_BLOCK_ON_INGESTION}`);
    let ckInitialized = false;
    if (env.CLAIMKIT_ENABLED) {
      logStartupPhase("ClaimKit initializing");
      try {
        ckInitialized = await claimKitAdapter.initialize();
        if (ckInitialized) {
          console.log(
            `[ClaimKit] Initialized — provider: ${env.CLAIMKIT_LLM_PROVIDER}, topK: ${env.CLAIMKIT_TOP_K}, minScore: ${env.CLAIMKIT_MIN_SCORE}`,
          );
        } else {
          const errMsg = claimKitAdapter.getInitError() || "unknown error";
          console.error(`[ClaimKit] Init failed: ${errMsg}`);
          if (env.CLAIMKIT_REQUIRE_INIT) {
            console.error(
              "[ClaimKit] FATAL — CLAIMKIT_REQUIRE_INIT=true. Refusing to start the server.\n" +
              "          Set CLAIMKIT_REQUIRE_INIT=false in .env to start in degraded (RAG-only) mode.",
            );
            process.exit(1);
          }
          console.warn(
            "[ClaimKit] Continuing without ClaimKit (CLAIMKIT_REQUIRE_INIT=false). " +
            "Auto-retry every 60s on next request.",
          );
        }
      } catch (err) {
        void errorLog.log({
          source: "claimkit",
          category: "startup_failed",
          message: err instanceof Error ? err.message : "ClaimKit startup error",
          error: err,
        });
        console.error("[ClaimKit] Startup error:", err);
        if (env.CLAIMKIT_REQUIRE_INIT) {
          console.error("[ClaimKit] FATAL — CLAIMKIT_REQUIRE_INIT=true. Refusing to start the server.");
          process.exit(1);
        }
      }
    }

    // ─── ClaimKit ingestion: optionally block server.listen() ───
    // CLAIMKIT_BLOCK_ON_INGESTION=true (default) → await full ingestion before listen
    // CLAIMKIT_BLOCK_ON_INGESTION=false → fire-and-forget after listen (set below)
    if (ckInitialized && env.CLAIMKIT_BLOCK_ON_INGESTION) {
      logStartupPhase("ClaimKit ingestion", "blocking startup");
      try {
        const [knowledge, graph] = await Promise.all([
          ingestKnowledgeStore(),
          ingestGraphStore(),
        ]);
        console.log(
          `[ClaimKit] Ingestion complete — ` +
          `knowledge: ${knowledge.ingested}/${knowledge.total} | ` +
          `graph: ${graph.ingested}/${graph.total}` +
          (knowledge.errors + graph.errors > 0
            ? ` | errors: ${knowledge.errors + graph.errors}`
            : ""),
        );
      } catch (err) {
        void errorLog.log({
          source: "claimkit",
          category: "ingestion_failed",
          message: err instanceof Error ? err.message : "ClaimKit ingestion error",
          error: err,
        });
        console.error(
          "[ClaimKit] Ingestion failed (continuing — seed-on-query will recover):",
          err,
        );
      }
    }

    // On Windows, tsx watch restarts can hit EADDRINUSE for a brief window
    // while the OS releases the previous child's TCP socket. Retry a few
    // times before giving up so tsx watch restarts succeed reliably.
    logStartupPhase("Binding server", `port=${port}`);
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await server.listen({ port, host });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EADDRINUSE" && attempt < 5) {
          console.warn(`[Server] Port ${port} busy (attempt ${attempt}/5), retrying in 2s…`);
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          throw err;
        }
      }
    }

    // Background ingestion path: only used when CLAIMKIT_BLOCK_ON_INGESTION=false.
    // Fire-and-forget so the server is responsive while the store fills up.
    if (ckInitialized && !env.CLAIMKIT_BLOCK_ON_INGESTION) {
      void (async () => {
        console.log("[ClaimKit] Ingesting stores (background)…");
        try {
          const [knowledge, graph] = await Promise.all([
            ingestKnowledgeStore(),
            ingestGraphStore(),
          ]);
          console.log(
            `[ClaimKit] Ingestion complete — ` +
            `knowledge: ${knowledge.ingested}/${knowledge.total} | ` +
            `graph: ${graph.ingested}/${graph.total}` +
            (knowledge.errors + graph.errors > 0
              ? ` | errors: ${knowledge.errors + graph.errors}`
              : ""),
          );
        } catch (err) {
          void errorLog.log({
            source: "claimkit",
            category: "ingestion_failed",
            message: err instanceof Error ? err.message : "ClaimKit ingestion error",
            error: err,
          });
          console.error("[ClaimKit] Background ingestion failed:", err);
        }
      })();
    }

    // Unconditional cross-process zombie wipe. Any 'running' row from a prior
    // PID is dead by definition (the previous process — and its in-memory
    // ProcessingJob and aiRequestLimiter slot — is gone). This runs ahead of
    // the threshold-gated markStaleRunsAsFailed because there's no policy
    // decision to make at boot: those rows cannot be live. Without this,
    // setting AICODER_STALE_TIMEOUT_MINUTES=0 to suppress in-process reaping
    // also suppressed the boot wipe, leaving zombies in 'running' forever.
    const zombieResult = agentRunDatabase.markZombieRunsFromPriorProcess();
    if (zombieResult.count > 0) {
      console.log(
        `🧹 Wiped ${zombieResult.count} zombie agent run(s) from prior process` +
          (zombieResult.sessionIds.length > 0
            ? ` (sessions: ${zombieResult.sessionIds.slice(0, 5).join(", ")}${zombieResult.sessionIds.length > 5 ? `, +${zombieResult.sessionIds.length - 5} more` : ""})`
            : ""),
      );
    }

    // Mark stale agent runs as failed on startup (in-process threshold sweep).
    // This catches runs that hung within the *current* PID, gated on
    // AICODER_STALE_TIMEOUT_MINUTES so long-running supervised work isn't
    // killed prematurely. Cross-process zombies are already handled above.
    const staleCount = agentRunDatabase.markStaleRunsAsFailed();
    if (staleCount > 0) {
      console.log(`🧹 Marked ${staleCount} stale agent run(s) as failed`);
    }
    staleRunInterval = setInterval(() => {
      const count = agentRunDatabase.markStaleRunsAsFailed();
      if (count > 0) {
        console.log(`🧹 Marked ${count} stale agent run(s) as failed`);
      }
    }, 60_000);
    staleRunInterval.unref();

    console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║  🤖 AI Assistant v${process.env.npm_package_version || "0.1.0"}                    ║
║                                                            ║
║  Productivity & Engineering Copilot                        ║
║                                                            ║
║  Server running on: http://localhost:${port}                  ║
║  Web Interface: http://localhost:${port}                       ║
║  Environment: ${env.NODE_ENV}                                   ║
║                                                            ║
║  📚 API Endpoints:                                         ║
║     POST   /auth/login                                     ║
║     POST   /auth/logout                                    ║
║     GET    /auth/status                                    ║
║     POST   /chat                                          ║
║     POST   /chat/sessions                                 ║
║     GET    /chat/sessions/:id                             ║
║     POST   /chat/sessions/:id/end                         ║
║     GET    /chat/memory/search                            ║
║     POST   /chat/memory/relevant                          ║
║     GET    /chat/memory/stats                             ║
║     GET    /health                                        ║
║     GET    /approvals                                     ║
║     POST   /approvals/:id/approve                         ║
║     POST   /approvals/:id/reject                          ║
║     POST   /webhooks/gitlab                               ║
║     GET    /api/roadmaps                                  ║
║     POST   /api/roadmaps                                  ║
║     GET    /api/roadmaps/:id                              ║
║     GET    /api/templates                                 ║
║     POST   /api/templates/:id/create-roadmap              ║
║     POST   /api/guardrails/check                          ║
║     GET    /api/guardrails/approvals/pending              ║
║     POST   /api/guardrails/approvals/:id/approve          ║
║     POST   /api/guardrails/approvals/:id/reject           ║
║     GET    /api/guardrails/history/:userId                ║
║     GET    /api/guardrails/stats                          ║
║     GET    /calendar/events                               ║
║     POST   /calendar/events                               ║
║     PATCH  /calendar/events/:eventId                      ║
║     DELETE /calendar/events/:eventId                      ║
║     POST   /calendar/focus-blocks                         ║
║     POST   /calendar/health-blocks                        ║
║     GET    /calendar/stats                                ║
║     GET    /calendar/export/ics                           ║
║     GET    /calendar/subscribe                            ║
║     GET    /productivity/daily-plan                       ║
║     GET    /productivity/weekly-plan                       ║
║     GET    /productivity/focus-blocks/recommend             ║
║     POST   /productivity/focus-blocks                      ║
║     GET    /productivity/health-breaks/recommend            ║
║     POST   /productivity/health-blocks                      ║
║     GET    /productivity/calendar-summary                  ║
║     POST   /engineering/workflow-brief                      ║
║     POST   /engineering/architecture-proposal               ║
║     POST   /engineering/scaffolding-plan                   ║
║     POST   /engineering/jira-tickets                       ║
║     POST   /engineering/jira-tickets/create                 ║
║     POST   /api/musician/theory                              ║
║     POST   /api/musician/compose                             ║
║     POST   /api/musician/practice-plan                      ║
║     POST   /api/musician/analyze-audio                      ║
║     POST   /api/musician/generate-sample                    ║
║     POST   /api/musician/transcribe-audio                   ║
║     GET    /api/agent-runs                                  ║
║     GET    /api/agent-runs/stats                            ║
║     GET    /api/agent-runs/aicoder                          ║
║     GET    /api/agent-runs/:id                              ║
║     GET    /api/agent-runs/:id/steps                        ║
║     GET    /api/work-items                                   ║
║     POST   /api/work-items                                   ║
║     GET    /api/work-items/stats                             ║
║     GET    /api/work-items/:id                               ║
║     PATCH  /api/work-items/:id                               ║
║     POST   /api/work-items/:id/notes                         ║
║     POST   /api/work-items/:id/links                        ║
║     POST   /api/work-items/:id/complete                      ║
║     POST   /api/work-items/:id/archive                      ║
║     GET    /api/personal-os/brief                            ║
║     GET    /api/personal-os/open-loops                       ║
║     GET    /api/personal-os/patterns                         ║
║     POST   /api/personal-os/work-items                       ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
    `);

    providerSettings.warmDefaultProvider();

    // Log configuration status
    console.log("📋 Configuration Status:");
    const currentProvider = providerSettings.getCurrent();
    const providerLabel = currentProvider.provider.toUpperCase();
    const providerKeys: Record<string, string> = {
      opencode: env.OPENCODE_API_KEY,
      zai: env.ZAI_API_KEY,
      ollama: env.OLLAMA_API_KEY,
      openai: env.OPENAI_API_KEY,
    };
    const providerKey = providerKeys[currentProvider.provider] || "";
    console.log(
      `   AI Provider (${providerLabel}/${currentProvider.model}): ${providerKey ? "✅ Configured" : "⚠️  Not configured"}`,
    );
    console.log(
      `   Jira: ${env.JIRA_API_TOKEN ? "✅ Configured" : "⚠️  Not configured"}`,
    );
    console.log(
      `   GitLab: ${env.GITLAB_TOKEN ? "✅ Configured" : "⚠️  Not configured"}`,
    );
    console.log(
      `   GitHub: ${env.GITHUB_TOKEN ? "✅ Configured" : "⚠️  Not configured"}`,
    );
    console.log(
      `   Jitbit: ${env.JITBIT_ENABLED && env.JITBIT_API_TOKEN ? "✅ Configured" : "⚠️  Not configured"}`,
    );
    console.log(
      `   Microsoft 365: ${env.MICROSOFT_CLIENT_ID ? "✅ Configured" : "⚠️  Not configured"}`,
    );
    console.log(
      `   Auth: ${isAuthConfigured() ? "✅ Credentials enabled" : "⚠️  No AUTH_PASSWORD set (unprotected)"}`,
    );
    console.log(`   Policy Mode: ${env.POLICY_APPROVAL_MODE}`);
    console.log("");

    initializeMCP();
    initPushDispatcher();
    startPollingEngine();

    process.on("SIGTERM", async () => {
      stopPollingEngine();
      await cronEngine.stop();
      await gatewayEngine.stop();
      await claimKitAdapter.close();
      process.exit(0);
    });
    process.on("SIGINT", async () => {
      stopPollingEngine();
      await cronEngine.stop();
      await gatewayEngine.stop();
      await claimKitAdapter.close();
      process.exit(0);
    });

    // (RAG indexing + ClaimKit init/ingestion moved above server.listen())

    const tunnelUrl = await startTunnel();
    startCalendarScheduler();
    startKanbanCleanupScheduler();
    startStaleAgentRunReaper();
    if (env.CRON_ENABLED) {
      cronEngine.start();
    }
    if (env.GATEWAY_ENABLED) {
      const gwDataPath = env.GATEWAY_DATA_PATH;

      if (env.TELEGRAM_BOT_TOKEN) {
        gatewayEngine.registerAdapter(new TelegramAdapter({ token: env.TELEGRAM_BOT_TOKEN }));
      }
      if (env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN) {
        gatewayEngine.registerAdapter(new SlackAdapter({ botToken: env.SLACK_BOT_TOKEN, appToken: env.SLACK_APP_TOKEN }));
      }
      if (env.DISCORD_BOT_TOKEN) {
        gatewayEngine.registerAdapter(new DiscordGatewayAdapter({
          token: env.DISCORD_BOT_TOKEN,
          clientId: env.DISCORD_CLIENT_ID,
          guildId: env.DISCORD_GUILD_ID || undefined,
          allowedUserId: env.DISCORD_ALLOWED_USER_ID || undefined,
        }));
      }
      if (env.SIGNAL_PHONE_NUMBER) {
        gatewayEngine.registerAdapter(new WhatsAppAdapter({
          signalPhoneNumber: env.SIGNAL_PHONE_NUMBER,
          signalDataPath: env.SIGNAL_DATA_PATH,
        }));
      }

      // Override data dir if configured
      if (gwDataPath) {
        (gatewayEngine as any).dataDir = path.resolve(gwDataPath);
      }

      if (gatewayEngine.getRegisteredPlatforms().length > 0) {
        gatewayEngine.start().then(() => {
          console.log(
            `[Gateway] Started with platforms: ${gatewayEngine.getRegisteredPlatforms().join(", ")}`,
          );
        }).catch((err) => {
          console.error("[Gateway] Startup failed:", err);
        });
      } else {
        console.warn("[Gateway] Enabled but no platform adapters configured");
      }
    }
    if (tunnelUrl) {
      const webcalUrl = tunnelUrl.replace(/^https?/, "webcal");
      console.log("");
      console.log("📱 iPhone Calendar Subscription:");
      console.log(`   Tunnel URL: ${tunnelUrl}`);
      console.log(`   ICS Feed:   ${tunnelUrl}/calendar/export/ics`);
      console.log(`   webcal:     ${webcalUrl}/calendar/export/ics`);
      console.log("");
      console.log("   On iPhone: Settings > Calendar > Accounts > Add Account");
      console.log(
        "   > Other > Add Subscribed Calendar > paste the webcal URL",
      );
      console.log("");
      console.log("   Or visit: " + tunnelUrl + "/calendar/subscribe");
    }
  } catch (error) {
    await errorLog.log({
      source: "server",
      category: "startup_failed",
      message: error instanceof Error ? error.message : "Server startup failed",
      error,
    });
    server.log.error(error);
    process.exit(1);
  }
}

// Start server (skip in test environment)
if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  start();
}
