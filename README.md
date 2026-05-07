# AIWorkAssistant

A personal productivity and engineering agent for CTOs and engineering leaders. Aggregates calendar, Jira, GitLab, GitHub, Jitbit, and HAWK IR into actionable daily briefs, code reviews, product signals, and work tracking — all behind a guardrails system that prevents destructive actions without approval.

**Status:** v0.2.0 — Multi-provider AI with robust agent loop, 267+ tool handlers, full GitHub/GitLab/Jira/Jitbit/HAWK IR CRUD, streaming chat, auto-compaction, push notifications, and comprehensive test coverage.

## Overview

AIWorkAssistant is a personal productivity and engineering copilot that helps you:

- **Personal Productivity** — Plan your day, protect focus/fitness/mental-health time, manage Jira tickets, and connect GitLab/GitHub activity to Jira work
- **CTO Daily Command Center** — Aggregated daily brief from 8+ integration sources with suggested actions
- **Personal OS Brief** — Load assessment, open loops, pattern detection, delegation suggestions, focus blocks
- **Product Chief of Staff** — Customer signals, workflow briefs, roadmap proposals, drift analysis, weekly updates
- **Code Review** — AI-powered GitHub PR and GitLab MR review with risk scoring and release readiness
- **Engineering Strategy** — Convert vague app ideas into workflow-first designs with architecture, scaffolding, and Jira tickets
- **HAWK IR Integration** — Full case management, log search, asset/identity tracking, quarantine, and hybrid tool execution
- **Work Items** — Internal task tracking with types, statuses, linked resources, and notes
- **Push Notifications** — Real-time alerts for HAWK IR cases and Jitbit tickets with escalation tiers

**Core Philosophy**: Design from workflows. Scaffold from architecture. Implement with guardrails. Iterate from evidence.

### Capabilities Page

Visit **`/capabilities`** in the web UI to browse all available agents, tool categories, and individual tools with descriptions, risk levels, and parameter signatures.

## What Works Now

| Feature | Status | Notes |
|---------|--------|-------|
| Chat API | ✅ Real | Streaming, sessions, memory, tool calling, thinking display, multi-step agent loop |
| Multi-Provider AI | ✅ Real | Ollama, Z.ai, OpenCode with retry/rate-limit handling |
| Agent Loop | ✅ Real | History accumulation, loop guard, system prompts, JSON protection |
| Dynamic Tools | ✅ Real | Core set + `discover_tools` for on-demand expansion (267+ tools) |
| Tool Dispatcher | ✅ Real | 100+ handlers: Jira, GitLab, GitHub, Calendar, Jira, Roadmap, Engineering, HAWK IR |
| Engineering Tools | ✅ Real | Workflow brief, architecture proposal, scaffolding plan, Jira ticket generation |
| Policy Engine | ✅ Real | Pattern matching, 3-tier modes |
| Guardrails | ✅ Real | 18+ critical actions, rate limiting, MFA, dry-run, REST API |
| Approval Queue | ✅ Real | SQLite-persisted, dispatches approved actions via dispatcher |
| Jira Integration | ✅ Real | Full CRUD, v2/v3 fallback, comments, transitions, list projects |
| GitLab Integration | ✅ Real | REST API with retry, commits, MRs, files, pipelines, issues, branches, tags, blame, compare, webhooks |
| GitHub Integration | ✅ Real | Repos, files, branches, PRs, issues, workflows, releases, tags, commits, blame, compare, code search |
| Jitbit Integration | ✅ Real | 21 tools: ticket lifecycle, assets CRUD, custom fields, tags, time tracking, automation, comments, companies, users, snapshots |
| HAWK IR Integration | ✅ Real | 37 tools: cases, assets, identities, logs, search, escalation, quarantine, hybrid tool execution, weekly/monthly reports |
| File Calendar + ICS | ✅ Real | CRUD, RFC 5545 ICS export, iPhone subscription via tunnel |
| Cloudflare Tunnel | ✅ Real | Starts at boot for external ICS access |
| Google Calendar | ✅ Real | OAuth2 + Calendar API |
| Conversation Memory | ✅ Real | LLM-based auto-compaction, file persistence, search, metadata preservation |
| Entity Memory | ✅ Real | People, organizations, projects with facts and relationships |
| Audit Logger | ✅ Real | Write + query with severity filtering and JSONL storage |
| Roadmap CRUD | ✅ Real | SQLite-backed CRUD + milestones + items + delete + templates |
| Work Items | ✅ Real | Full CRUD, 10 types, 7 statuses, linked resources, notes, stats |
| Agent Runs | ✅ Real | SQLite-backed tracing with secret redaction, step timelines, staleness detection |
| CTO Daily Command Center | ✅ Real | Daily brief from calendar, Jira, GitLab, GitHub, roadmap, work items, Jitbit, HAWK IR, memory |
| Personal OS Brief | ✅ Real | Load, open loops, decisions, patterns, delegations, focus blocks, energy risks |
| Product Chief of Staff | ✅ Real | Workflow briefs, roadmap proposals, drift analysis, customer signals, weekly updates |
| Code Review Agent | ✅ Real | AI-powered PR/MR review (risk, must-fix, security, migration) + release readiness |
| Push Notifications | ✅ Real | Web Push with VAPID, HAWK IR + Jitbit polling, deduplication, 3-tier escalation |
| Ticket Bridge | ✅ Real | GitHub/Jira/Roadmap → prompt generation → agent execution → result posting → work item linking |
| Web UI | ✅ Real | Chat, tool progress, collapsible JSON, export, stop button, sidebar, Agent Runs inspector |
| Daily Planner | ✅ Real | Jira + GitLab data wired, real issue counts and activity |
| Discord Bot | ✅ Real | Slash commands, sessions, API integration |
| Health Endpoints | ✅ Real | `/health` reports GitHub/GitLab/Jira status; `/chat/health` reports AI provider |

