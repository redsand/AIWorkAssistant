# OpenClaw Agent - Project Status

**Last Updated:** 2026-04-30
**Version:** 0.1.0
**Status:** 🟡 Late Alpha — Core infrastructure solid, several modules still stub

---

## Implementation Reality Check

> See [`docs/GAP_AUDIT.md`](./docs/GAP_AUDIT.md) for the full independent audit of documentation vs code reality.

### Legend

- ✅ **REAL** — Working implementation, tested, connected to routes/services
- ⚠️ **PARTIAL** — Substantial code exists but missing key functionality
- 🔴 **STUB** — Returns hardcoded data, throws "Not implemented", or not connected
- 🔴 **BUG** — Code exists but has a blocking bug

---

## Module Status

### Core Infrastructure ✅ REAL

- ✅ **Fastify HTTP Server** — Port 3050, CORS, static files, error handler
- ✅ **TypeScript Build System** — Clean compilation (pre-existing unused variable warnings only)
- ✅ **Environment Configuration** — Zod-validated config with `.env` support
- ✅ **Conversation Memory** — Auto-compaction, file persistence, keyword search (743 lines)

### AI Integration ✅ REAL

- ✅ **OpenCode API Client** — 321-line client with chat, streaming, tool calling, token tracking
- ✅ **Tool Registry** — 15+ tools across productivity and engineering modes
- ✅ **Tool Dispatcher** — 10 real handlers dispatching to Jira, GitLab, Calendar, Daily Planner
- ✅ **System Prompts** — Productivity and Engineering mode prompts

### Policy & Guardrails ✅ REAL (with caveats)

- ✅ **Policy Engine** — Pattern-based matching, 3-tier modes (strict/balanced/permissive)
- ✅ **Guardrails System** — 752 lines, 15 critical actions, rate limiting, role-based auth
- ✅ **Approval Queue** — SQLite persistence, action execution via `dispatchToolCall()`, status tracking (pending/approved/rejected/executed/failed)
- ⚠️ **Guardrails Persistence** — `database.ts` exists (205 lines) but is dead code — `action-registry.ts` uses in-memory Maps; state lost on restart
- ⚠️ **Audit Logger** — Write path works; `query()` returns empty array (TODO)

### Auth & Security ⚠️ PARTIAL

- ✅ **API Key Auth Middleware** — Bearer token / `X-API-Key` header / `?apiKey=` query param, public path whitelist
- ⚠️ **Auth key comparison** — Uses `!==` string equality, not `crypto.timingSafeEqual` (timing attack vulnerability)
- ⚠️ **GitLab Webhook HMAC** — Uses `===` string comparison instead of HMAC-SHA256 (timing attack + no payload verification)

### Project Management ✅ REAL

- ✅ **Jira Integration** — 529-line client + 174-line service, full CRUD, v2/v3 fallback
- ⚠️ **GitLab Integration** — 346-line client + 202-line webhook handler + Jira key extractor (webhook HMAC is insecure)
- ✅ **Roadmap Management** — 579-line SQLite database + 597-line REST API + templates

### Calendar ✅ REAL

- ✅ **File Calendar** — 305-line local calendar with RFC 5545 ICS export, routes mounted at `/calendar/*`
- ✅ **Calendar Subscription** — `/calendar/subscribe` returns `webcal://` URL for iPhone
- ✅ **Cloudflare Tunnel** — Supports `cloudflared` and `localtunnel`, starts at boot for external ICS access
- ✅ **Google Calendar Integration** — Full OAuth2 flow, token persistence, Calendar API CRUD (needs OAuth credentials to activate)
- 🔴 **Microsoft Calendar** — All methods throw "Not implemented" — effectively dead code

### Communication Platforms

