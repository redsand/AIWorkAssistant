# AI Assistant

A guarded productivity and engineering agent with local-first calendar, Jira, GitLab, and GitHub integration.

**Status:** v0.2.0 — Multi-provider AI with robust agent loop, 100+ tool handlers, full GitHub/GitLab/Jira CRUD, streaming chat, auto-compaction, and comprehensive test coverage.

## Overview

AI Assistant is a personal productivity and engineering copilot that helps you:

- **Personal Productivity**: Plan your day, protect focus/fitness/mental-health time, manage Jira tickets, and connect GitLab/GitHub activity to Jira work
- **Engineering Strategy**: Convert vague app ideas into workflow-first designs with thoughtful architecture, scaffolding, and implementation plans — now with real tool dispatch handlers
- **Calendar Integration**: Local file-based calendar with ICS export for iPhone subscription via Cloudflare tunnel
- **Multi-Provider AI**: Switch between Ollama (local/cloud), Z.ai, and OpenCode providers with consistent behavior across all three

**Core Philosophy**: Design from workflows. Scaffold from architecture. Implement with guardrails. Iterate from evidence.

## AI Providers

| Provider | Config                           | Notes                                                                                            |
| -------- | -------------------------------- | ------------------------------------------------------------------------------------------------ |
| Ollama   | `AI_PROVIDER=ollama`             | Local or cloud models (e.g., `glm-5.1:cloud`). Synthesizes tool call IDs when API omits them.    |
| Z.ai     | `AI_PROVIDER=zai`                | Z.ai GLM models. Retry + rate-limit handling with Retry-After header support. Chunked streaming. |
| OpenCode | `AI_PROVIDER=opencode` (default) | OpenCode API with exponential backoff retry.                                                     |

All providers support:

- Automatic retry with exponential backoff (429 rate limits handled separately from server errors)
- Tool calling with dynamic expansion (core set sent first, more loaded on demand)
- Thinking/reasoning content extraction and display
- Streaming SSE responses with tool progress indicators
- `toolChoice: "auto"` — the AI decides when to call tools (not forced)
- Consistent tool call ID handling — missing IDs are synthesized to prevent collisions

## Agent Architecture

The agent loop is designed for reliable multi-step task execution:

1. **System prompts** are injected for every request (new sessions and continued sessions alike), including `TASK_COMPLETION_RULES` that instruct the AI to finish tasks without stopping mid-way
2. **Tool call history accumulates** across loop iterations — round 3 sees results from rounds 1 and 2, so the AI can build on prior tool outputs
3. **Loop guard** caps at 25 iterations to prevent infinite loops while allowing complex workflows
4. **JSON.parse protection** — malformed AI tool arguments are caught gracefully instead of crashing the request
5. **Compaction preserves metadata** — `toolCalls` and `tool_call_id` are maintained in the correct API message format, so compacted sessions don't break subsequent requests
6. **LLM-based summarization** — compaction uses the AI provider to generate summaries that preserve tool results, IDs, and decisions (not just "OK")

## Dynamic Tool System

To keep token usage manageable, the system sends a **core set of ~26 tools** initially and adds a `discover_tools` meta-tool. When the AI needs capabilities beyond the core set (e.g., GitLab pipelines, GitHub PRs), it calls `discover_tools` with a category name, and those tools are dynamically added to the next API call.

**Core tools always available:**

- Calendar: list events, create focus/health blocks
- Jira: list, get, search, create, update issues + add comments + transition
- GitLab: projects, MRs, files, tree, search, commits, branches, create file
- GitHub: repos, files, tree, search
- Planning: daily planner

**Expandable categories:** `gitlab` (29 tools), `github` (35 tools), `jira` (13 tools), `calendar` (3 tools), `roadmap` (11 tools)

## What Works Now

