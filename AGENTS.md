# Repository Guidelines

## Project Overview

Guarded AI agent (v0.1.0, late alpha) with productivity and engineering modes. Fastify HTTP server on port 3050, TypeScript strict mode, Vitest for testing. Integrates with Jira, GitLab, Google Calendar, Discord, and OpenAI AI.

See `PROJECT_STATUS.md` for module-by-module status and `docs/GAP_AUDIT.md` for the independent code audit.

## Project Structure & Module Organization

```
src/
  ↳ ↳ server.ts                    # Fastify server, route registration, tunnel startup
  ↳ ↳ config/env.ts                # zod-validated .env configuration
  ↳ ↳ agent/                        # Chat orchestration, OpenAI client, tool registry/dispatcher
  ↳ ↳ policy/                      # Pattern-based policy engine (strict/balanced/permissiveness)
  ↳ ↳ approvals/                    # SQLlite-persisted approval queue with execution dispatch
  ↳ ↳ audit/logger.ts              # JSONL audit log ✍️ write + query
  ↳ ↳ guardrails/                    # 15 critical actions, rate limiting, action registry
  ↳ ↳ middleware/auth.ts            # API key auth (Bearer / X-API-Key / query param)
  ↳ ↳ memory/                        # Conversation sessions with auto-compaction
  ↳ ↳ integrations/
  ↳ ↳ jira/                        # Jira Cloud REST client + service layer (policy-gated)
  ↳ ↳ gitlab/                      # GitLab REST client + webhook handler
  ↳ ↳ file/calendar-service.ts     # Local calendar with RFC 5545 ICS export
  ↳ ↳ file/tunnel.ts                # Cloudflare/localtunnel for external ICS access
  ↳ ↳ google/                      # Google Calendar OAuth2 + API
  ↳ ↳ discord/                      # Discord bot with slash commands
  ↳ ↳ signal/                      # Signal bot (broken polling, depends on signal-cli)
  ↳ ↳ productivity/                # Daily planner, focus blocks, health breaks
  ↳ ↳ engineering/                  # Workflow brief, architecture planner, scaffold, Jira ticket gen
  ↳ ↳ roadmap/                      # SQLlite-backed roadmap CRUD + REST API + templates
  ↳ ↳ routes/                      # Fastify route handlers (one file per domain)
  ↳ ↳ scheduler/                    # Calendar midnight scheduler
  ↳ ↳ types/                       # Shared TypeScript interfaces
```

Key architectural flow: `Request ➔ Auth Middleware ➔ Route Handler ➔ Policy Engine ➔ Approval Queue (if needed) ➔ Tool Dispatcher ➔ Integration Client ➔ Audit Logger`

## Build, Test, and Development Commands

```bash
npm run dev                               # tsx watch with hot-reload
npm run build                             # tsc compilation
npx tsc --noEmit                          # Type-check without emitting (run after edits)

npm test                                  # Vitest run (44/45 tests pass)
npm run test:watch                        # Vitest watch mode
npm run test:coverage                     # Vitest with v8 coverage reporters
npx vitest run tests/unit/policy/engine.test.ts   # Single test file

npm run lint                              # ESLint on src/
npm run format                            # Prettier write on src/**/*{.ts,js}

npm run cli                               # CLI via tsx
npm run bot:discord                       # Discord bot via tsx
npm run docker:up                         # docker-compose up -d
```

## Coding Style & Conventions

- **TypeScript strict mode** ✍️ `strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`
- **Module system** ➔ `ES2022` target, `NodeNext` module resolution, use `import`/`export` syntax
- **No comments** ✍️ Do not add comments unless explicitly requested
- **Singleton exports** ➔ Services use `export const foo = new Foo()` pattern
- **Policy-gated services** ➔ Business logic in `~service.ts` wraps client calls with policy evaluation
- **Error handling** ⚠️ Integration clients throw descriptive errors; services catch and log
- **Env config** ⚠️ All config via `src/config/env.ts` with Zod defaults, never raw `process.env`
- **Databases** ✍️ SQLite via `better-sqlite3` for roadmaps, approvals; JSONL files for audit logs

## Testing Guidelines

- **Framework**: Vitest with `globals: true`, `environment: 'node'`
- **Coverage**: v8 provider, excludes `node_modules`, `dist`, `tests`, `types`
- **Existing tests**: `tests/unit/` ➔ 4 files, 44/45 passing (1 JQL deprecation failure)
- **No workflow tests exist** ⚠️ This is a known critical gap (see `docs/GAP_AUDIT.md`)
- **Test naming**: `describe("Module Name", () => { it("should ...", () => { ... }) })`
- **Location**: `tests/unit/<domain>/<module>.test.ts`

