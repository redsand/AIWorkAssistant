# AI Assistant

A guarded productivity and engineering agent with local-first calendar, Jira, and GitLab integration.

**Status:** Late Alpha — Core infrastructure solid, several modules still partial. See [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) and [`docs/GAP_AUDIT.md`](./docs/GAP_AUDIT.md) for honest status.

## Overview

AI Assistant is a personal productivity and engineering copilot that helps you:

- **Personal Productivity**: Plan your day, protect focus/fitness/mental-health time, manage Jira tickets, and connect GitLab activity to Jira work
- **Engineering Strategy**: Convert vague app ideas into workflow-first designs with thoughtful architecture, scaffolding, and implementation plans
- **Calendar Integration**: Local file-based calendar with ICS export for iPhone subscription via Cloudflare tunnel

**Core Philosophy**: Design from workflows. Scaffold from architecture. Implement with guardrails. Iterate from evidence.

## What Works Now

| Feature                | Status     | Notes                                                                    |
| ---------------------- | ---------- | ------------------------------------------------------------------------ |
| Chat API (OpenCode AI) | ✅ Real    | Streaming, sessions, memory, tool calling                                |
| Tool Dispatcher        | ✅ Real    | 10 real handlers: Jira, GitLab, Calendar, Daily Planner                  |
| Policy Engine          | ✅ Real    | Pattern matching, 3-tier modes (tested)                                  |
| Guardrails             | ✅ Real    | 15 critical actions, rate limiting, REST API                             |
| Approval Queue         | ✅ Real    | SQLite-persisted, executes approved actions via dispatcher               |
| Audit Logger           | ⚠️ Partial | Write works; `query()` returns empty                                     |
| Jira Integration       | ✅ Real    | Full CRUD, v2/v3 fallback, comments, transitions                         |
| GitLab Integration     | ✅ Real    | REST API, commits, MRs, webhooks (⚠️ HMAC is `===`, not timing-safe)     |
| File Calendar + ICS    | ✅ Real    | CRUD, RFC 5545 ICS export, iPhone subscription via tunnel                |
| Cloudflare Tunnel      | ✅ Real    | Starts at boot for external ICS access                                   |
| Google Calendar        | ✅ Real    | OAuth2 + Calendar API (needs OAuth credentials to activate)              |
| Roadmap System         | ✅ Real    | SQLite-backed CRUD, templates, milestones                                |
| Auth Middleware        | ✅ Real    | API key auth with public path whitelist (⚠️ timing attack vulnerability) |
| Discord Bot            | ✅ Real    | Slash commands, sessions, API integration                                |
| Signal Bot             | ⚠️ Partial | Spawns `signal-cli` but polling doesn't actually work                    |
| Conversation Memory    | ✅ Real    | Auto-compaction, file persistence, search                                |
| Web UI                 | ✅ Real    | Chat, roadmaps, memory search                                            |
| CLI                    | ⚠️ Partial | Code exists, not wired as `bin` in package.json                          |
| Daily Planner          | ⚠️ Partial | Routes mounted, Jira data for issue count, rest is hardcoded             |
| Focus Blocks           | ⚠️ Partial | "Recommend" returns stubs; "Create" delegates to real calendar           |
| Health Breaks          | ⚠️ Partial | "Recommend" returns stubs; "Create" delegates to real calendar           |
| Engineering Mode       | ⚠️ Partial | Routes mounted, tries OpenCode API first, stubs as fallback              |
| Guardrails Persistence | ⚠️ Bug     | `database.ts` exists but dead code — state lost on restart               |
| Microsoft Calendar     | 🔴 Stub    | All methods throw "Not implemented"                                      |

## Quick Start

### Prerequisites

- Node.js 20+
- TypeScript
- Optional: Docker

### Installation

```bash
git clone <repo-url>
cd ai-assistant
npm install
cp .env.example .env
# Edit .env with your credentials
```

### Configuration

Edit `.env` with your credentials:

```bash
# Server
PORT=3050
NODE_ENV=development

# OpenCode API (required for chat)
OPENCODE_API_URL=https://opencode.ai/zen/go/v1
OPENCODE_API_KEY=your_opencode_api_key

# Jira Cloud
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your_email@example.com
JIRA_API_TOKEN=your_jira_api_token
JIRA_PROJECT_KEYS=PROJ,OTHER

# GitLab
GITLAB_BASE_URL=https://gitlab.com
GITLAB_TOKEN=your_gitlab_personal_access_token
GITLAB_WEBHOOK_SECRET=your_webhook_secret

# Google Calendar (optional — see GOOGLE_CALENDAR_OAUTH_SETUP.md)
GOOGLE_CALENDAR_CLIENT_ID=your_client_id
GOOGLE_CALENDAR_CLIENT_SECRET=your_client_secret
GOOGLE_CALENDAR_REDIRECT_URI=http://localhost:3050/auth/google/callback
GOOGLE_CALENDAR_API_KEY=your_api_key
GOOGLE_CALENDAR_CALENDAR_ID=primary

# Discord Bot (optional — see DISCORD_SETUP.md)
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_application_id
DISCORD_GUILD_ID=your_server_id

# Tunnel (optional — for iPhone calendar subscription)
TUNNEL_ENABLED=true
TUNNEL_PROVIDER=cloudflare
TUNNEL_DOMAIN=tshelton.us
TUNNEL_SUBDOMAIN=cal

# Policy
POLICY_APPROVAL_MODE=strict  # strict, balanced, permissive
POLICY_JIRA_AUTO_CLOSE=false
POLICY_CALENDAR_ALLOW_DELETE=false
ENABLE_CALENDAR_WRITE=false
ENABLE_JIRA_TRANSITIONS=true
ENABLE_GITLAB_WEBHOOKS=true

# Database
DATABASE_URL=sqlite:./data/app.db

# Audit
AUDIT_LOG_FILE=./logs/audit.log
AUDIT_LOG_LEVEL=info
```

### Development

```bash
npm run dev          # Run in development mode (port 3050)
npm test             # Run tests (vitest)
npm run test:watch   # Run tests in watch mode
npm run build        # Build for production
npm start            # Start production server
npm run cli          # Run CLI (not available as bin)
```

### Docker

```bash
npm run docker:build   # Build containers
npm run docker:up      # Start services
npm run docker:down    # Stop services
npm run docker:logs    # View logs
```

## API Endpoints

### Chat

```
POST   /chat                    # Send a message (productivity/engineering mode)
POST   /chat/stream              # Stream a response (SSE)
GET    /chat/sessions            # List sessions (requires userId query)
POST   /chat/sessions            # Create a new session
GET    /chat/sessions/:id        # Get a session
POST   /chat/sessions/:id/end    # End a session
GET    /chat/memory/search       # Search memories (requires q query)
POST   /chat/memory/relevant    # Get relevant memories
GET    /chat/memory/stats        # Get memory statistics
```

### Approvals

```
GET    /approvals                # List pending approvals
POST   /approvals/:id/approve    # Approve an action (dispatches via tool dispatcher)
POST   /approvals/:id/reject     # Reject an action
```

Approved actions now execute via the tool dispatcher (Jira, GitLab, Calendar, etc.) and store execution results.

### Calendar

```
GET    /calendar/events          # List calendar events
POST   /calendar/events          # Create an event
PATCH  /calendar/events/:eventId # Update an event
DELETE /calendar/events/:eventId # Delete an event
POST   /calendar/focus-blocks    # Create a focus block
POST   /calendar/health-blocks   # Create a health block
GET    /calendar/stats           # Get calendar statistics
GET    /calendar/export/ics      # Export as ICS (RFC 5545)
GET    /calendar/subscribe       # Get webcal:// subscription URL for iPhone
```

### Productivity

```
GET    /productivity/daily-plan                # Get daily plan (Jira data + stubs)
GET    /productivity/focus-blocks/recommend     # Get focus block recommendations (stub)
POST   /productivity/focus-blocks               # Create focus block in calendar
GET    /productivity/health-breaks/recommend    # Get health break recommendations (stub)
POST   /productivity/health-blocks              # Create health block in calendar
GET    /productivity/calendar-summary            # Get calendar summary
```

### Engineering

```
POST   /engineering/workflow-brief              # Generate workflow brief (AI-first, stub fallback)
POST   /engineering/architecture-proposal       # Generate architecture proposal (AI-first, stub fallback)
POST   /engineering/scaffolding-plan            # Generate scaffolding plan (AI-first, stub fallback)
POST   /engineering/jira-tickets                # Generate Jira tickets from plan (AI-first)
POST   /engineering/jira-tickets/create         # Create tickets in Jira (⚠️ uses Math.random() for keys)
```

### Webhooks

```
POST   /webhooks/gitlab          # GitLab webhook endpoint (⚠️ HMAC uses === not timingSafeEqual)
```

### Roadmaps

```
GET    /api/roadmaps             # List roadmaps
POST   /api/roadmaps             # Create a roadmap
GET    /api/roadmaps/:id         # Get a roadmap
PUT    /api/roadmaps/:id         # Update a roadmap
DELETE /api/roadmaps/:id         # Delete a roadmap
GET    /api/templates            # List templates
POST   /api/templates/:id/create-roadmap  # Create from template
```

### Guardrails

```
POST   /api/guardrails/check           # Check an action
GET    /api/guardrails/approvals/pending  # List pending approvals
POST   /api/guardrails/approvals/:id/approve  # Approve
POST   /api/guardrails/approvals/:id/reject   # Reject
GET    /api/guardrails/history/:userId  # Get action history
GET    /api/guardrails/stats             # Get guardrails stats
POST   /api/guardrails/log-execution    # Log an execution
```