| Feature             | Status  | Notes                                                                                                                       |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| Chat API            | ✅ Real | Streaming, sessions, memory, tool calling, thinking display, multi-step agent loop                                          |
| Multi-Provider AI   | ✅ Real | Ollama, Z.ai, OpenCode with retry/rate-limit handling, consistent tool call behavior                                        |
| Agent Loop          | ✅ Real | History accumulation, loop guard, system prompts on all requests, JSON protection                                           |
| Dynamic Tools       | ✅ Real | Core set + discover_tools for on-demand expansion                                                                           |
| Tool Dispatcher     | ✅ Real | 100+ real handlers: Jira, GitLab, GitHub, Calendar, Daily Planner, Roadmap, Engineering                                     |
| Engineering Tools   | ✅ Real | Workflow brief, architecture proposal, scaffolding plan, Jira ticket generation — all dispatched                            |
| Policy Engine       | ✅ Real | Pattern matching, 3-tier modes                                                                                              |
| Guardrails          | ✅ Real | 16 critical actions, rate limiting, REST API                                                                                |
| Approval Queue      | ✅ Real | SQLite-persisted, executes approved actions via dispatcher                                                                  |
| Jira Integration    | ✅ Real | Full CRUD, v2/v3 fallback, comments, transitions, list projects                                                             |
| GitLab Integration  | ✅ Real | REST API with retry logic, commits, MRs, files, pipelines, issues, branches, tags, blame, compare, webhooks                 |
| GitHub Integration  | ✅ Real | Repos, files, branches, PRs, issues, workflows, releases, tags, commits, blame, compare, code search                        |
| Jitbit Integration  | ✅ Real | 21 tools: ticket lifecycle (create/close/reopen/assign/delete/merge/forward), assets CRUD, custom fields, tags, time tracking, automation, comments, companies, users, snapshots |
| File Calendar + ICS | ✅ Real | CRUD, RFC 5545 ICS export, iPhone subscription via tunnel                                                                   |
| Cloudflare Tunnel   | ✅ Real | Starts at boot for external ICS access                                                                                      |
| Google Calendar     | ✅ Real | OAuth2 + Calendar API                                                                                                       |
| Conversation Memory | ✅ Real | LLM-based auto-compaction, file persistence, search, metadata preservation                                                  |
| Audit Logger        | ✅ Real | Write + query with severity filtering and JSONL storage                                                                     |
| Roadmap CRUD        | ✅ Real | SQLite-backed CRUD + milestones + items + delete operations + templates                                                     |
| Web UI              | ✅ Real | Chat with thinking display, tool progress, collapsible JSON, export, stop button, conversation sidebar, delete confirmation |
| Agent Runs UI       | ✅ Real | Inspect model/tool execution traces from the browser — list, filter, and drill into run details and step timelines |
| Daily Planner       | ✅ Real | Jira + GitLab data wired, real issue counts and activity                                                                    |
| CTO Command Center | ✅ Real | Daily brief from calendar, Jira, GitLab, GitHub, roadmap, work items, Jitbit, memory                                       |
| Personal OS         | ✅ Real | Brief, open loops, pattern detection, delegation suggestions, focus blocks — all with graceful fallbacks                  |
| Health Endpoints    | ✅ Real | `/health` reports GitHub/GitLab/Jira integration status; `/chat/health` reports active AI provider                          |
| Discord Bot         | ✅ Real | Slash commands, sessions, API integration                                                                                   |

## Test Coverage

**236 tests across 11 test files, 230+ passing consistently.**

| File                                                 | Tests | Notes                                                                                                    |
| ---------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------- |
| `tests/e2e/workflows.test.ts`                        | 44    | Auth, calendar CRUD, ICS export, approval lifecycle, roadmap CRUD, productivity, engineering, guardrails |
| `tests/unit/integrations/jira-crud.test.ts`          | 36    | Full Jira CRUD: create, update, transition, search, comments                                             |
| `tests/unit/integrations/gitlab-client.test.ts`      | 41    | Projects, MRs, commits, branches, pipelines, files, issues, tags, blame, compare                         |
| `tests/unit/integrations/gitlab-dispatcher.test.ts`  | 24    | Tool dispatch for GitLab operations                                                                      |
| `tests/e2e/guardrails.test.ts`                       | 21    | Guardrails enforcement, rate limiting, approval flow                                                     |
| `tests/unit/integrations/jira-key-extractor.test.ts` | 20    | Jira key extraction from text                                                                            |
| `tests/unit/middleware/auth.test.ts`                 | 18    | Bearer/X-API-Key/query auth, public paths, session auth                                                  |
| `tests/unit/integrations/jira-client.test.ts`        | 9     | Live Jira API integration                                                                                |
| `tests/unit/integrations/jira-list-projects.test.ts` | 7     | Project listing                                                                                          |
| `tests/unit/policy/engine.test.ts`                   | 10    | Policy engine pattern matching                                                                           |
| `tests/unit/agent/opencode-client.test.ts`           | 6     | Live AI provider chat + tool calling                                                                     |
| `src/integrations/jitbit/__tests__/jitbit-client.test.ts` | 23  | Jitbit API client: config, tickets, comments, companies, users, retry                                   |
| `src/integrations/jitbit/__tests__/jitbit-service.test.ts` | 18 | Jitbit service: snapshots, followups, summaries, recent activity                                         |
| `src/integrations/jitbit/__tests__/jitbit-client-extended.test.ts` | 34 | Jitbit client: lifecycle, attachments, assets, custom fields, tags, sections, time, automation |
| `src/integrations/jitbit/__tests__/jitbit-service-extended.test.ts` | 31 | Jitbit service: close/reopen/assign, assets, custom fields, tags, time, sections, automation |

