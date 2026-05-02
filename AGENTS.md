# Repository Guidelines

## Project Overview

Guarded AI agent (v0.1.0, late alpha) with productivity and engineering modes. Fastify HTTP server on port 3050, TypeScript strict mode, Vitest for testing. Integrates with Jira, GitLab, Google Calendar, Discord, and OpenCode AI.

See `PROJECT_STATUS.md` for module-by-module status and `docs/GAP_AUDIT.md` for the independent code audit.

## Project Structure & Module Organization

```
src/
├── server.ts                    # Fastify server, route registration, tunnel startup
├── config/env.ts                # Zod-validated .env configuration
├── agent/                       # Chat orchestration, OpenCode client, tool registry/dispatcher
├── policy/                      # Pattern-based policy engine (strict/balanced/permissive)
├── approvals/                   # SQLite-persisted approval queue with execution dispatch
├── audit/logger.ts              # JSONL audit log — write + query
├── guardrails/                  # 15 critical actions, rate limiting, action registry
├── middleware/auth.ts            # API key auth (Bearer / X-API-Key / query param)
├── memory/                      # Conversation sessions with auto-compaction
├── integrations/
│   ├── jira/                    # Jira Cloud REST client + service layer (policy-gated)
│   ├── gitlab/                  # GitLab REST client + webhook handler
│   ├── file/calendar-service.ts # Local calendar with RFC 5545 ICS export
│   ├── file/tunnel.ts           # Cloudflare/localtunnel for external ICS access
│   ├── google/                  # Google Calendar OAuth2 + API
│   ├── discord/                 # Discord bot with slash commands
│   └── signal/                  # Signal bot (broken polling, depends on signal-cli)
├── productivity/                # Daily planner, focus blocks, health breaks
├── engineering/                 # Workflow brief, architecture planner, scaffold, Jira ticket gen
├── roadmap/                     # SQLite-backed roadmap CRUD + REST API + templates
├── routes/                      # Fastify route handlers (one file per domain)
├── scheduler/                   # Calendar midnight scheduler
└── types/                       # Shared TypeScript interfaces
```

Key architectural flow: `Request → Auth Middleware → Route Handler → Policy Engine → Guardrails → Approval Queue (if needed) → Tool Dispatcher → Integration Client → Audit Logger`

## Build, Test, and Development Commands

```bash
npm run dev                # tsx watch with hot-reload
npm run build              # tsc compilation
npx tsc --noEmit           # Type-check without emitting (run after edits)

npm test                   # Vitest run (44/45 tests pass)
npm run test:watch         # Vitest watch mode
npm run test:coverage      # Vitest with v8 coverage reporter
npx vitest run tests/unit/policy/engine.test.ts  # Single test file

npm run lint               # ESLint on src/
npm run format             # Prettier write on src/**/*.ts

npm run cli                # CLI via tsx
npm run bot:discord        # Discord bot via tsx
npm run docker:up          # docker-compose up -d
```

## Coding Style & Conventions

- **TypeScript strict mode** — `strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`
- **Module system** — `ES2022` target, `NodeNext` module resolution, use `import`/`export` syntax
- **No comments** — Do not add comments unless explicitly requested
- **Singleton exports** — Services use `export const foo = new Foo()` pattern
- **Policy-gated services** — Business logic in `*-service.ts` wraps client calls with policy evaluation
- **Error handling** — Integration clients throw descriptive errors; services catch and log
- **Env config** — All config via `src/config/env.ts` with Zod defaults, never raw `process.env`
- **Database** — SQLite via `better-sqlite3` for roadmap, approvals; JSONL files for audit logs

## Testing Guidelines

- **Framework**: Vitest with `globals: true`, `environment: 'node'`
- **Coverage**: v8 provider, excludes node_modules, dist, tests, types
- **Existing tests**: `tests/unit/` — 4 files, 44/45 passing (1 JQL deprecation failure)
- **No workflow tests exist** — This is a known critical gap (see `docs/GAP_AUDIT.md`)
- **Test naming**: `describe("Module Name", () => { it("should ...", ...) })`
- **Location**: `tests/unit/<domain>/<module>.test.ts`

## Current Priority: Version 0.2.0

See `docs/roadmap.md` for the full roadmap. Current priorities:

1. Security fixes (timing-safe comparisons for auth + webhook HMAC)
2. Persistence (wire guardrails database.ts, audit logger query)
3. Cleanup (CLI bin field, remove Microsoft stubs, fix Math.random in ticket gen)
4. Workflow tests (approval lifecycle, calendar CRUD, chat→tool dispatch, auth middleware)

## RTK Token Optimization

Always prefix bash commands with `rtk` for token savings on build/test/git output. See `~/.claude/CLAUDE.md` for full RTK command reference.
