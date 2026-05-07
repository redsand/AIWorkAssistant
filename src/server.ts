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
import { ctoRoutes } from "./routes/cto";
import { personalOsRoutes } from "./routes/personal-os";
import { productRoutes } from "./routes/product";
import { memoryRoutes } from "./routes/memory";
import { codeReviewRoutes } from "./routes/code-review";
import { pushSubscriptionRoutes } from "./routes/push-subscriptions";
import { pushAcknowledgeRoutes } from "./routes/push-acknowledge";
import { initPushDispatcher } from "./push/dispatcher";
import { startPollingEngine, stopPollingEngine } from "./push/polling-engine";
import { toolsRoutes } from "./routes/tools";
import { ticketBridgeRoutes } from "./routes/ticket-bridge";
import { reviewerConfigRoutes } from "./routes/reviewer-config";
import { autonomousLoopRoutes } from "./routes/autonomous-loop";
import { projectAssessmentRoutes } from "./routes/project-assessment";
import { digestRoutes } from "./routes/digests";
import {
  authMiddleware,
  isAuthConfigured,
  getApiKeyForAuth,
} from "./middleware/auth";
import { startTunnel } from "./integrations/file/tunnel";
import { startCalendarScheduler } from "./scheduler/calendar-midnight";
import { initializeMCP } from "./integrations/mcp";
import { codebaseIndexer } from "./agent/codebase-indexer";
import path from "path";

export async function buildServer() {
  const server = Fastify({
    logger: {
      level: env.NODE_ENV === "development" ? "debug" : "info",
    },
    requestTimeout: 0,
    keepAliveTimeout: 120000,
    ignoreTrailingSlash: true,
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
  await server.register(ctoRoutes, { prefix: "/api/cto" });
  await server.register(personalOsRoutes, { prefix: "/api/personal-os" });
  await server.register(productRoutes, { prefix: "/api/product" });
  await server.register(memoryRoutes, { prefix: "/api/memory" });
  await server.register(codeReviewRoutes, { prefix: "/api/code-review" });
  await server.register(pushSubscriptionRoutes, { prefix: "/api" });
  await server.register(pushAcknowledgeRoutes, { prefix: "/api" });
  await server.register(toolsRoutes, { prefix: "/api" });
  await server.register(ticketBridgeRoutes, { prefix: "/api/ticket-bridge" });
  await server.register(reviewerConfigRoutes, { prefix: "/api/reviewer" });
  await server.register(autonomousLoopRoutes, { prefix: "/api/autonomous-loop" });
  await server.register(projectAssessmentRoutes, { prefix: "/api/project-assessment" });
  await server.register(digestRoutes, { prefix: "/api/digests" });
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
    console.error("Failed to initialize roadmap templates:", error);
  }

  // Error handler
  server.setErrorHandler((error, _request, reply) => {
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

async function start() {
  const server = await buildServer();

  try {
    const port = env.PORT;
    const host = "0.0.0.0";
    let staleRunInterval: NodeJS.Timeout | undefined;
    server.addHook("onClose", async () => {
      if (staleRunInterval) {
        clearInterval(staleRunInterval);
      }
    });

    await server.listen({ port, host });

    // Mark stale agent runs as failed on startup (crashed/restarted mid-run)
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
║     GET    /api/agent-runs                                  ║
║     GET    /api/agent-runs/stats                            ║
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

    // Log configuration status
    console.log("📋 Configuration Status:");
    const providerLabel = env.AI_PROVIDER.toUpperCase();
    const providerKeys: Record<string, string> = {
      opencode: env.OPENCODE_API_KEY,
      zai: env.ZAI_API_KEY,
      ollama: env.OLLAMA_API_KEY,
    };
    const providerKey = providerKeys[env.AI_PROVIDER] || "";
    console.log(
      `   AI Provider (${providerLabel}): ${providerKey ? "✅ Configured" : "⚠️  Not configured"}`,
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

    process.on("SIGTERM", () => {
      stopPollingEngine();
      process.exit(0);
    });
    process.on("SIGINT", () => {
      stopPollingEngine();
      process.exit(0);
    });

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
          console.error("[RAG] Indexing failed:", err);
        });
    }

    const tunnelUrl = await startTunnel();
    startCalendarScheduler();
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
    server.log.error(error);
    process.exit(1);
  }
}

// Start server (skip in test environment)
if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  start();
}
