# Gap Audit: Documentation vs Code Reality

**Audit Date:** 2026-04-30 (Updated)
**Original Audit:** 2026-04-30
**Project:** AI Assistant v0.1.0

---

## Executive Summary

Previous audit identified 5 critical bugs. **3 of 5 have been fixed.** The project has progressed significantly since the original audit — routes are now mounted, approval execution is wired, and several modules are functional. However, **workflow test coverage remains at 0%** and two security vulnerabilities persist (auth timing, webhook HMAC).

**Overall Assessment:** The project is at a solid alpha stage with real integrations working (Jira, GitLab, Calendar/ICS, Tool Dispatcher, Approval execution). The main gaps are: (1) no end-to-end workflow tests, (2) two security issues, (3) guardrails state not persisted to SQLite, (4) audit logger query not implemented, and (5) productivity "recommend" endpoints still return hardcoded data.

---

## CRITICAL BUGS — Status Update

### 1. ~~`file-calendar` routes not mounted in server~~ ✅ FIXED

- **Previous:** `fileCalendarRoutes` imported but never registered with `server.register()`
- **Current:** Line 49 of `server.ts` — `await server.register(fileCalendarRoutes);` — **mounted and working**
- **Verification:** All `/calendar/*` endpoints are listed in the startup banner and respond to requests

### 2. ~~Approval execution never dispatches~~ ✅ FIXED

- **Previous:** `src/routes/approvals.ts:81` had `// TODO: Execute the approved action`
- **Current:** `src/approvals/queue.ts:133-152` — `approve()` calls `dispatchToolCall()` which routes to real services (Jira, GitLab, Calendar, Daily Planner). Status updates to `executed` or `failed` with `executionResult` stored.
- **Verification:** Approval queue now has SQLite persistence and real execution

### 3. GitLab webhook signature verification is insecure 🔴 STILL OPEN

- **File:** `src/integrations/gitlab/webhook-handler.ts:26` — uses `===` simple string comparison
- **Impact:** Anyone can send forged GitLab webhooks. No payload verification. `body` parameter is accepted but ignored.
- **Fix:** Implement `crypto.timingSafeEqual` with HMAC-SHA256

### 4. CLI not wired as executable 🔴 STILL OPEN

- **File:** `package.json` has no `bin` entry
- **Impact:** CLI is only reachable via `npm run cli`, not as a system command
- **Fix:** Add `"bin": { "ai-assistant": "./dist/cli/cli.js" }` and `"cli"` script

### 5. Audit Logger query returns empty array 🔴 STILL OPEN

- **File:** `src/audit/logger.ts:59-69` — `query()` has TODO, returns `[]`
- **Impact:** Audit trail can be written but never retrieved
- **Fix:** Implement SQLite-backed query or indexed file read

### 6. NEW: Auth middleware timing attack vulnerability 🔴 NEW

- **File:** `src/middleware/auth.ts:44` — uses `!==` instead of `crypto.timingSafeEqual`
- **Impact:** Key comparison vulnerable to timing attacks
- **Fix:** Replace with `crypto.timingSafeEqual`

### 7. NEW: Guardrails database.ts is dead code 🔴 NEW

- **File:** `src/guardrails/database.ts` — 205 lines of SQLite CRUD that is never imported by `action-registry.ts`
- **Impact:** Guardrails state (action history, pending approvals, execution times) stored in in-memory Maps, lost on restart
- **Fix:** Wire `guardrailsDatabase` into `ActionRegistry` class

---

## MODULE-BY-MODULE REALITY CHECK (Updated)