## Architecture

```
Integrations                Services                     API Routes              Tools
───────────                 ────────                     ──────────              ─────
Jira Cloud ─┐               CTO Command Center ──────── /api/cto              cto.*
GitLab ─────┤               Personal OS ────────────── /api/personal-os      personal_os.*
GitHub ─────┤               Product Chief of Staff ─── /api/product          product.*
Jitbit ─────┼───► Services  Code Review ───────────── /api/code-review      code_review.*
HAWK IR ────┤               Guardrails ────────────── /api/guardrails       (policy gates)
Calendar ───┤               Agent Runs ────────────── /api/agent-runs       (tracing)
Memory ─────┘               Work Items ────────────── /api/work-items       work_items.*
                            Ticket Bridge ────────── /api/ticket-bridge    ticket_bridge.*
                            Push / Polling ────────── /api/push-*           (notifications)
                            Memory / Entities ─────── /api/memory           memory.*
                            Roadmap ───────────────── /api/roadmaps         roadmap.*
                            Approvals ────────────── /approvals             (approval flow)
```

```
src/
├── config/                # Environment, constants, policy rules
├── agent/
│   ├── providers/          # AI providers (Ollama, Z.ai, OpenCode)
│   │   ├── types.ts         # Shared interfaces
│   │   ├── factory.ts       # Provider factory (switches on AI_PROVIDER env)
│   │   ├── ollama-provider.ts
│   │   ├── zai-provider.ts
│   │   └── opencode-provider.ts
│   ├── opencode-client.ts   # Provider facade
│   ├── tool-registry.ts     # 267+ tools with core set + discover_tools
│   ├── tool-dispatcher.ts   # Tool execution with audit logging
│   └── prompts.ts           # System prompts
├── policy/                 # Policy engine with pattern matching
├── approvals/              # Approval queue (SQLite)
├── audit/                  # Audit logger (JSONL)
├── guardrails/             # Action registry, enforcement, REST API
├── memory/                 # Conversation manager + entity memory
├── roadmap/                # SQLite-backed CRUD, milestones, templates
├── work-items/             # Internal task tracking (SQLite)
├── agent-runs/             # Run tracing with secret redaction (SQLite)
├── cto/                    # CTO Daily Command Center
├── personal-os/            # Personal OS brief generator
├── product/                # Product Chief of Staff
├── code-review/            # Review assistant (GitHub PR, GitLab MR)
├── push/                   # Push notifications + polling + escalation
├── integrations/
│   ├── jira/               # Jira Cloud REST API (v2/v3)
│   ├── gitlab/             # GitLab API with retry + webhooks
│   ├── github/             # GitHub REST API with retry
│   ├── jitbit/             # Jitbit Helpdesk API (full lifecycle)
│   ├── hawk-ir/            # HAWK IR REST + WebSocket (cases, search, quarantine)
│   ├── ticket-bridge/      # Ticket-to-prompt → agent → result → work item
│   ├── google/             # Google Calendar OAuth2 + Calendar API
│   ├── discord/            # Discord bot with slash commands
│   └── file/               # File-based calendar + ICS export + tunnel
├── engineering/            # Workflow brief, architecture, scaffold, Jira tickets
├── productivity/           # Daily planner, focus blocks, health breaks, weekly plan
├── routes/                 # HTTP endpoints
├── middleware/              # Auth middleware (provider-agnostic)
└── server.ts               # Fastify entry point
```

