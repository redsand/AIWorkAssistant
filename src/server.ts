/**
 * OpenClaw Agent - Main server
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { env } from './config/env';
import { healthRoutes } from './routes/health';
import { chatRoutes } from './routes/chat';
import { approvalRoutes } from './routes/approvals';
import { gitlabWebhookRoutes } from './routes/webhooks-gitlab';
import { roadmapRoutes } from './roadmap/api';
import { initializeTemplates } from './roadmap/templates';
import { guardrailsRoutes } from './guardrails/api';
import { googleOAuthRoutes } from './routes/google-oauth';
import path from 'path';

async function buildServer() {
  const server = Fastify({
    logger: {
      level: env.NODE_ENV === 'development' ? 'debug' : 'info',
    },
  });

  // Enable CORS
  await server.register(cors, {
    origin: true,
    credentials: true,
  });

  // Register routes
  await server.register(healthRoutes);
  await server.register(chatRoutes);
  await server.register(approvalRoutes);
  await server.register(gitlabWebhookRoutes);
  await server.register(roadmapRoutes, { prefix: '/api' });
  await server.register(guardrailsRoutes, { prefix: '/api' });
  await server.register(googleOAuthRoutes);

  // Serve static web files
  await server.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'web'),
    prefix: '/', // Serve from root
  });

  // Initialize roadmap templates
  try {
    initializeTemplates();
  } catch (error) {
    console.error('Failed to initialize roadmap templates:', error);
  }

  // Error handler
  server.setErrorHandler((error, _request, reply) => {
    server.log.error(error);
    const statusCode = (error as any).statusCode || 500;
    const message = env.NODE_ENV === 'development' ? (error as any).message : undefined;
    reply.code(statusCode).send({
      error: 'Internal Server Error',
      message,
    });
  });

  return server;
}

async function start() {
  const server = await buildServer();

  try {
    const port = env.PORT;
    const host = '0.0.0.0';

    await server.listen({ port, host });

    console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║  🤖 OpenClaw Agent v${process.env.npm_package_version || '0.1.0'}                    ║
║                                                            ║
║  Productivity & Engineering Copilot                        ║
║                                                            ║
║  Server running on: http://localhost:${port}                  ║
║  Web Interface: http://localhost:${port}                       ║
║  Environment: ${env.NODE_ENV}                                   ║
║                                                            ║
║  📚 API Endpoints:                                         ║
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
║                                                            ║
╚════════════════════════════════════════════════════════════╝
    `);

    // Log configuration status
    console.log('📋 Configuration Status:');
    console.log(`   OpenCode API: ${env.OPENCODE_API_KEY ? '✅ Configured' : '⚠️  Not configured'}`);
    console.log(`   Jira: ${env.JIRA_API_TOKEN ? '✅ Configured' : '⚠️  Not configured'}`);
    console.log(`   GitLab: ${env.GITLAB_TOKEN ? '✅ Configured' : '⚠️  Not configured'}`);
    console.log(`   Microsoft 365: ${env.MICROSOFT_CLIENT_ID ? '✅ Configured' : '⚠️  Not configured'}`);
    console.log(`   Policy Mode: ${env.POLICY_APPROVAL_MODE}`);
    console.log('');

  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
}

// Start server
start();
