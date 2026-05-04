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

    await server.listen({ port, host });

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
      `   Microsoft 365: ${env.MICROSOFT_CLIENT_ID ? "✅ Configured" : "⚠️  Not configured"}`,
    );
    console.log(
      `   Auth: ${isAuthConfigured() ? "✅ Credentials enabled" : "⚠️  No AUTH_PASSWORD set (unprotected)"}`,
    );
    console.log(`   Policy Mode: ${env.POLICY_APPROVAL_MODE}`);
    console.log("");

    initializeMCP();

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