## Integrations

| Integration | Config Required | Features |
|-------------|-----------------|----------|
| Jira Cloud | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEYS` | Full CRUD, comments, transitions, project listing |
| GitLab | `GITLAB_BASE_URL`, `GITLAB_TOKEN`, `GITLAB_DEFAULT_PROJECT` | Projects, MRs, commits, files, pipelines, branches, tags, blame, compare, webhooks |
| GitHub | `GITHUB_TOKEN`, `GITHUB_DEFAULT_OWNER`, `GITHUB_DEFAULT_REPO` | Repos, files, branches, PRs, issues, workflows, releases, tags, code search |
| Jitbit | `JITBIT_ENABLED`, `JITBIT_BASE_URL`, `JITBIT_API_TOKEN`, `JITBIT_DEFAULT_CATEGORY_ID` | Ticket lifecycle, assets, custom fields, tags, time tracking, automation, customer snapshots |
| HAWK IR | `HAWK_IR_ENABLED`, `HAWK_IR_BASE_URL`, `HAWK_IR_ACCESS_TOKEN`, `HAWK_IR_SECRET_KEY` | Cases, assets, identities, log search, escalation, quarantine, hybrid tools, weekly/monthly reports |
| Google Calendar | `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_CALENDAR_ID` | OAuth2 + Calendar API |
| Discord | `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID` | Slash commands, sessions |

## Agents / Helpers

| Agent / Helper | API Endpoint | What It Does |
|----------------|-------------|--------------|
| CTO Daily Command Center | `GET /api/cto/daily-command-center` | Aggregates calendar, Jira, GitLab, GitHub, roadmap, work items, Jitbit, HAWK IR, memory into a daily brief with suggested actions |
| Personal OS Brief | `GET /api/personal-os/brief` | Load assessment, open loops, decisions, recurring patterns, delegation suggestions, focus blocks, energy risks |
| Product Chief of Staff | `POST /api/product/workflow-brief` | Workflow briefs, roadmap proposals, drift analysis, customer signals, weekly updates |
| Code Review | `POST /api/code-review/github/pr` | AI-powered PR/MR review with risk scoring, security analysis, release readiness |
| Ticket Bridge | `POST /api/ticket-bridge/prompt` | Converts GitHub/Jira/Roadmap issues into AI prompts, runs agents, posts results |
| Engineering | `POST /engineering/workflow-brief` | Workflow brief, architecture proposal, scaffolding plan, Jira ticket generation |
| Daily Planner | `GET /productivity/daily-plan` | Jira + GitLab aggregated daily plan |
| Weekly Plan | `GET /productivity/weekly-plan` | Weekly planning across integrations |

See [docs/agents.md](docs/agents.md) for detailed documentation on each agent.

## AI Providers

| Provider | Config | Notes |
|----------|--------|-------|
| Ollama | `AI_PROVIDER=ollama` | Local or cloud models. Synthesizes tool call IDs when API omits them. |
| Z.ai | `AI_PROVIDER=zai` | GLM models. Retry + rate-limit handling with Retry-After header. Chunked streaming. |
| OpenCode | `AI_PROVIDER=opencode` (default) | OpenCode API with exponential backoff retry. |

All providers support:
- Automatic retry with exponential backoff (429 rate limits handled separately from server errors)
- Tool calling with dynamic expansion (core set sent first, more loaded on demand)
- Thinking/reasoning content extraction and display
- Streaming SSE responses with tool progress indicators
- `toolChoice: "auto"` — the AI decides when to call tools

## API Endpoints

### Chat

```
POST   /chat                         # Send a message
POST   /chat/stream                   # Stream a response (SSE)
GET    /chat/health                   # AI provider + integration health
GET    /chat/sessions                 # List sessions
POST   /chat/sessions                 # Create session
GET    /chat/sessions/:id             # Get session
POST   /chat/sessions/:id/end        # End session
GET    /chat/sessions/:id/messages    # Get messages
DELETE /chat/sessions/:id            # Delete session
POST   /chat/sessions/:id/cancel     # Cancel running session
GET    /chat/memory/search            # Search memories
POST   /chat/memory/relevant         # Get relevant memories
GET    /chat/memory/stats             # Memory statistics
GET    /chat/tools                    # List available tools
GET    /chat/todos                    # List todos
GET    /chat/knowledge/search         # Search knowledge base
GET    /chat/knowledge/recent         # Recent knowledge
GET    /chat/knowledge/stats           # Knowledge statistics
GET    /chat/codebase/search          # Search codebase index
GET    /chat/codebase/stats            # Codebase index stats
GET    /chat/graph/summary            # Knowledge graph summary
GET    /chat/graph/nodes              # Graph nodes
GET    /chat/graph/nodes/:nodeId      # Get graph node
```

### CTO Command Center

```
GET    /api/cto/daily-command-center              # Generate daily brief
POST   /api/cto/daily-command-center/create-work-items  # Create suggested work items
```

### Personal OS

```
GET    /api/personal-os/brief          # Generate Personal OS brief
GET    /api/personal-os/open-loops     # Summarize open loops
GET    /api/personal-os/patterns       # Detect recurring patterns
POST   /api/personal-os/work-items     # Create work items from brief
```

### Product Chief of Staff

```
POST   /api/product/workflow-brief     # Turn idea into workflow brief
POST   /api/product/roadmap-proposal   # Generate roadmap proposal
GET    /api/product/roadmap-drift      # Analyze roadmap drift
GET    /api/product/customer-signals   # Extract customer signals from Jitbit
POST   /api/product/weekly-update      # Generate weekly product update
POST   /api/product/work-items         # Create work items from proposals
```

### Code Review

```
POST   /api/code-review/github/pr          # Review a GitHub PR
POST   /api/code-review/gitlab/mr          # Review a GitLab MR
POST   /api/code-review/release-readiness  # Generate release readiness report
```

### Work Items

```
GET    /api/work-items               # List (filter: status, type, priority, source, owner, search)
POST   /api/work-items               # Create
GET    /api/work-items/stats          # Counts by status/type/priority
GET    /api/work-items/:id           # Get
PATCH  /api/work-items/:id           # Update
POST   /api/work-items/:id/notes     # Add note
POST   /api/work-items/:id/links     # Add linked resource
POST   /api/work-items/:id/complete  # Mark done
POST   /api/work-items/:id/archive   # Archive
```

### Agent Runs

```
GET    /api/agent-runs                # List (filter: status, userId, limit, offset)
GET    /api/agent-runs/stats          # Aggregate statistics
GET    /api/agent-runs/:id            # Get run with steps
GET    /api/agent-runs/:id/steps      # Get steps for a run
```

### HAWK IR

37 tools exposed via the chat/tool system (not standalone REST routes). Core tools include `hawk_ir.get_cases`, `hawk_ir.get_case`, `hawk_ir.search_logs`, `hawk_ir.escalate_case`, `hawk_ir.quarantine_host`. Additional tools for assets, identities, dashboards, saved searches, and hybrid tool execution available via `discover_tools('hawk_ir')`.

### Jitbit

21 tools exposed via the chat/tool system (not standalone REST routes). Core tools include `jitbit.search_tickets`, `jitbit.get_ticket`, `jitbit.create_ticket`, `jitbit.close_ticket`, `jitbit.assign_ticket`, `jitbit.list_assets`. Additional tools for merges, forwarding, asset management, tags, time tracking, and automation available via `discover_tools('jitbit')`.

### Ticket Bridge

```
POST   /api/ticket-bridge/prompt     # Generate implementation prompt from ticket
POST   /api/ticket-bridge/run        # Run agent on a ticket
```

### Autonomous Loop

```
GET    /api/autonomous-loop/work      # Find issues labeled ready-for-agent
POST   /api/autonomous-loop/pr       # Open PR from completed agent work
POST   /api/autonomous-loop/complete  # Mark agent cycle complete
```

### Memory / Entities

```
GET    /api/memory/entities            # List entities
GET    /api/memory/entities/context    # Get entity context
GET    /api/memory/entities/:id       # Get entity
POST   /api/memory/entities/:id/facts # Add fact to entity
POST   /api/memory/entities/link       # Link two entities
```

### Push Notifications

```
POST   /api/push-subscriptions         # Subscribe to push notifications
DELETE /api/push-subscriptions          # Unsubscribe
GET    /api/push-subscriptions          # List subscriptions
POST   /api/push-acknowledge            # Acknowledge a notification
```

### Calendar

```
GET    /calendar/events           # List events
POST   /calendar/events           # Create event
PATCH  /calendar/events/:eventId  # Update event
DELETE /calendar/events/:eventId  # Delete event
POST   /calendar/focus-blocks     # Create focus block
POST   /calendar/health-blocks    # Create health block
GET    /calendar/stats             # Statistics
GET    /calendar/export/ics       # Export ICS (RFC 5545)
GET    /calendar/subscribe         # Webcal subscription URL
```

### Productivity

```
GET    /productivity/daily-plan                # Daily plan (Jira + GitLab)
GET    /productivity/weekly-plan               # Weekly plan
GET    /productivity/focus-blocks/recommend    # Focus block recommendations
POST   /productivity/focus-blocks             # Create focus block
GET    /productivity/health-breaks/recommend   # Health break recommendations
POST   /productivity/health-blocks            # Create health block
GET    /productivity/calendar-summary          # Calendar summary
```

### Engineering

```
POST   /engineering/workflow-brief               # Generate workflow brief
POST   /engineering/architecture-proposal        # Architecture proposal
POST   /engineering/scaffolding-plan             # Scaffolding plan
POST   /engineering/jira-tickets                 # Generate Jira tickets
POST   /engineering/jira-tickets/create          # Create tickets in Jira
POST   /api/ticket-to-task                       # Convert ticket to task prompt
```

### Roadmaps

```
GET    /api/roadmaps                        # List
POST   /api/roadmaps                        # Create
GET    /api/roadmaps/:id                    # Get
PATCH  /api/roadmaps/:id                    # Update
DELETE /api/roadmaps/:id                    # Delete
GET    /api/templates                       # List templates
POST   /api/templates/:id/create-roadmap    # Create from template
```

### Guardrails

```
POST   /api/guardrails/check                  # Check an action
GET    /api/guardrails/approvals/pending      # Pending approvals
POST   /api/guardrails/approvals/:id/approve  # Approve
POST   /api/guardrails/approvals/:id/reject   # Reject
GET    /api/guardrails/history/:userId        # Action history
GET    /api/guardrails/stats                  # Stats
```

### Approvals

```
GET    /approvals                # List pending
POST   /approvals/:id/approve    # Approve (dispatches via tool dispatcher)
POST   /approvals/:id/reject     # Reject
```

### Auth

```
POST   /auth/login                # Login
POST   /auth/logout               # Logout
GET    /auth/status                # Auth status
GET    /auth/verify                # Verify session
GET    /auth/google/status         # Google OAuth status
GET    /auth/google                # Start Google OAuth
GET    /auth/google/callback       # Google OAuth callback
POST   /auth/google/logout         # Disconnect Google
```

### Tools / Agents Metadata

```
GET    /api/tools                 # All tools with metadata
GET    /api/tools/categories      # Tools by category
GET    /api/agents                 # Agent modes and capabilities
```

### Reviewer

```
GET    /api/reviewer/config        # Reviewer configuration
POST   /api/reviewer/review        # Run multi-agent PR review
```

### Health / Webhooks

```
GET    /health                     # System health
POST   /webhooks/gitlab            # GitLab webhook endpoint
```

## Environment Variables

### Core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | Yes | `3050` | Server port |
| `NODE_ENV` | No | `development` | Environment |
| `AUTH_USERNAME` | Yes | — | Login username |
| `AUTH_PASSWORD` | Yes | — | Login password |
| `AUTH_SESSION_SECRET` | Yes | — | Session encryption key |

### AI Provider

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AI_PROVIDER` | Yes | `opencode` | `opencode`, `zai`, or `ollama` |
| `OPENCODE_API_URL` | If opencode | — | OpenCode API URL |
| `OPENCODE_API_KEY` | If opencode | — | OpenCode API key |
| `OPENCODE_MODEL` | No | `GLM-5.1` | Model name |
| `ZAI_API_URL` | If zai | — | Z.ai API URL |
| `ZAI_API_KEY` | If zai | — | Z.ai API key |
| `ZAI_MODEL` | No | `GLM-5.1` | Model name |
| `OLLAMA_API_URL` | If ollama | `http://localhost:11434` | Ollama API URL |
| `OLLAMA_API_KEY` | No | — | API key (cloud models) |
| `OLLAMA_MODEL` | No | `llama3` | Model name |
| `OLLAMA_MAX_CONTEXT_TOKENS` | No | `128000` | Context window |