| Module                                  | Previous Status           | Current Status            | Change                                                                      |
| --------------------------------------- | ------------------------- | ------------------------- | --------------------------------------------------------------------------- |
| `config/`                               | ✅ REAL                   | ✅ REAL                   | No change                                                                   |
| `agent/`                                | ✅ REAL                   | ✅ REAL + tool-dispatcher | Added 10 real tool handlers                                                 |
| `policy/`                               | ✅ REAL                   | ✅ REAL                   | No change                                                                   |
| `approvals/`                            | ⚠️ PARTIAL (no execution) | ✅ REAL                   | Now dispatches via `dispatchToolCall()`, SQLite persistence                 |
| `audit/`                                | ⚠️ PARTIAL (query=[])     | ⚠️ PARTIAL (query=[])     | Still broken                                                                |
| `guardrails/`                           | ✅ REAL                   | ⚠️ PARTIAL                | Real enforcement but `database.ts` is dead code, state lost on restart      |
| `memory/`                               | ✅ REAL                   | ✅ REAL                   | No change                                                                   |
| `roadmap/`                              | ✅ REAL                   | ✅ REAL                   | No change                                                                   |
| `routes/chat.ts`                        | ✅ REAL                   | ✅ REAL                   | Added `dispatchToolCall` integration                                        |
| `routes/file-calendar.ts`               | 🔴 BUG (not mounted)      | ✅ REAL                   | Now mounted, all endpoints functional                                       |
| `routes/productivity.ts`                | —                         | ⚠️ PARTIAL                | New route file, "recommend" endpoints return stubs, "create" endpoints work |
| `routes/engineering.ts`                 | —                         | ⚠️ PARTIAL                | New route file, AI-first with stub fallbacks                                |
| `routes/approvals.ts`                   | ⚠️ BUG (no execution)     | ✅ REAL                   | Execution now dispatched                                                    |
| `routes/webhooks-gitlab.ts`             | ⚠️ BUG (no HMAC)          | ⚠️ BUG (no HMAC)          | Still insecure                                                              |
| `routes/google-oauth.ts`                | ✅ REAL                   | ✅ REAL                   | No change                                                                   |
| `routes/health.ts`                      | ✅ REAL                   | ✅ REAL                   | No change                                                                   |
| `middleware/auth.ts`                    | —                         | ⚠️ NEW                    | API key auth with timing vulnerability                                      |
| `agent/tool-dispatcher.ts`              | —                         | ✅ NEW                    | 10 real tool handlers                                                       |
| `integrations/file/tunnel.ts`           | —                         | ✅ NEW                    | Cloudflare + localtunnel support                                            |
| `integrations/jira/`                    | ✅ REAL                   | ✅ REAL                   | No change                                                                   |
| `integrations/gitlab/`                  | ⚠️ BUG (no HMAC)          | ⚠️ BUG (no HMAC)          | Still insecure                                                              |
| `integrations/google/`                  | ✅ REAL                   | ✅ REAL                   | No change                                                                   |
| `integrations/microsoft/`               | 🔴 STUB                   | 🔴 STUB                   | Still all methods throw                                                     |
| `integrations/discord/`                 | ✅ REAL                   | ✅ REAL                   | No change                                                                   |
| `integrations/signal/`                  | ⚠️ PARTIAL                | ⚠️ PARTIAL                | Polling still broken                                                        |
| `integrations/file/calendar-service.ts` | ✅ REAL (unreachable)     | ✅ REAL (reachable)       | Now reachable via mounted routes                                            |
| `productivity/`                         | 🔴 STUB                   | ⚠️ PARTIAL                | "Create" endpoints work; "recommend" endpoints still hardcoded              |
| `engineering/`                          | 🔴 STUB                   | ⚠️ PARTIAL                | Routes try OpenCode API first; stubs are fallbacks                          |
| `cli/`                                  | ⚠️ BUG (not wired)        | ⚠️ BUG (not wired)        | Still not in package.json bin                                               |

---

## TEST COVERAGE — Workflow Level

### What We Have (4 unit test files)

| File                                                 | Tests | Status                    |
| ---------------------------------------------------- | ----- | ------------------------- |
| `tests/unit/policy/engine.test.ts`                   | 10    | ✅ pass                   |
| `tests/unit/agent/opencode-client.test.ts`           | 6     | ✅ pass (live API)        |
| `tests/unit/integrations/jira-client.test.ts`        | 9     | ⚠️ 1 failing (JQL v3 410) |
| `tests/unit/integrations/jira-key-extractor.test.ts` | 20    | ✅ pass                   |

**Total: 45 tests, 44 passing, 1 failing**

### What We Need (0 workflow tests exist)

| Workflow                                               | Priority | Status  |
| ------------------------------------------------------ | -------- | ------- |
| Chat → AI → tool call → response                       | CRITICAL | 0 tests |
| Approval create → guard → approve → execute → audit    | CRITICAL | 0 tests |
| Calendar CRUD → ICS export → subscribe                 | HIGH     | 0 tests |
| Auth middleware (public bypass, protected require key) | HIGH     | 0 tests |
| GitLab webhook → extract keys → policy                 | HIGH     | 0 tests |
| Productivity: plan → recommendations → create blocks   | MEDIUM   | 0 tests |
| Engineering: brief → AI generation → Jira tickets      | MEDIUM   | 0 tests |
| Guardrails action registry enforcement                 | MEDIUM   | 0 tests |
| Conversation memory sessions + compaction              | MEDIUM   | 0 tests |
| Roadmap CRUD via REST API                              | LOW      | 0 tests |