### Google OAuth

```
GET    /auth/google/status       # Check authorization status
GET    /auth/google              # Get authorization URL
GET    /auth/google/callback     # OAuth callback handler
POST   /auth/google/logout       # Clear authorization
```

### Health

```
GET    /health                    # Health check
```

## Architecture

```
src/
├── config/               # Environment, constants, policy rules
├── agent/                 # OpenCode client, tool registry, prompts, tool dispatcher
├── policy/                # Policy engine with pattern matching
├── approvals/             # Approval queue (SQLite-persisted, dispatches on approve)
├── audit/                 # Audit logger (write-only currently, query returns [])
├── guardrails/            # Action registry, enforcement, REST API, database.ts (⚠️ dead code)
├── memory/                # Conversation manager with compaction
├── roadmap/               # SQLite-backed CRUD, templates
├── integrations/
│   ├── jira/              # Jira Cloud REST API (v2/v3)
│   ├── gitlab/            # GitLab API + webhooks (⚠️ HMAC) + Jira key extractor
│   ├── google/            # Google Calendar OAuth2 + Calendar API
│   ├── microsoft/          # STUB — all methods throw "Not implemented"
│   ├── discord/            # Discord bot with slash commands
│   ├── signal/             # Signal bot (polling doesn't work)
│   └── file/               # File-based calendar + ICS export + tunnel
├── productivity/           # Partial — "recommend" stubs, "create" delegates to calendar
├── engineering/             # Partial — AI-first routes, stub fallbacks
├── routes/                 # HTTP endpoints (all mounted)
├── middleware/              # Auth middleware (API key, ⚠️ timing attack)
├── cli/                    # Commander.js CLI (not wired as executable)
└── server.ts               # Fastify entry point
```

## Known Issues

See [`docs/GAP_AUDIT.md`](./docs/GAP_AUDIT.md) for the full audit. Key issues:

1. **GitLab webhook HMAC** — uses `===` string comparison, not `crypto.timingSafeEqual` (security)
2. **Auth key comparison** — uses `!==` not `crypto.timingSafeEqual` (timing attack)
3. **Guardrails database.ts** — dead code, state lost on restart (in-memory Maps only)
4. **Audit logger query** — `query()` returns `[]`, no read-back capability
5. **CLI not wired** — no `bin` field in package.json
6. **Jira ticket generator** — `createTickets()` uses `Math.random()` instead of Jira API
7. **Microsoft integration** — dead code, all methods throw
8. **Productivity "recommend" endpoints** — return hardcoded data
9. **Signal bot polling** — logs starting but doesn't actually poll

## Policy Model

Actions are classified by risk level:

- **Low Risk**: Read-only, drafting, planning (automatic)
- **Medium Risk**: Comments, creating tickets, calendar blocks (approval required)
- **High Risk**: Closing tickets, moving meetings, deletions (approval required or blocked)

Example policies:

- Reading Jira tickets: ✅ Allow
- Posting Jira comments: ⚠️ Approval required
- Closing Jira tickets: ⚠️ Approval required
- Moving meetings with attendees: ⚠️ Approval required
- Deleting calendar events: 🚫 Blocked

## Security Notes

- Never commit `.env` files
- Use strong webhook secrets
- ⚠️ GitLab webhook verification needs `crypto.timingSafeEqual` before production
- ⚠️ Auth middleware needs `crypto.timingSafeEqual` before production
- ⚠️ Guardrails history is in-memory — lost on restart
- Enable HTTPS in production (nginx config included)
- Scope API tokens to minimum required permissions
- Audit log query not yet functional

## Test Coverage

See [`TEST_COVERAGE_REPORT.md`](./TEST_COVERAGE_REPORT.md) for details. Current state:

- **4 test files**, 45 tests, 44 passing, 1 failing (Jira JQL deprecation)
- **0 workflow/end-to-end tests** — approval lifecycle, chat→tool dispatch, calendar CRUD, auth middleware all untested
- **Source code coverage unknown** — `vitest --coverage` never run

## Documentation

- [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) — Honest status of every module
- [`docs/GAP_AUDIT.md`](./docs/GAP_AUDIT.md) — Independent audit of docs vs code
- [`docs/roadmap.md`](./docs/roadmap.md) — Revised roadmap with realistic timelines
- [`docs/architecture.md`](./docs/architecture.md) — System architecture
- [`docs/development.md`](./docs/development.md) — Development guide
- [`TEST_COVERAGE_REPORT.md`](./TEST_COVERAGE_REPORT.md) — Test coverage (honest assessment)
- [`DISCORD_SETUP.md`](./DISCORD_SETUP.md) — Discord bot setup
- [`GOOGLE_CALENDAR_OAUTH_SETUP.md`](./GOOGLE_CALENDAR_OAUTH_SETUP.md) — Google Calendar OAuth

## License

MIT