### Jira

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JIRA_BASE_URL` | Yes | — | e.g. `https://your-domain.atlassian.net` |
| `JIRA_EMAIL` | Yes | — | Atlassian account email |
| `JIRA_API_TOKEN` | Yes | — | API token |
| `JIRA_PROJECT_KEYS` | No | — | Comma-separated project keys |

### GitLab

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITLAB_BASE_URL` | Yes | `https://gitlab.com` | GitLab instance URL |
| `GITLAB_TOKEN` | Yes | — | Personal access token |
| `GITLAB_DEFAULT_PROJECT` | No | — | Default project path |
| `GITLAB_WEBHOOK_SECRET` | No | — | Webhook verification secret |

### GitHub

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | Yes | — | Personal access token |
| `GITHUB_DEFAULT_OWNER` | No | — | Default org/user |
| `GITHUB_DEFAULT_REPO` | No | — | Default repo |

### Jitbit

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JITBIT_ENABLED` | No | `false` | Enable Jitbit integration |
| `JITBIT_BASE_URL` | If enabled | — | Helpdesk URL |
| `JITBIT_API_TOKEN` | If enabled | — | API token |
| `JITBIT_DEFAULT_CATEGORY_ID` | No | — | Default ticket category |

### HAWK IR

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HAWK_IR_ENABLED` | No | `false` | Enable HAWK IR integration |
| `HAWK_IR_BASE_URL` | If enabled | — | HAWK IR API URL |
| `HAWK_IR_ACCESS_TOKEN` | If enabled | — | Access token |
| `HAWK_IR_SECRET_KEY` | If enabled | — | Secret key |