- ✅ **Discord Bot** — 577 lines, slash commands, session management, API integration
- ⚠️ **Signal Bot** — 348 lines, spawns `signal-cli`, but `startMessagePolling()` logs without polling; depends on external binary
- ✅ **Web Interface** — 580-line single-page app with chat, roadmaps, memory search
- ⚠️ **CLI** — 482-line Commander.js CLI exists but **not wired as executable in package.json**

### Productivity Features ⚠️ PARTIAL (routes mounted, recommendations are stubs)

- ⚠️ **Daily Planner** — `GET /productivity/daily-plan` calls real Jira for issue count but fills most fields with hardcoded values
- ⚠️ **Focus Blocks** — `GET /productivity/focus-blocks/recommend` returns 2 hardcoded placeholder items; `POST /productivity/focus-blocks` delegates to real `fileCalendarService.createFocusBlock()`
- ⚠️ **Health Breaks** — `GET /productivity/health-breaks/recommend` returns 3 hardcoded items; `POST /productivity/health-blocks` delegates to real `fileCalendarService.createHealthBlock()`
- ✅ **Calendar Summary** — `GET /productivity/calendar-summary` aggregates file calendar data

### Engineering Features ⚠️ PARTIAL (routes mounted, AI-first with stub fallbacks)

- ⚠️ **Workflow Brief** — `POST /engineering/workflow-brief` tries OpenCode API first; falls back to hardcoded stub
- ⚠️ **Architecture Planner** — `POST /engineering/architecture-proposal` tries OpenCode API first; falls back to hardcoded stub
- ⚠️ **Scaffold Planner** — `POST /engineering/scaffolding-plan` tries OpenCode API first; falls back to hardcoded stub
- ⚠️ **Jira Ticket Generator** — `POST /engineering/jira-tickets` uses OpenCode; `POST /engineering/jira-tickets/create` generates fake keys via `Math.random()` instead of calling Jira API

---

## Known Bugs

| #   | Bug                                                                | File                                         | Impact                                                | Fix Effort          |
| --- | ------------------------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------- | ------------------- |
| 1   | GitLab webhook HMAC uses `===` instead of `crypto.timingSafeEqual` | `src/integrations/gitlab/webhook-handler.ts` | Timing attack vulnerability + no payload verification | ~20 lines           |
| 2   | Auth middleware uses `!==` instead of `crypto.timingSafeEqual`     | `src/middleware/auth.ts:44`                  | Timing attack vulnerability                           | ~5 lines            |
| 3   | `guardrails/database.ts` is dead code (never imported)             | `src/guardrails/database.ts`                 | Guardrails state lost on restart                      | ~50 lines           |
| 4   | Audit logger `query()` returns `[]`                                | `src/audit/logger.ts:59-69`                  | Audit history endpoints return nothing                | ~40 lines           |
| 5   | CLI not wired as executable                                        | `package.json`                               | CLI unreachable from command line                     | 2 lines             |
| 6   | `jira-ticket-generator.createTickets()` uses `Math.random()`       | `src/engineering/jira-ticket-generator.ts`   | No actual Jira ticket creation                        | ~30 lines           |
| 7   | Microsoft integration is dead code                                 | `src/integrations/microsoft/`                | Throws on every method call                           | Remove or deprecate |

---

## Test Coverage (Honest Assessment)

### Automated Tests (`npm test` via Vitest)

| File                                                 | Status                                |
| ---------------------------------------------------- | ------------------------------------- |
| `tests/unit/policy/engine.test.ts`                   | 10 tests — pass                       |
| `tests/unit/agent/opencode-client.test.ts`           | 6 tests — pass (live API Integration) |
| `tests/unit/integrations/jira-client.test.ts`        | 9 tests — 1 failing (JQL 410 error)   |
| `tests/unit/integrations/jira-key-extractor.test.ts` | 20 tests — pass                       |

**Total: 45 tests, 44 passing, 1 failing (JQL deprecation)**

### Workflow Test Coverage: **0%**

No end-to-end workflow tests exist. The following critical paths have zero test coverage:

| Workflow                                                          | Tests |
| ----------------------------------------------------------------- | ----- |
| Chat → AI → tool call → response round-trip                       | 0     |
| Approval create → guard → approve → execute → audit               | 0     |
| ICS calendar: create event → export → subscribe                   | 0     |
| GitLab webhook → extract keys → policy → comment                  | 0     |
| Productivity: request plan → recommendations → create blocks      | 0     |
| Engineering: request brief → AI generation → Jira tickets         | 0     |
| Auth middleware: public paths bypass, protected paths require key | 0     |
| Calendar CRUD via REST API                                        | 0     |
| Roadmap CRUD via REST API                                         | 0     |
| Guardrails action registry enforcement                            | 0     |
| Conversation memory sessions, compaction, search                  | 0     |

---

## What's Genuinely MVP-Ready

These features have real, working implementations connected to the system:

1. Fastify HTTP server with CORS, static files, error handling, API key auth
2. Chat API — POST /chat, streaming, sessions, memory
3. OpenCode AI integration — real API calls, streaming, tool calling
4. Tool dispatcher — 10 real handlers (Jira, GitLab, Calendar, Daily Planner)
5. Policy Engine — pattern matching, 3-tier modes
6. Guardrails — 15 critical actions, rate limiting, REST API
7. Approval Queue — SQLite-persisted, action execution on approve
8. Roadmap system — SQLite-backed CRUD, templates, milestones
9. Jira integration — full REST API, CRUD, transitions
10. GitLab integration — REST API, webhooks (HMAC needs fix)
11. File Calendar — CRUD, ICS export, iPhone subscription via tunnel
12. Cloudflare tunnel — starts at boot for external access
13. Google Calendar OAuth2 — full flow, needs credentials
14. Discord bot — slash commands, sessions
15. Conversation memory — sessions, auto-compaction, persistence, search

---

## Priority Actions for MVP

### Immediate (Security Fixes)

1. Implement GitLab webhook `crypto.timingSafeEqual` HMAC verification
2. Implement auth middleware `crypto.timingSafeEqual` key comparison
3. Wire guardrails `database.ts` into `action-registry.ts` (persist across restarts)

### Short-term (Functional Gaps)

4. Implement audit logger `query()` method (SQLite or indexed file read)
5. Wire CLI as executable in package.json (`bin` field)
6. Replace `jira-ticket-generator.createTickets()` `Math.random()` with real Jira API create calls

### Medium-term (Replace Stubs with Real Logic)

7. Replace productivity "recommend" endpoints with OpenCode API-generated content
8. Replace engineering stub fallbacks with real AI-generated content
9. Remove or clearly deprecate Microsoft integration stubs
10. Fix or remove Signal bot polling

### Critical: Test Coverage

11. Write workflow tests for approval lifecycle
12. Write workflow tests for calendar CRUD + ICS export
13. Write workflow tests for chat → tool dispatch round-trip
14. Write unit tests for guardrails, memory, roadmap, auth middleware

---

## Feature Completeness (Revised)

| Area          | Previous Claim | Actual | Notes                                                                |
| ------------- | -------------- | ------ | -------------------------------------------------------------------- |
| Core Platform | 100%           | 95%    | Auth is timing-vulnerable, CLI not wired                             |
| Communication | 80%            | 65%    | CLI unwired, Signal polling broken                                   |
| Productivity  | 90%            | 50%    | Routes mounted, create endpoints work, recommend endpoints are stubs |
| Engineering   | 95%            | 40%    | Routes mounted, AI-first with stub fallbacks, createTickets is fake  |
| Security      | 100%           | 80%    | Auth timing-vulnerable, no HMAC on webhooks, audit query broken      |
| Calendar      | 0%             | 90%    | File calendar + ICS + tunnel all working; Google needs OAuth         |
| Test Coverage | 97%+           | ~5%    | 45 unit tests, 0 workflow tests, actual source coverage unmeasured   |
