# Architecture Overview

## System Design

OpenClaw Agent follows a **guarded agent architecture** with three core layers:

### 1. Interface Layer

- **OpenClaw**: Chat runtime and user interface (web, CLI, Discord, Signal)
- **Fastify Server**: HTTP API with `/chat`, `/approvals`, `/webhooks`, `/calendar`, `/productivity`, `/engineering` endpoints
- **Auth Middleware**: API key authentication with public path whitelist (Bearer token, X-API-Key header, or ?apiKey query param)
- **Tool Registry**: 15+ tools for each agent mode, dispatched via Tool Dispatcher

### 2. Guard Layer

- **Policy Engine**: Evaluates actions against policy rules (pattern matching, 3-tier modes)
- **Approval Queue**: SQLite-persisted approval management with execution dispatch (pending/approved/rejected/executed/failed)
- **Guardrails**: 15 critical action definitions, rate limiting, per-user history; ⚠️ in-memory Maps not yet integrated with SQLite database
- **Audit Logger**: Records all actions, decisions, and outcomes; ⚠️ `query()` returns empty array

### 3. Integration Layer

- **Jira Service**: Jira Cloud API integration (✅ real)
- **GitLab Service**: GitLab API and webhook handling (✅ real, ⚠️ HMAC is string comparison)
- **File Calendar**: Local calendar with RFC 5545 ICS export, iPhone subscription via tunnel (✅ real)
- **Google Calendar**: OAuth2 + Calendar API (✅ real, needs OAuth credentials)
- **OpenCode Client**: AI reasoning backend (✅ real)
- **Tool Dispatcher**: 10 real handlers dispatching to Jira, GitLab, Calendar, Daily Planner (✅ real)
- **Microsoft Calendar**: STUB — all methods throw "Not implemented"

## Request Flow

### Chat Request Flow

```
OpenClaw → Fastify (/chat) → Orchestrator → OpenCode API
                                    ↓
                              Policy Engine
                                    ↓
                         Allow / Approval / Block
                                    ↓
                        Execute / Queue Approval / Return Error
                                    ↓
                        Tool Dispatcher → Jira/GitLab/Calendar/etc.
```

### GitLab Webhook Flow

```
GitLab → Fastify (/webhooks/gitlab) → Webhook Handler
                                        ↓
                                  Extract Jira Keys
                                        ↓
                                Policy Engine Evaluation
                                        ↓
                           Auto-comment or Queue Approval
```

### Approval Flow

```
Action Proposed → Policy Engine → Approval Required → Add to Queue (SQLite)
                                                       ↓
                                               User Approves/Rejects
                                                       ↓
                                       dispatchToolCall() → Jira/GitLab/Calendar
                                                       ↓
                                       Log Result (executed/failed) + Audit Log
```

### Calendar Subscription Flow

```
User creates events → File Calendar (in-memory + ICS export)
                                        ↓
                              Cloudflare Tunnel (or localtunnel)
                                        ↓
                              iPhone subscribes via webcal:// URL
                                        ↓
                              Auto-refresh every 15 minutes (REFRESH-INTERVAL: PT15M)
```

## Component Architecture

### Agent Orchestrator

- Routes chat messages to appropriate mode (productivity/engineering)
- Invokes tools based on OpenCode API responses
- Handles approval requests and policy decisions

### Tool Dispatcher (`src/agent/tool-dispatcher.ts`)

Maps 10 tool names to real service handlers:

| Tool                               | Handler           | Service       |
| ---------------------------------- | ----------------- | ------------- |
| `calendar.list_events`             | listEvents        | File Calendar |
| `calendar.create_focus_block`      | createFocusBlock  | File Calendar |
| `calendar.create_health_block`     | createHealthBlock | File Calendar |
| `jira.list_assigned`               | getAssignedIssues | Jira Service  |
| `jira.get_issue`                   | getIssue          | Jira Service  |
| `jira.add_comment`                 | addComment        | Jira Service  |
| `jira.transition_issue`            | transitionIssue   | Jira Service  |
| `gitlab.list_merge_requests`       | getMergeRequests  | GitLab Client |
| `gitlab.get_commit`                | getCommit         | GitLab Client |
| `productivity.generate_daily_plan` | generatePlan      | Daily Planner |

Each handler checks feature flags (e.g., `ENABLE_CALENDAR_WRITE`, `ENABLE_JIRA_TRANSITIONS`).

### Policy Engine

- Pattern-based action matching (e.g., `jira.comment.create`)
- Risk classification (low/medium/high)
- Policy result determination (allow/approval-required/blocked)
- Mode-specific overrides (strict/balanced/permissive)