### Google Calendar

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOOGLE_CALENDAR_CLIENT_ID` | No | — | OAuth2 client ID |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | No | — | OAuth2 client secret |
| `GOOGLE_CALENDAR_CALENDAR_ID` | No | — | Calendar ID |

### Push Notifications

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VAPID_PUBLIC_KEY` | No | — | VAPID public key |
| `VAPID_PRIVATE_KEY` | No | — | VAPID private key |
| `VAPID_ADMIN_EMAIL` | No | — | Admin email for VAPID |
| `PUSH_POLL_INTERVAL_MIN` | No | `5` | Polling interval in minutes |
| `PUSH_ESCALATION_L2_MINUTES` | No | `30` | Level 2 escalation timeout |
| `PUSH_ESCALATION_L3_MINUTES` | No | `60` | Level 3 escalation timeout |

### Policy & Feature Flags

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POLICY_APPROVAL_MODE` | No | `strict` | `strict`, `balanced`, `permissive` |
| `POLICY_JIRA_AUTO_CLOSE` | No | `false` | Auto-close Jira on completion |
| `POLICY_CALENDAR_ALLOW_DELETE` | No | `false` | Allow calendar event deletion |
| `ENABLE_CALENDAR_WRITE` | No | `true` | Enable calendar write operations |
| `ENABLE_JIRA_TRANSITIONS` | No | `true` | Enable Jira status transitions |
| `ENABLE_GITLAB_WEBHOOKS` | No | `true` | Enable GitLab webhooks |

### Other

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | No | `sqlite:./data/app.db` | SQLite database path |
| `AUDIT_LOG_FILE` | No | — | Audit log file path |
| `AUDIT_LOG_LEVEL` | No | — | Minimum audit log severity |
| `TUNNEL_ENABLED` | No | `false` | Enable Cloudflare tunnel |
| `TUNNEL_SUBDOMAIN` | No | — | Tunnel subdomain |
| `DISCORD_BOT_TOKEN` | No | — | Discord bot token |
| `DISCORD_CLIENT_ID` | No | — | Discord client ID |
| `DISCORD_GUILD_ID` | No | — | Discord guild ID |

## Development

### Prerequisites

- Node.js 20+
- TypeScript
- Ollama (for local/cloud models) or an AI provider API key

### Setup

```bash
git clone <repo-url>
cd ai-assist-tim
npm install
cp .env.example .env
# Edit .env with your credentials
```

### Run

```bash
npm run dev          # Development mode (port 3050, auto-reload)
npm run build        # Build for production
npm start            # Start production server
```

### Testing

```bash
npm test             # Run all tests (vitest)
npm run test:watch   # Watch mode
npm run test:coverage # With coverage report
```

Integration-specific tests:

```bash
npm run test:jira           # Jira live tests
npm run test:gitlab         # GitLab live tests
npm run test:roadmap        # Roadmap tests
npm run test:memory         # Memory tests
npm run test:guardrails     # Guardrails tests
npm run test:google-calendar # Google Calendar tests
npm run test:aicoder        # Aicoder smoke tests
npm run test:production    # Production smoke tests
```

### Test Coverage

**236+ tests across 11+ test files.**

| File | Tests | Notes |
|------|-------|-------|
| `tests/e2e/workflows.test.ts` | 44 | Auth, calendar, approval lifecycle, roadmap, guardrails |
| `tests/unit/integrations/jira-crud.test.ts` | 36 | Full Jira CRUD |
| `tests/unit/integrations/gitlab-client.test.ts` | 41 | Projects, MRs, commits, branches, pipelines |
| `tests/unit/integrations/gitlab-dispatcher.test.ts` | 24 | GitLab tool dispatch |
| `tests/e2e/guardrails.test.ts` | 21 | Guardrails enforcement, rate limiting |
| `tests/unit/integrations/jira-key-extractor.test.ts` | 20 | Jira key extraction |
| `tests/unit/middleware/auth.test.ts` | 18 | Auth middleware |
| `src/integrations/jitbit/__tests__/jitbit-client-extended.test.ts` | 34 | Jitbit lifecycle, assets, tags, time |
| `src/integrations/jitbit/__tests__/jitbit-service-extended.test.ts` | 31 | Jitbit service: close, assign, assets |
| `src/integrations/jitbit/__tests__/jitbit-client.test.ts` | 23 | Jitbit client |
| `src/integrations/jitbit/__tests__/jitbit-service.test.ts` | 18 | Jitbit snapshots, followups |
| `tests/unit/product/product-chief-of-staff.test.ts` | 13 | Workflow brief, roadmap, signals |

## Security Notes

- **Guardrails system** — 18+ critical actions require approval. CRITICAL actions (production deploy, schema change, quarantine) require MFA and/or dry run. Rate limits and cooldowns enforced per action.
- **No auto-push/auto-merge** — Git push and PR merge require explicit approval. The Code Review agent analyzes only; merging requires a separate, explicitly approved action.
- **No auto-post** — Code review comments are generated as markdown strings; posting to GitHub/GitLab requires a separate action.
- **Dry-run pattern** — Ticket Bridge and other destructive-capable operations support `dryRun` mode that returns what would happen without executing.
- **Secret redaction** — Agent Runs sanitizer redacts values for keys matching `apikey`, `api_key`, `token`, `password`, `authorization`, `secret`, `access_token`, `refresh_token` before storage.
- **Audit logging** — All tool dispatches and guardrails state changes are logged.
- **Timing-safe comparison** — GitLab webhook verification uses `crypto.timingSafeEqual`.
- **Auth** — bcrypt password hashing, provider-agnostic key validation, session-based auth.
- **Token guards** — GitHub/GitLab client interceptors are guarded when tokens are empty (prevents crashes from unconfigured integrations).
- **Never commit `.env`** — Use `.env.example` as template.

## License

MIT