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
        'src/routes/**',            // Fastify route handlers — tested via integration/e2e
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