## Personal OS

The Personal OS module provides a holistic daily operating brief that aggregates signals across all connected integrations:

- **Brief** (`personal_os.brief`) — Aggregates calendar, Jira, GitLab, GitHub, Jitbit, work items, roadmaps, and memory into a structured daily brief with 9 sections: Today's Load, Open Loops, Decisions Waiting, Recurring Patterns, Suggested Delegations, Suggested Focus Blocks, Energy/Context-Switching Risks, Things To Stop Doing, and Work Items To Create.
- **Open Loops** (`personal_os.open_loops`) — Finds unresolved decisions, blocked tasks, PRs awaiting review, and follow-ups across all sources.
- **Pattern Detection** (`personal_os.detect_patterns`) — Analyzes work item and calendar data for recurring patterns like meeting overload, context switching, and review bottlenecks.
- **Focus Blocks** (`personal_os.suggest_focus`) — Suggests calendar focus blocks based on open loops, priorities, and schedule gaps. Does **not** auto-create calendar events.
- **Create Work Items** (`personal_os.create_work_items`) — Creates work items from brief suggestions. Requires explicit user approval (medium risk, policy-checked).

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/personal-os/brief` | Generate Personal OS brief |
| GET | `/api/personal-os/open-loops` | Summarize open loops |
| GET | `/api/personal-os/patterns` | Detect recurring patterns |
| POST | `/api/personal-os/work-items` | Create work items from brief |

### Design Constraints

- No invasive monitoring — reads existing integration data only
- No auto-changing calendar — only suggests focus blocks
- No health/fitness decisions — only suggests protecting focus time
- Uses existing policy engine for approval gates on `create_work_items`
- All read-only endpoints are `low` risk; `create_work_items` is `medium` risk

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

# OpenCode
OPENCODE_API_URL=https://api.opencode.com/v1
OPENCODE_API_KEY=your_opencode_api_key
OPENCODE_MODEL=GLM-5.1

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

# Jitbit Helpdesk
JITBIT_ENABLED=false
JITBIT_BASE_URL=https://your-company.jitbit.com/helpdesk
JITBIT_API_TOKEN=your_jitbit_api_token
JITBIT_DEFAULT_CATEGORY_ID=

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
GET    /chat/health              # AI provider + integration health check
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

| Event         | Data                   | Description                              |
| ------------- | ---------------------- | ---------------------------------------- |
| `session`     | `{ sessionId }`        | Session ID for the conversation          |
| `tool_start`  | `{ id, name, params }` | Tool call started                        |
| `tool_result` | `{ id, result }`       | Tool call completed                      |
| `thinking`    | `{ thinking }`         | AI reasoning content (collapsible in UI) |
| `content`     | `{ content }`          | Final response content                   |
| `done`        | `{ usage, model }`     | Stream complete                          |
| `error`       | `{ error, message }`   | Error occurred                           |

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
GET    /productivity/daily-plan                # Get daily plan (Jira + GitLab data)
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
PATCH  /api/roadmaps/:id          # Update a roadmap
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
GET    /health                     # System health (GitHub/GitLab/Jira integration status)
GET    /chat/health                # AI provider + integration health check
```

### Agent Runs

