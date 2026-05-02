# AI Assistant

A guarded productivity and engineering agent with local-first calendar, Jira, GitLab, and GitHub integration.

**Status:** Beta — Core infrastructure solid, multi-provider AI support, dynamic tool expansion, streaming chat with thinking display.

## Overview

AI Assistant is a personal productivity and engineering copilot that helps you:

- **Personal Productivity**: Plan your day, protect focus/fitness/mental-health time, manage Jira tickets, and connect GitLab/GitHub activity to Jira work
- **Engineering Strategy**: Convert vague app ideas into workflow-first designs with thoughtful architecture, scaffolding, and implementation plans
- **Calendar Integration**: Local file-based calendar with ICS export for iPhone subscription via Cloudflare tunnel
- **Multi-Provider AI**: Switch between Ollama (local/cloud), Z.ai, and OpenCode providers with automatic retry and rate limit handling

**Core Philosophy**: Design from workflows. Scaffold from architecture. Implement with guardrails. Iterate from evidence.

## AI Providers

| Provider | Config | Notes |
|----------|--------|-------|
| Ollama | `AI_PROVIDER=ollama` | Local or cloud models (e.g., `glm-5.1:cloud`). Supports API key auth for cloud endpoints. |
| Z.ai | `AI_PROVIDER=zai` | Z.ai GLM models. Automatic 429 rate-limit handling with Retry-After header support. |
| OpenCode | `AI_PROVIDER=opencode` (default) | OpenCode API. |

All providers support:
- Automatic retry with exponential backoff (429 rate limits handled separately from server errors)
- Tool calling with dynamic expansion (core set sent first, more loaded on demand)
- Thinking/reasoning content extraction and display
- Streaming SSE responses with tool progress indicators

## Dynamic Tool System

To keep token usage manageable, the system sends a **core set of ~26 tools** initially and adds a `discover_tools` meta-tool. When the AI needs capabilities beyond the core set (e.g., GitLab pipelines, GitHub PRs), it calls `discover_tools` with a category name, and those tools are dynamically added to the next API call.

**Core tools always available:**
- Calendar: list events, create focus/health blocks
- Jira: list, get, search, create, update issues + add comments + transition
- GitLab: projects, MRs, files, tree, search, commits, branches, create file
- GitHub: repos, files, tree, search
- Planning: daily planner

**Expandable categories:** `gitlab` (29 tools), `github` (35 tools), `jira` (13 tools), `calendar` (3 tools)

## What Works Now

| Feature | Status | Notes |
|---------|--------|-------|
| Chat API | ✅ Real | Streaming, sessions, memory, tool calling, thinking display |
| Multi-Provider AI | ✅ Real | Ollama, Z.ai, OpenCode with retry/rate-limit handling |
| Dynamic Tools | ✅ Real | Core set + discover_tools for on-demand expansion |
| Tool Dispatcher | ✅ Real | 80+ real handlers: Jira, GitLab, GitHub, Calendar, Daily Planner |
| Policy Engine | ✅ Real | Pattern matching, 3-tier modes |
| Guardrails | ✅ Real | 15 critical actions, rate limiting, REST API |
| Approval Queue | ✅ Real | SQLite-persisted, executes approved actions via dispatcher |
| Jira Integration | ✅ Real | Full CRUD, v2/v3 fallback, comments, transitions |
| GitLab Integration | ✅ Real | REST API with retry logic, commits, MRs, files, pipelines, issues, webhooks |
| GitHub Integration | ✅ Real | Repos, files, branches, PRs, issues, workflows, releases |
| File Calendar + ICS | ✅ Real | CRUD, RFC 5545 ICS export, iPhone subscription via tunnel |
| Cloudflare Tunnel | ✅ Real | Starts at boot for external ICS access |
| Google Calendar | ✅ Real | OAuth2 + Calendar API |
| Conversation Memory | ✅ Real | Auto-compaction, file persistence, search |
| Web UI | ✅ Real | Chat with thinking display, tool progress, collapsible JSON results |
| Audit Logger | ⚠️ Partial | Write works; `query()` returns empty |
| Discord Bot | ✅ Real | Slash commands, sessions, API integration |
| Engineering Mode | ⚠️ Partial | Routes mounted, AI-first with stub fallback |
| Daily Planner | ⚠️ Partial | Jira data for issue count, rest partially stubbed |

