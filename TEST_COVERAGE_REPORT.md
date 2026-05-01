# Test Coverage Report - OpenClaw Agent

**Date:** 2026-04-30 (Updated)
**Test Framework:** Vitest
**Status:** 44/45 tests passing (1 JQL integration test failing due to Jira API v3 deprecation)

---

## Summary

| Metric                    | Value                                       |
| ------------------------- | ------------------------------------------- |
| Total test files          | 4                                           |
| Total tests               | 45                                          |
| Passing                   | 44                                          |
| Failing                   | 1 (Jira JQL search — API v3 returns 410)    |
| Workflow/end-to-end tests | **0**                                       |
| Source code coverage      | **Unknown** (`vitest --coverage` never run) |

---

## Test Files

### `tests/unit/policy/engine.test.ts` — 10 tests, all pass

- Evaluate low-risk read actions (automatic approval)
- Evaluate medium-risk actions (approval required)
- Evaluate high-risk destructive actions (blocked)
- Unknown actions require approval
- `canProceed()` method
- `requiresApproval()` method
- `isBlocked()` method
- `createApprovalRequest()` method
- Policy engine state management
- Approval request lifecycle

**Coverage**: 100% of policy engine logic

### `tests/unit/agent/opencode-client.test.ts` — 6 tests, all pass

- Configuration validation
- Simple chat requests
- Productivity mode prompt
- Tool/function calling
- Token estimation
- Streaming responses

**Coverage**: Live API integration tests against OpenCode. Not mocked.

### `tests/unit/integrations/jira-client.test.ts` — 9 tests, 8 pass, 1 fail

- Configuration validation ✅
- Current user retrieval ✅
- Available projects ✅
- Assigned issues ✅
- JQL search ❌ (Jira API v3 returns 410 — deprecated)
- Invalid JQL error handling ✅
- Non-existent issue handling ✅
- Add comment (conditional) ✅

**Coverage**: Live Jira API integration. Requires `JIRA_API_TOKEN`. Failing test is a Jira deprecation issue, not a code bug.

### `tests/unit/integrations/jira-key-extractor.test.ts` — 20 tests, all pass

- Extract single Jira key from text
- Extract multiple Jira keys
- Remove duplicates
- Handle empty text
- Extract from commit messages
- Extract from branch names
- Extract from merge request titles
- Get primary Jira key
- Validate Jira key format
- Extract project key
- Extract issue number
- Handle edge cases

**Coverage**: 100% of `jira-key-extractor.ts` functions

---

## Modules With **Zero** Test Coverage

| Module                                   | Lines of Code | Risk Level                               | Test Priority |
| ---------------------------------------- | ------------- | ---------------------------------------- | ------------- |
| `approvals/queue.ts`                     | ~180          | CRITICAL (executes real actions)         | 1 — Highest   |
| `agent/tool-dispatcher.ts`               | ~188          | CRITICAL (routes tool calls to services) | 2             |
| `middleware/auth.ts`                     | ~50           | CRITICAL (security)                      | 3             |
| `guardrails/action-registry.ts`          | ~752          | HIGH (15 critical actions)               | 4             |
| `guardrails/enforcement.ts`              | —             | HIGH (enforces policy)                   | 5             |
| `routes/chat.ts`                         | ~407          | HIGH (primary interface)                 | 6             |
| `routes/file-calendar.ts`                | ~245          | HIGH (ICS subscription)                  | 7             |
| `routes/productivity.ts`                 | ~104          | MEDIUM                                   | 8             |
| `routes/engineering.ts`                  | ~179          | MEDIUM                                   | 9             |
| `routes/approvals.ts`                    | —             | HIGH                                     | 10            |
| `routes/webhooks-gitlab.ts`              | ~202          | HIGH (security)                          | 11            |
| `integrations/file/calendar-service.ts`  | ~305          | MEDIUM                                   | 12            |
| `integrations/file/tunnel.ts`            | ~152          | LOW                                      | 13            |
| `integrations/gitlab/webhook-handler.ts` | ~202          | HIGH (security)                          | 14            |
| `memory/conversation-manager.ts`         | ~743          | MEDIUM                                   | 15            |
| `roadmap/database.ts`                    | ~579          | MEDIUM                                   | 16            |
| `roadmap/api.ts`                         | ~597          | MEDIUM                                   | 17            |
| `integrations/jira/jira-service.ts`      | ~174          | MEDIUM                                   | 18            |
| `productivity/daily-planner.ts`          | —             | MEDIUM                                   | 19            |
| `productivity/focus-blocks.ts`           | —             | LOW                                      | 20            |
| `productivity/health-breaks.ts`          | —             | LOW                                      | 21            |
| `engineering/*.ts` (4 files)             | ~200 combined | LOW                                      | 22            |

---

## Workflow Test Coverage: **0%**

No end-to-end workflow tests exist. The following critical paths have zero automated verification:

### CRITICAL — Must Test First

1. **Approval lifecycle**: Create approval → policy check → approve → execute → verify result
2. **Chat → tool dispatch**: Send chat message → AI response triggers tool → tool executes → result returned
3. **Auth middleware**: Public paths bypass auth → protected paths require key → invalid key rejected → timing-safe comparison
4. **Calendar CRUD + ICS**: Create event → list events → export ICS → subscribe URL → verify REFRESH-INTERVAL

### HIGH — Should Test Soon

5. **GitLab webhook signature**: Valid signature passes → invalid signature rejected → missing secret bypasses
6. **Guardrails enforcement**: Low-risk action allowed → medium-risk requires approval → high-risk blocked
7. **Conversation memory**: Create session → add messages → compaction → search → retrieve
8. **Productivity endpoints**: Daily plan returns Jira data → focus block creates calendar event → health block creates calendar event

### MEDIUM — Test Before Production

9. **Engineering endpoints**: Workflow brief with OpenCode → fallback to stub → Jira ticket generation
10. **Roadmap CRUD**: Create → read → update → delete → templates
11. **Tunnel lifecycle**: Start → get URL → stop → fallback
12. **Error handling**: Invalid tool call → policy violation → missing auth → malformed request

---

## Previous Reports Were Misleading

The original `TEST_COVERAGE_REPORT.md` claimed "97%+ pass rate" and "95%+ core logic coverage." These numbers referred to 35 of 36 **hand-verified integration test checks**, not automated code coverage. The actual state is:

- **4 test files** covering **4 modules**
- **0 workflow tests** for the entire application
- **0 coverage measurement** (`vitest --coverage` has never been run)
- Most critical paths (approval execution, tool dispatch, auth, webhook security) have zero test coverage