---

## DOCUMENTATION vs REALITY GAPS (Remaining)

### PROJECT_STATUS.md — ✅ Updated in this revision

### README.md — Needs Update

| Section            | Issue                                           | Fix                                                           |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------- |
| "Approval Queue"   | Says "approved actions not yet executed"        | Update to "approved actions execute via dispatcher"           |
| "File Calendar"    | Says "routes not mounted — 404s"                | Update to "working, ICS export, iPhone subscription"          |
| "Daily Planner"    | Says "not in routes"                            | Update to "routes mounted, Jira data + stub fill"             |
| "Focus Blocks"     | Says "hardcoded, not in routes"                 | Update to "routes mounted, recommends are stub, create works" |
| "Health Breaks"    | Says "hardcoded + TS error"                     | Update to "routes mounted, recommends are stub, create works" |
| "Engineering Mode" | Says "not in routes"                            | Update to "routes mounted, AI-first with stub fallback"       |
| "Known Issues"     | Lists several that are now fixed                | Update to current bug list                                    |
| Architecture tree  | Missing `middleware/`, `guardrails/database.ts` | Update                                                        |
| "Security Notes"   | Says "Approval queue is in-memory only"         | Update to "Approval queue is SQLite-persisted"                |

### SMOKE_TEST_REPORT.md — Needs Update

| Claim                           | Reality                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------ |
| "37/41 tests passing (90%)"     | These are manual integration tests, not automated. 44/45 automated tests pass. |
| "File calendar routes 404"      | Now fixed — routes are mounted                                                 |
| "All major integrations tested" | No workflow tests exist for most integrations                                  |

### TEST_COVERAGE_REPORT.md — Needs Rewrite

| Claim                      | Reality                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| "97%+ pass rate"           | 44/45 tests pass (97.8%), but only 4 test files cover 4 modules       |
| "95%+ core logic coverage" | Actual code coverage unknown — `vitest --coverage` has never been run |
| Missing entirely           | No mention of 0 workflow tests, 0 coverage for most modules           |

### .env.example — Needs Update

Missing variables the code actually references:

- `TUNNEL_ENABLED`, `TUNNEL_PROVIDER`, `TUNNEL_DOMAIN`, `TUNNEL_SUBDOMAIN`
- `ENABLE_CALENDAR_WRITE`, `ENABLE_JIRA_TRANSITIONS`, `ENABLE_GITLAB_WEBHOOKS`

Extra variables for stub code:

- All `MICROSOFT_*` variables (integration is entirely stub)

---

## FILES THAT NEED DELETION OR DECOMMISSION

| File                                             | Action                                   | Reason                                                                   |
| ------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------ |
| `src/integrations/microsoft/graph-client.ts`     | Mark as STUB or remove                   | Every method throws                                                      |
| `src/integrations/microsoft/calendar-service.ts` | Mark as STUB or remove                   | Wraps throwing client                                                    |
| `src/guardrails/database.ts`                     | Wire into `action-registry.ts` or remove | Dead code — never imported                                               |
| `MISSING_FEATURES_ANALYSIS.md`                   | Archive or rewrite                       | Lists Mattermost/WhatsApp as priorities, project pivoted to ICS/calendar |

---

## PRIORITY ACTIONS (Updated)

### Immediate — Security (1-2 days)

1. Implement `crypto.timingSafeEqual` for GitLab webhook HMAC verification (~20 lines)
2. Implement `crypto.timingSafeEqual` for auth middleware key comparison (~5 lines)
3. Wire `guardrails/database.ts` into `action-registry.ts` so state survives restarts (~50 lines)

### Short-term — Functionality (2-3 days)

4. Implement audit logger `query()` method against SQLite (~40 lines)
5. Wire CLI as executable in package.json (2 lines)
6. Replace `jira-ticket-generator.createTickets()` `Math.random()` with real Jira API calls (~30 lines)
7. Remove or clearly deprecate Microsoft integration stubs

### Medium-term — Replace Stubs (1-2 weeks)

8. Replace productivity "recommend" endpoints with OpenCode API-generated content
9. Fix Signal bot polling or remove the feature
10. Update all documentation to match reality (this audit)

### Critical — Test Coverage (Ongoing)

11. Write workflow tests for approval lifecycle (CRUD + execute + audit)
12. Write workflow tests for calendar CRUD + ICS export + subscribe
13. Write workflow tests for chat → tool dispatch round-trip
14. Write unit tests for auth middleware, guardrails, memory, roadmap
15. Run `vitest --coverage` and establish baseline