```
GET    /api/agent-runs              # List runs (query: status, userId, limit, offset)
GET    /api/agent-runs/stats        # Aggregate statistics
GET    /api/agent-runs/:id          # Get run with steps
GET    /api/agent-runs/:id/steps    # Get steps for a run
```

### Jitbit

Jitbit support/customer intelligence is exposed through 21 assistant tools rather than standalone REST routes. Core tools include `jitbit.search_tickets`, `jitbit.get_ticket`, `jitbit.create_ticket`, `jitbit.close_ticket`, `jitbit.assign_ticket`, and `jitbit.list_assets`. Additional tools for merges, forwarding, asset management, tags, and time tracking are available via `discover_tools('jitbit')`.

### Work Items

The "Work Items" page in the sidebar lets you create, view, edit, complete, and archive work items. You can filter by status, type, priority, and source. Work items can link to external resources (Jira, GitHub, GitLab, Jitbit, calendar, roadmap) and include notes.

## Architecture

```
src/
├── config/                # Environment, constants, policy rules
├── agent/
│   ├── providers/          # AI providers (Ollama, Z.ai, OpenCode)
│   │   ├── types.ts         # Shared interfaces (ChatRequest, ChatResponse, ToolCall)
│   │   ├── factory.ts        # Provider factory (switches on AI_PROVIDER env)
│   │   ├── ollama-provider.ts # Ollama with ID synthesis + descriptive error handling
│   │   ├── zai-provider.ts   # Z.ai with retry + rate limiting + thinking + chunked streaming
│   │   └── opencode-provider.ts # OpenCode API with exponential backoff retry
│   ├── opencode-client.ts   # Provider facade (provider-agnostic)
│   ├── tool-registry.ts     # 100+ tools with core set + discover_tools
│   ├── tool-dispatcher.ts   # Tool execution with audit logging + engineering handlers
│   └── prompts.ts           # System prompts with TASK_COMPLETION_RULES
├── policy/                 # Policy engine with pattern matching
├── approvals/              # Approval queue (SQLite, dispatches on approve)
├── audit/                  # Audit logger (write + query with severity filtering)
├── guardrails/             # Action registry, enforcement, REST API
├── memory/                 # Conversation manager with LLM-based compaction
├── roadmap/                # SQLite-backed CRUD, milestones, items, templates
├── integrations/
│   ├── jira/               # Jira Cloud REST API (v2/v3)
│   ├── gitlab/             # GitLab API with retry + webhook support
│   ├── github/             # GitHub REST API with retry (repos, PRs, issues, workflows, releases)
│   ├── jitbit/             # Jitbit Helpdesk API (tickets, lifecycle, comments, companies, users, snapshots, assets, tags, time tracking, automation, custom fields)
│   ├── google/             # Google Calendar OAuth2 + Calendar API
│   ├── discord/            # Discord bot with slash commands
│   └── file/               # File-based calendar + ICS export + tunnel
├── engineering/            # Workflow brief, architecture planner, scaffold planner, Jira tickets
├── productivity/           # Daily planner (Jira + GitLab), focus blocks, health breaks
├── routes/                 # HTTP endpoints (chat, calendar, etc.)
├── middleware/              # Auth middleware (provider-agnostic key validation)
└── server.ts               # Fastify entry point with provider-aware startup logging
```

## Error Handling

All AI providers include:

- **Exponential backoff** with jitter for server errors (5xx)
- **Rate limit handling** (429) with `Retry-After` header support
- **Thinking/reasoning extraction** — GLM-5.x `reasoning_content` captured and displayed
- **Tool call ID synthesis** — Ollama and Z.ai synthesize IDs when the API omits them
- **Descriptive errors** — Ollama 400-with-tools throws a clear error instead of silently degrading
- **GitLab/GitHub retry** — 429 and 5xx responses automatically retried with backoff; interceptors guarded when token is empty

## Security Notes

- Never commit `.env` files
- Use strong webhook secrets
- GitLab webhook verification uses `crypto.timingSafeEqual`
- Auth middleware uses bcrypt password hashing
- Auth key validation is provider-agnostic (uses active provider's key)
- Scope API tokens to minimum required permissions
- Audit logging on all tool dispatches
- GitHub/GitLab client interceptors are guarded when tokens are empty (prevents crashes)

## License

MIT