## Quick Start

### Prerequisites

- Node.js 20+
- TypeScript
- Ollama (for local/cloud models) or an AI provider API key

### Installation

```bash
git clone <repo-url>
cd ai-assist-tim
npm install
cp .env.example .env
# Edit .env with your credentials
```

### Configuration

Edit `.env` with your credentials:

```bash
# AI Provider (opencode | zai | ollama)
AI_PROVIDER=ollama

# Ollama (local and cloud models)
OLLAMA_API_URL=http://localhost:11434
OLLAMA_API_KEY=                    # Leave empty for local Ollama, set for cloud models
OLLAMA_MODEL=llama3                # or glm-5.1:cloud for cloud-proxied models
OLLAMA_TEMPERATURE=0.7
OLLAMA_MAX_CONTEXT_TOKENS=128000

# Z.ai (GLM models)
ZAI_API_URL=https://api.z.ai/api/coding/paas/v4
ZAI_API_KEY=your_zai_api_key
ZAI_MODEL=GLM-5.1

# Jira Cloud
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your_email@example.com
JIRA_API_TOKEN=your_jira_api_token
JIRA_PROJECT_KEYS=PROJ,OTHER

# GitLab
GITLAB_BASE_URL=https://gitlab.com
GITLAB_TOKEN=your_gitlab_personal_access_token
GITLAB_DEFAULT_PROJECT=your/project

# GitHub
GITHUB_TOKEN=your_github_token
GITHUB_DEFAULT_OWNER=your_org
GITHUB_DEFAULT_REPO=your_repo

# Policy
POLICY_APPROVAL_MODE=strict   # strict, balanced, permissive
POLICY_JIRA_AUTO_CLOSE=false
POLICY_CALENDAR_ALLOW_DELETE=false
ENABLE_CALENDAR_WRITE=true
ENABLE_JIRA_TRANSITIONS=true
ENABLE_GITLAB_WEBHOOKS=true
```

### Development

```bash
npm run dev          # Run in development mode (port 3050)
npm test             # Run tests (vitest)
npm run test:watch   # Run tests in watch mode
npm run build        # Build for production
npm start            # Start production server
```

## API Endpoints

### Chat

```
POST   /chat                    # Send a message (productivity/engineering mode)
POST   /chat/stream              # Stream a response (SSE with tool progress + thinking events)
GET    /chat/sessions             # List sessions
POST   /chat/sessions             # Create a new session
GET    /chat/sessions/:id         # Get a session
POST   /chat/sessions/:id/end    # End a session
GET    /chat/sessions/:id/messages # Get session messages
DELETE /chat/sessions/:id         # Delete a session
GET    /chat/memory/search        # Search memories
POST   /chat/memory/relevant     # Get relevant memories
GET    /chat/memory/stats         # Get memory statistics
```

### Stream Events

The `/chat/stream` endpoint sends Server-Sent Events:

| Event | Data | Description |
|-------|------|-------------|
| `session` | `{ sessionId }` | Session ID for the conversation |
| `tool_start` | `{ id, name, params }` | Tool call started |
| `tool_result` | `{ id, result }` | Tool call completed |
| `thinking` | `{ thinking }` | AI reasoning content (collapsible in UI) |
| `content` | `{ content }` | Final response content |
| `done` | `{ usage, model }` | Stream complete |
| `error` | `{ error, message }` | Error occurred |

### Approvals

```
GET    /approvals                # List pending approvals
POST   /approvals/:id/approve    # Approve an action (dispatches via tool dispatcher)
POST   /approvals/:id/reject     # Reject an action
```

### Calendar

```
GET    /calendar/events           # List calendar events
POST   /calendar/events           # Create an event
PATCH  /calendar/events/:eventId # Update an event
DELETE /calendar/events/:eventId # Delete an event
POST   /calendar/focus-blocks    # Create a focus block
POST   /calendar/health-blocks   # Create a health block
GET    /calendar/stats            # Get calendar statistics
GET    /calendar/export/ics       # Export as ICS (RFC 5545)
GET    /calendar/subscribe        # Get webcal:// subscription URL for iPhone
```