## ⚠️ MANDATORY: Coding Prompts in Tickets

**Every ticket (GitHub issue, Jira issue, or any task) MUST include a coding prompt.** This is a hard requirement for all agents and humans creating tickets in this repository.

A coding prompt is a self-contained specification that includes:

1. **File path** ➔ Exact file(s) to modify (e.g., `src/routes/chat.ts`, `web/js/sidebar.js`)
2. **Current code** ✍️ The code as it exists now, with line numbers (e.g., `line 45-52`)
3. **Replacement code** ➔ The exact new code to write
4. **Reasoning** ⚠️ Why this change solves the problem or implements the feature

## Why This Matters

Without coding prompts, agents waste cycles exploring the codebase and often produce incorrect changes. With coding prompts, agents make precise, correct changes on the first attempt.

## Template

```markdown
## Coding Prompt

### File: [path/to/file.ts] (line X-Y)

#### Current Code
[paste current code]

#### Replacement Code
[paste new code]

#### Reasoning
[explain why this change solves the problem]
```

### When Creating Jira Tickets

The `JiraTicketGenerator` now includes a `codingPrompt` field on every ticket. Always fill it in:

```typescript
tickets: [
  {
    summary: "Fix SSE stream error handling in live.js",
    description: "The pump() function doesn't handle reader.read() errors...",
    issueType: "Bug",
    acceptanceCriteria: ["pump() wraps reader.read() in try/catch"],
    codingPrompt: `## Coding Prompt
## File: web/js/live.js (line 45-58)
## Current Code
[...]
## Replacement Code
[...]
## Reasoning
[...]`
  }
]
```

If no coding prompt is available, the generator will add a placeholder reminding the assignee to add one.

## Enforcement

This requirement is enforced through:

1. **Issue Templates** ✍️ Bug reports and feature requests require a `coding_prompt` field
2. **GitHub Actions** ✍️ `validate-issue.yml` auto-labels `missing-coding-prompt` and posts a reminder
3. **Jira Generator** ✍️ Includes `## Coding Prompt` section in every ticket
4. **This document** ✍️ `AGENTS.md` is read by all AI agents

See `docs/creating-tickets.md` for detailed guidance and examples.

## Current Priority: Version 0.2.0

See `docs/roadmap.md` for the full roadmap. Current priorities:

1. Security fixes (timing-safe comparisons for auth + webhook HMAC)
2. Persistence (wire guardrails to database.ts, audit logger query)
3. Cleanup (CLI bin files, remove Microsoft stubs, fix Math.random in ticket gen)
4. Workflow tests (approval lifecycle, calendar CRUD, chatbot dispatcher, auth middleware)

## RTK Token Optimization

Always prefix bash commands with `rtk` for token savings on build/test/git output. See `~/.claude/CLAUDE.md` for full RTK command reference.

## Targeted Prompt Rules (Error Reduction)

These rules apply to every task in this project unless explicitly overridden.
Bias: caution over speed on non-trivial work.

## Rule 1 — Think Before Coding
State assumptions explicitly. Ask rather than guess.
Push back when a simpler approach exists. Stop when confused.

## Rule 2 — Simplicity First
Minimum code that solves the problem. Nothing speculative.
No abstractions for single-use code.

## Rule 3 — Surgical Changes
Touch only what you must. Don't improve adjacent code.
Match existing style. Don't refactor what isn't broken.

## Rule 4 — Goal-Driven Execution
Define success criteria. Loop until verified.
Strong success criteria let Claude loop independently.

## Rule 5 — Use the model only for judgment calls
Use for: classification, drafting, summarization, extraction.
Do NOT use for: routing, retries, deterministic transforms.
If code can answer, code answers.

## Rule 6 — Token budgets are not advisory
Per-task: 4,000 tokens. Per-session: 30,000 tokens.
If approaching budget, summarize and start fresh.
Surface the breach. Do not silently overrun.

## Rule 7 — Surface conflicts, don't average them
If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.

## Rule 8 — Read before you write
Before adding code, read exports, immediate callers, shared utilities.
If unsure why existing code is structured a certain way, ask.

## Rule 9 — Tests verify intent, not just behavior
Tests must encode WHY behavior matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

## Rule 10 — Checkpoint after every significant step
Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.

## Rule 11 — Match the codebase's conventions, even if you disagree
Conformance > taste inside the codebase.
If you think a convention is harmful, surface it. Don't fork silently.

## Rule 12 — Fail loud
"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.