### Approval Queue

- **SQLite-backed persistence** — approval requests survive server restarts
- **Action execution** — `approve()` calls `dispatchToolCall()` which routes to real services
- **Status tracking** — pending → approved → executed/failed (with execution result stored)

### Audit Logger

- Structured logging of all system events
- File-based append-only log (`data/audit/audit.log`)
- **⚠️ `query()` returns `[]` — no read-back capability yet**

## Data Models

### Action

```typescript
{
  id: string;
  type: string; // e.g., "jira.comment.create"
  description: string;
  params: Record<string, unknown>;
  userId: string;
  timestamp: Date;
}
```

### Policy Decision

```typescript
{
  action: Action;
  result: 'allow' | 'approval_required' | 'blocked';
  riskLevel: 'low' | 'medium' | 'high';
  reason: string;
  applicablePolicy?: string;
}
```

### Approval Request

```typescript
{
  id: string;
  action: Action;
  decision: PolicyDecision;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  requestedAt: Date;
  respondedAt?: Date;
  responseBy?: string;
  executionResult?: ExecutionResult;
}
```

## Security Model

### Principle of Least Privilege

- Read-only actions: Automatic
- Destructive actions: Blocked by default
- External writes: Approval required

### Defense in Depth

1. **API Key Auth**: Bearer token / `X-API-Key` / query param (⚠️ uses `!==` not `timingSafeEqual`)
2. **Policy Engine**: Pre-execution check
3. **Approval Queue**: Human-in-the-loop for risky actions (✅ now dispatches on approve)
4. **Audit Logger**: Post-execution traceability (⚠️ `query()` not implemented)
5. **Environment Variables**: No hardcoded secrets
6. **Webhook Verification**: ⚠️ Uses `===` string comparison, not proper HMAC-SHA256
7. **Public Path Whitelist**: `/health`, `/auth/google/*`, `/calendar/export/ics`, `/calendar/subscribe`, `/webhooks/*`

### Risk Classification

- **Low**: Reading, drafting, planning
- **Medium**: Creating resources, posting comments
- **High**: Deleting, closing, moving meetings, bulk operations

## Scalability Considerations

### Current (MVP)

- Approval queue: SQLite persistence (✅ implemented)
- Guardrails state: In-memory Maps (⚠️ lost on restart, SQLite database exists but not integrated)
- Audit logging: File-based append-only (query not implemented)
- Single-instance deployment
- Stateless HTTP server with in-memory session state

### Future Enhancements

- Integrate guardrails `database.ts` into `action-registry.ts`
- Implement audit logger `query()` against SQLite
- PostgreSQL migration for multi-user scale
- Distributed approval queue (Redis)
- Structured logging (ELK/Loki)
- Horizontal scaling (Kubernetes)

## Technology Choices

### Why Fastify?

- High performance
- Built-in schema validation
- TypeScript support
- Low overhead

### Why TypeScript?

- Type safety
- Better developer experience
- Catch errors at compile time
- Self-documenting

### Why Policy-Based Architecture?

- Explicit guardrails
- Human control over risky actions
- Audit trail for compliance
- Extensible without code changes

### Why SQLite (better-sqlite3)?

- Embedded, no server process
- Atomic transactions
- Used by roadmap module (proven pattern)
- Approval queue now persists via SQLite

## Monitoring and Observability

### Health Checks

- `/health` endpoint
- Dependency status (Jira, GitLab, OpenCode)
- Configuration validation

### Logging

- Structured JSON logs
- Log levels: debug, info, warn, error
- Audit trail for all actions

### Metrics (Future)

- Request latency
- Approval queue depth
- Policy decision distribution
- Integration error rates

## Deployment Architecture

### Development

```bash
npm run dev          # Hot-reload with tsx
# Optionally with tunnel:
TUNNEL_ENABLED=true TUNNEL_PROVIDER=cloudflare TUNNEL_DOMAIN=tshelton.us npm run dev
```

### Production

```bash
docker-compose up -d  # Single container
```

### Tunnel Configuration

```bash
TUNNEL_ENABLED=true
TUNNEL_PROVIDER=cloudflare    # or localtunnel (default fallback)
TUNNEL_DOMAIN=tshelton.us     # Required for cloudflare
TUNNEL_SUBDOMAIN=cal          # Optional subdomain
```

### Future: Kubernetes

- Deployment: 2-3 replicas
- Service: Load balancer
- Ingress: TLS termination
- ConfigMap: Environment variables
- Secret: API tokens and keys
