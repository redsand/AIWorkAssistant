# Roadmap

> **Last updated:** 2026-04-30. See [`GAP_AUDIT.md`](./GAP_AUDIT.md) for honest status of each module.

## Version 0.1.0 (Current — Late Alpha)

### ✅ Completed (Genuinely Working)

- [x] Project scaffold and Fastify HTTP server
- [x] Zod-validated environment configuration
- [x] Policy engine with pattern matching and 3-tier modes
- [x] Approval queue with SQLite persistence and action execution via tool dispatcher
- [x] Audit logging (write path only; `query()` returns empty)
- [x] OpenCode API client with chat, streaming, tool calling (321 lines)
- [x] Conversation memory with auto-compaction and file persistence (743 lines)
- [x] Tool registry with 15+ tools for productivity and engineering modes
- [x] Tool dispatcher with 10 real handlers (Jira, GitLab, Calendar, Daily Planner)
- [x] Guardrails system with 15 critical actions, rate limiting, REST API (752 lines)
- [x] Jira REST API client — full CRUD, v2/v3 fallback (529 lines)
- [x] GitLab REST API client and webhook handler (346 + 202 lines)
- [x] Roadmap management — SQLite CRUD, templates, milestones (579 + 597 lines)
- [x] Google Calendar OAuth2 flow and Calendar API integration
- [x] File-based calendar service with RFC 5545 ICS export (305 lines)
- [x] Calendar routes mounted with full CRUD + ICS + subscription endpoints
- [x] Cloudflare tunnel and localtunnel support for iPhone ICS subscription
- [x] Discord bot with slash commands (577 lines)
- [x] API key authentication middleware with public path whitelist
- [x] Health check endpoint
- [x] Web UI — chat interface, roadmap listing, memory search (580 lines)
- [x] CLI tool using Commander.js (482 lines)
- [x] Jira key extraction from GitLab data
- [x] Docker and docker-compose configuration
- [x] SSL/TLS and nginx reverse proxy configs
- [x] Productivity routes mounted (daily-plan, focus-blocks, health-breaks, calendar-summary)
- [x] Engineering routes mounted (workflow-brief, architecture, scaffolding, jira-tickets)

### ⚠️ Partially Complete (Needs Work)

- [ ] Guardrails persistence — `database.ts` exists (205 lines) but is dead code; `action-registry.ts` uses in-memory Maps; state lost on restart
- [ ] Audit logger query — `query()` returns empty array (TODO)
- [ ] Productivity "recommend" endpoints — return hardcoded stubs; "create" endpoints delegate to real calendar
- [ ] Engineering module fallbacks — AI-first routing works, but `.generate()` stubs return hardcoded data
- [ ] Daily planner — calls real Jira for assigned issue count but fills most fields with hardcoded values
- [ ] Signal bot — spawns `signal-cli` but polling doesn't actually work; depends on external binary
- [ ] CLI — exists but not wired as executable in `package.json`
- [ ] Auth middleware — works but uses `!==` instead of `crypto.timingSafeEqual` (timing attack vulnerability)

### 🔴 Known Bugs / Security Issues

- [ ] GitLab webhook signature verification uses `===` instead of `crypto.timingSafeEqual` (timing attack + no payload verification)
- [ ] Auth middleware key comparison uses `!==` instead of `crypto.timingSafeEqual` (timing attack)
- [ ] Guardrails `database.ts` is dead code — never imported, state lost on restart
- [ ] Audit logger `query()` returns `[]` — no read-back capability
- [ ] `jira-ticket-generator.createTickets()` uses `Math.random()` for keys instead of calling Jira API
- [ ] Microsoft Graph client — all methods throw "Not implemented" (dead code)

### 🔴 Stub / Placeholder (Returns Hardcoded Data)

- [ ] Focus blocks `recommendFocusBlocks()` — returns hardcoded stub items
- [ ] Health breaks `recommendBreakes()` — returns hardcoded stub items
- [ ] Workflow brief `.generate()` — returns static object
- [ ] Architecture planner `.generate()` — returns static tech stack
- [ ] Scaffold planner `.generate()` — returns static directory structure
- [ ] Jira ticket generator `.generate()` — returns plan as-is

---

## Version 0.2.0 — Security & Persistence (Target: 1 week)

### Security Fixes

- [ ] Implement `crypto.timingSafeEqual` for GitLab webhook HMAC verification
- [ ] Implement `crypto.timingSafeEqual` for auth middleware key comparison
- [ ] Add payload verification to GitLab webhook handler (currently ignores body)

### Persistence

- [ ] Wire `guardrails/database.ts` into `action-registry.ts` (replace in-memory Maps)
- [ ] Implement audit logger `query()` method against SQLite

### Cleanup