### Productivity

```
GET    /productivity/daily-plan                # Get daily plan
GET    /productivity/focus-blocks/recommend     # Get focus block recommendations
POST   /productivity/focus-blocks              # Create focus block
GET    /productivity/health-breaks/recommend    # Get health break recommendations
POST   /productivity/health-blocks              # Create health block
GET    /productivity/calendar-summary            # Get calendar summary
```

### Engineering

```
POST   /engineering/workflow-brief               # Generate workflow brief
POST   /engineering/architecture-proposal        # Generate architecture proposal
POST   /engineering/scaffolding-plan             # Generate scaffolding plan
POST   /engineering/jira-tickets                 # Generate Jira tickets from plan
```

### Webhooks

```
POST   /webhooks/gitlab           # GitLab webhook endpoint
```

### Roadmaps

```
GET    /api/roadmaps              # List roadmaps
POST   /api/roadmaps              # Create a roadmap
GET    /api/roadmaps/:id          # Get a roadmap
PUT    /api/roadmaps/:id          # Update a roadmap
DELETE /api/roadmaps/:id          # Delete a roadmap
GET    /api/templates             # List templates
POST   /api/templates/:id/create-roadmap  # Create from template
```

### Guardrails

```
POST   /api/guardrails/check           # Check an action
GET    /api/guardrails/approvals/pending  # List pending approvals
POST   /api/guardrails/approvals/:id/approve  # Approve
POST   /api/guardrails/approvals/:id/reject   # Reject
GET    /api/guardrails/history/:userId  # Get action history
GET    /api/guardrails/stats             # Get stats
```

### Health

```
GET    /health                     # Health check
GET    /chat/health                # AI provider health check
```

## Architecture

```
src/
├── config/                # Environment, constants, policy rules
├── agent/
│   ├── providers/          # AI providers (Ollama, Z.ai, OpenCode)
│   │   ├── types.ts         # Shared interfaces (ChatRequest, ChatResponse, ToolCall)
│   │   ├── factory.ts        # Provider factory (switches on AI_PROVIDER env)
│   │   ├── ollama-provider.ts # Ollama local/cloud with retry + rate limiting
│   │   ├── zai-provider.ts   # Z.ai with retry + rate limiting + thinking
│   │   └── opencode-provider.ts # OpenCode API provider
│   ├── opencode-client.ts   # Provider facade
│   ├── tool-registry.ts     # 80+ tools with core set + discover_tools
│   └── tool-dispatcher.ts   # Tool execution with audit logging
├── policy/                 # Policy engine with pattern matching
├── approvals/              # Approval queue (SQLite, dispatches on approve)
├── audit/                  # Audit logger
├── guardrails/             # Action registry, enforcement, REST API
├── memory/                 # Conversation manager with compaction
├── roadmap/                # SQLite-backed CRUD, templates
├── integrations/
│   ├── jira/               # Jira Cloud REST API (v2/v3)
│   ├── gitlab/             # GitLab API with retry + webhook support
│   ├── github/             # GitHub REST API
│   ├── google/             # Google Calendar OAuth2 + Calendar API
│   ├── discord/            # Discord bot with slash commands
│   └── file/               # File-based calendar + ICS export + tunnel
├── productivity/           # Daily planner, focus blocks, health breaks
├── routes/                 # HTTP endpoints (chat, calendar, etc.)
├── middleware/              # Auth middleware
└── server.ts               # Fastify entry point
```

## Error Handling

All AI providers include:
- **Exponential backoff** with jitter for server errors (5xx)
- **Rate limit handling** (429) with `Retry-After` header support
- **Off-by-one retry fix** — retries are now bounded correctly
- **Thinking/reasoning extraction** — GLM-5.x `reasoning_content` captured and displayed
- **500-with-tools fallback** — if a model returns 500 with tools, automatically retries without tools
- **GitLab retry** — 429 and 5xx responses automatically retried with backoff

## Security Notes

- Never commit `.env` files
- Use strong webhook secrets
- GitLab webhook verification uses `crypto.timingSafeEqual`
- Auth middleware uses bcrypt password hashing
- Scope API tokens to minimum required permissions
- Audit logging on all tool dispatches

## License

MIT