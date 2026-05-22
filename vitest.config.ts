import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    exclude: ['dist/**', 'node_modules/**', '.claude/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/types/',
        'src/routes/acknowledge.ts',
        'src/routes/approvals.ts',
        'src/routes/auth.ts',
        'src/routes/autonomous-loop.ts',
        'src/routes/chat.ts',
        'src/routes/code-review.ts',
        'src/routes/cto.ts',
        'src/routes/digests.ts',
        'src/routes/engineering.ts',
        'src/routes/file-calendar.ts',
        'src/routes/google-oauth.ts',
        'src/routes/health.ts',
        // src/routes/kanban.ts — covered by route test suite
        'src/routes/memory.ts',
        'src/routes/musician.ts',
        'src/routes/personal-os.ts',
        'src/routes/product.ts',
        'src/routes/productivity.ts',
        'src/routes/project-assessment.ts',
        'src/routes/push-acknowledge.ts',
        'src/routes/push-subscriptions.ts',
        'src/routes/recipes.ts',
        'src/routes/repo-dashboard.ts',
        'src/routes/reviewer-config.ts',
        'src/routes/ticket-bridge.ts',
        'src/routes/tools.ts',
        'src/routes/webhooks-gitlab.ts',
        'src/routes/work-items.ts',
        'src/integrations/**',      // External API clients — require live services
        'src/agent/**',             // Complex AI dispatching — integration-tested
        'src/server.ts',            // HTTP server bootstrap
        'src/roadmap/api.ts',       // Fastify route handler
        'src/agent-runs/api.ts',    // Fastify route handler
        'src/comparison-runs/api.ts', // Fastify route handler
        'src/guardrails/api.ts',    // Fastify route handler
        'src/approvals/queue.ts',   // Background job queue
        'src/autonomous-loop/agent-runner.ts', // Complex agent orchestration
        'src/autonomous-loop/git-ops.ts',     // Git CLI operations
        'src/autonomous-loop/pr-creator.ts',  // Git PR operations
        'src/musician/service.ts',  // External music generation service
        'src/push/pollers/jitbit-poller.ts',  // External Jitbit API poller
        'src/audit/logger.ts',      // Audit logging infrastructure
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