- [ ] Wire CLI as executable (`bin` field in package.json)
- [ ] Remove or clearly deprecate Microsoft integration stubs
- [ ] Replace `Math.random()` in `jira-ticket-generator.createTickets()` with real Jira API calls

### Test Coverage (Critical)

- [ ] Write workflow tests for approval lifecycle (create → guard → approve → execute → audit)
- [ ] Write workflow tests for calendar CRUD + ICS export
- [ ] Write workflow tests for auth middleware (public bypass, key required, timing-safe)
- [ ] Write workflow tests for GitLab webhook (signature verification)
- [ ] Write unit tests for guardrails, memory, roadmap, tool dispatcher
- [ ] Run `vitest --coverage` and establish baseline

---

## Version 0.3.0 — Real Productivity (Target: 2-3 weeks after v0.2)

### Productivity Features (Replace Stubs with AI)

- [ ] Replace `recommendFocusBlocks()` with OpenCode API-generated recommendations
- [ ] Replace `recommendBreakes()` with OpenCode API-generated recommendations
- [ ] Replace daily planner hardcoded values with real Jira + GitLab + Calendar aggregation
- [ ] Daily planner should use actual GitLab activity, not `commits: 5`

### Engineering Features (Replace Stubs with AI)

- [ ] Workflow brief `.generate()` already has AI-first routing in routes; remove fallback stubs
- [ ] Architecture planner `.generate()` already has AI-first routing; remove fallback stubs
- [ ] Scaffold planner `.generate()` already has AI-first routing; remove fallback stubs
- [ ] Jira ticket generator — wire `createTickets()` to real Jira API

### Calendar

- [ ] Complete Google Calendar OAuth2 credential setup
- [ ] Verify iPhone Calendar sync end-to-end via ICS subscription
- [ ] Test focus block and health break creation via calendar

---

## Version 0.4.0 — Observability & Polish (Target: 2-3 weeks after v0.3)

### Monitoring

- [ ] Health check endpoint with dependency status (Jira, GitLab, OpenCode connectivity)
- [ ] Prometheus metrics endpoint
- [ ] Structured logging (JSON format)

### Security

- [ ] Rate limiting per user/IP on all endpoints
- [ ] Request validation middleware (JSON schema)
- [ ] Content Security Policy headers

### Web UI

- [ ] Markdown rendering in chat responses
- [ ] Approval queue management page
- [ ] Roadmap detail view with milestones
- [ ] Memory browser with search
- [ ] Mobile responsive improvements

---

## Version 0.5.0 — Communication & Scale (Target: After v0.4)

### Communication

- [ ] Fix or remove Signal bot polling mechanism
- [ ] Evaluate Mattermost integration (if needed)

### Performance

- [ ] Redis caching layer
- [ ] Database query optimization
- [ ] Horizontal scaling considerations

### Advanced Features

- [ ] Multi-user support
- [ ] Per-project policy overrides
- [ ] Scheduled / recurring tasks
- [ ] Notification system (email, push)

---

## Version 1.0.0 — Production Ready

- [ ] Load testing and performance benchmarks
- [ ] Security audit (especially auth + webhook verification)
- [ ] API documentation (OpenAPI/Swagger)
- [ ] Deployment runbook
- [ ] Incident response procedures
- [ ] 90%+ workflow test coverage

---

## Completed Items from Previous Roadmap

| Previous Item                   | Status     | Notes                                                        |
| ------------------------------- | ---------- | ------------------------------------------------------------ |
| OpenCode API integration        | ✅ Done    | 321-line client with streaming + tool dispatcher             |
| Jira REST API client            | ✅ Done    | 529-line client with v2/v3 fallback                          |
| GitLab API client               | ✅ Done    | 346-line client + webhook handler                            |
| Google Calendar integration     | ✅ Done    | OAuth2 + Calendar API                                        |
| File Calendar + ICS             | ✅ Done    | RFC 5545, iPhone subscription, Cloudflare tunnel             |
| Tool dispatcher                 | ✅ Done    | 10 real handlers to Jira, GitLab, Calendar, Daily Planner    |
| Approval execution              | ✅ Done    | SQLite-persisted, dispatches via tool dispatcher             |
| API key authentication          | ✅ Done    | Bearer / X-API-Key / query param, public path whitelist      |
| Streaming responses             | ✅ Done    | SSE chat streaming                                           |
| Tool calling support            | ✅ Done    | 15+ tools registered                                         |
| Context management              | ✅ Done    | Session + memory system                                      |
| Database persistence            | ⚠️ Partial | Roadmap and approvals use SQLite; guardrails still in-memory |
| Microsoft Graph / Calendar      | 🔴 Dead    | All methods throw; project pivoted to Google Calendar        |
| Daily planning logic            | ⚠️ Partial | Routes mounted, Jira data + stub fill                        |
| Engineering strategy generation | ⚠️ Partial | Routes mounted, AI-first with stub fallbacks                 |
