# Smoke Test Report - AI Assistant

**Test Date:** 2026-04-30 (Updated)
**Server:** http://localhost:3050
**Test Framework:** Vitest (automated), manual smoke tests (integration)

---

## Automated Test Results

| File                                                 | Tests  | Pass   | Fail  | Type                   |
| ---------------------------------------------------- | ------ | ------ | ----- | ---------------------- |
| `tests/unit/policy/engine.test.ts`                   | 10     | 10     | 0     | Unit                   |
| `tests/unit/agent/opencode-client.test.ts`           | 6      | 6      | 0     | Integration (live API) |
| `tests/unit/integrations/jira-client.test.ts`        | 9      | 8      | 1     | Integration (live API) |
| `tests/unit/integrations/jira-key-extractor.test.ts` | 20     | 20     | 0     | Unit                   |
| **Total**                                            | **45** | **44** | **1** |                        |

The 1 failing test is a Jira JQL search test where Jira API v3 returns HTTP 410 (deprecated). This is a Jira platform issue, not a code bug.

## Manual Smoke Test Results

These are not automated tests. They are verification steps performed manually.

### Core Server ✅

- Server starts on port 3050 without errors
- CORS enabled and working
- Static files served from `/web`
- Global error handler active

### Health Check ✅

```
GET /health → { "status": "ok", "version": "0.1.0" }
```

### Chat API ✅

- `POST /chat` returns AI responses with session management
- `POST /chat/stream` streams SSE responses
- Tool calling routes through `dispatchToolCall()` to real services

### Calendar + ICS ✅

- `GET /calendar/events` lists events
- `POST /calendar/events` creates events
- `GET /calendar/export/ics` returns RFC 5545 compliant ICS
- `GET /calendar/subscribe` returns `webcal://` URL for iPhone
- Cloudflare tunnel starts at boot when configured

### Productivity Endpoints ⚠️

- `GET /productivity/daily-plan` returns Jira data + hardcoded values
- `GET /productivity/focus-blocks/recommend` returns hardcoded stubs
- `POST /productivity/focus-blocks` creates real calendar events
- `GET /productivity/health-breaks/recommend` returns hardcoded stubs
- `POST /productivity/health-blocks` creates real calendar events

### Engineering Endpoints ⚠️

- `POST /engineering/workflow-brief` tries OpenCode API, falls back to stub
- `POST /engineering/jira-tickets/create` uses `Math.random()` for keys (not real Jira creation)

### Approval Queue ✅

- `GET /approvals` lists pending approvals
- `POST /approvals/:id/approve` now executes the action via `dispatchToolCall()`
- Status transitions: pending → approved → executed/failed
- SQLite persistence works across restarts

### Guardrails ⚠️

- `POST /api/guardrails/check` evaluates actions
- `GET /api/guardrails/stats` returns stats (from in-memory Maps, lost on restart)
- `GET /api/guardrails/history/:userId` returns action history (from in-memory Maps)

### Auth Middleware ✅

- Protected routes require `Authorization: Bearer <key>` or `X-API-Key` header
- Public paths bypass auth: `/health`, `/auth/google/*`, `/calendar/export/ics`, `/calendar/subscribe`, `/webhooks/*`
- ⚠️ Uses `!==` string comparison (timing attack vulnerability)

### Roadmap CRUD ✅

- Full create/read/update/delete via `/api/roadmaps`
- Templates at `/api/templates`
- SQLite-backed, works across restarts

### Google OAuth ✅ (requires credentials)

- OAuth flow initiates correctly
- Token persistence works
- Calendar CRUD functional with valid tokens

### Jira Integration ✅

- Connection to Jira Cloud works
- Issue CRUD, transitions, comments functional
- v2/v3 fallback works

### GitLab Integration ✅ (⚠️ HMAC)

- REST API access works
- Merge requests, commits, branches accessible
- Webhook endpoint receives payloads
- ⚠️ HMAC verification uses `===` instead of `timingSafeEqual`

### TypeScript Build ✅

- `npm run build` compiles cleanly
- Pre-existing unused variable warnings only (not from new code)

---

## Failing / Incomplete Items

| Item                    | Status       | Issue                                                      |
| ----------------------- | ------------ | ---------------------------------------------------------- |
| GitLab webhook HMAC     | ⚠️ Insecure  | Uses `===` string comparison, not `crypto.timingSafeEqual` |
| Auth key comparison     | ⚠️ Insecure  | Uses `!==` not `timingSafeEqual`                           |
| Guardrails persistence  | ⚠️ Data loss | `database.ts` is dead code, state lost on restart          |
| Audit logger query      | ❌ Broken    | `query()` returns `[]`                                     |
| Jira JQL search         | ❌ API issue | Jira API v3 returns 410 (deprecated)                       |
| CLI                     | ⚠️ Not wired | No `bin` in package.json                                   |
| Microsoft Calendar      | 🔴 Dead      | All methods throw "Not implemented"                        |
| Signal bot polling      | ⚠️ Broken    | Logs start but doesn't poll                                |
| Productivity recommends | ⚠️ Stub      | Return hardcoded data                                      |
| Engineering stubs       | ⚠️ Fallback  | OpenCode-first, hardcoded fallbacks                        |
| Jira ticket creation    | ⚠️ Fake      | `createTickets()` uses `Math.random()`                     |

---

## What's Actually Working (Ready to Use)

1. Chat API with streaming and tool dispatch
2. Approval queue with SQLite persistence and real execution
3. Calendar CRUD with ICS export and iPhone subscription
4. Jira full integration (CRUD, transitions, comments)
5. GitLab integration (REST API, webhooks)
6. Roadmap management (SQLite CRUD, templates)
7. Policy engine and guardrails enforcement
8. Conversation memory with compaction
9. OpenCode AI integration (chat, streaming, tools)
10. Discord bot with slash commands
11. Web UI (chat, roadmaps, memory)
12. Cloudflare tunnel for external ICS access

## What Needs Work Before Production

1. Replace `===` and `!==` with `crypto.timingSafeEqual` (auth + webhook)
2. Wire `guardrails/database.ts` into `action-registry.ts`
3. Implement audit logger `query()` method
4. Wire CLI as executable in package.json
5. Replace `Math.random()` in `jira-ticket-generator.createTickets()` with real Jira API
6. Remove or deprecate Microsoft integration stubs
7. Fix or remove Signal bot polling
8. Write workflow tests (approval lifecycle, calendar CRUD, auth, chat→tool)
