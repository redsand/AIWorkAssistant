# Agents & Helpers

Documentation for each agent and helper module in AIWorkAssistant.

---

## CTO Daily Command Center

Aggregates data from 8 integration sources into a structured daily brief for CTOs and engineering leaders.

### What It Does

Collects calendar events, Jira issues, GitLab MRs/pipelines, GitHub PRs/workflows, roadmaps, work items, Jitbit tickets, HAWK IR cases, and conversation memory. Produces a markdown brief with 10 sections:

1. **Executive Snapshot** — bullet summary across all sources
2. **Needs Tim's Attention** — blocked/overdue items, high-priority tickets, risky IR cases, failed pipelines
3. **Customer / Support Signals** — Jitbit high-priority, follow-up, and recent tickets
4. **Incident Response / Security Signals** — HAWK IR case count, risky unescalated cases, active nodes
5. **Engineering Signals** — GitHub PRs, GitLab MRs, workflow runs, pipelines, Jira issues, releases
6. **Product / Roadmap Signals** — active roadmaps, blocked items
7. **Work Items** — due today, overdue, blocked, waiting, suggested new items
8. **Suggested Schedule** — calendar events + focus/admin/customer/recovery blocks
9. **Safe Actions** — things the assistant can draft
10. **Questions** — context-aware questions about unblocking, reviews, reconnections

Auto-generates up to 12 suggested work items from Jitbit high-priority tickets, overdue work items, failed pipelines, and risky IR cases.

### How to Invoke

```
GET /api/cto/daily-command-center
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `userId` | string | `"tim"` | User identifier |
| `date` | string | today | ISO date string |
| `includeCalendar` | boolean | `true` | Include calendar data |
| `includeJira` | boolean | `true` | Include Jira data |
| `includeGitLab` | boolean | `true` | Include GitLab data |
| `includeGitHub` | boolean | `true` | Include GitHub data |
| `includeRoadmap` | boolean | `true` | Include roadmap data |
| `includeWorkItems` | boolean | `true` | Include work items |
| `includeJitbit` | boolean | `true` | Include Jitbit data |
| `daysBack` | number | `7` | Lookback window (1-30) |

### Create Work Items

```
POST /api/cto/daily-command-center/create-work-items
```

Body: `{ items: WorkItemCreateParams[] }` (max 25 items). Creates suggested work items from the brief.

### Graceful Degradation

Each integration is independently fetched. If an integration is not configured (missing env vars), the brief omits that section and marks the source as `available: false` in the response. The brief still generates from whatever sources are available.

---

## Personal OS Brief

Provides a holistic daily operating brief that aggregates signals across all connected integrations.

### What It Does

Generates 9 sections from your integration data:

1. **Today's Load** — counts for calendar events, work items by status, PRs/MRs, tickets, failed pipelines
2. **Open Loops** — unresolved decisions, blocked tasks, PRs awaiting review, follow-ups
3. **Decisions Waiting** — work items of type `decision` that are not done, blocked roadmap items
4. **Recurring Patterns** — meeting overload, context switching, review bottlenecks, support spikes
5. **Suggested Delegations** — low/medium priority items delegatable to support agents, team leads, team members
6. **Suggested Focus Blocks** — calendar gaps mapped to deep work, review, admin blocks
7. **Energy / Context-Switching Risks** — back-to-back meetings, no breaks, late-day deep work
8. **Things To Stop Doing** — patterns and energy risks that suggest stopping or reducing activities
9. **Work Items To Create** — up to 10 suggestions from critical/high open loops

### Sub-Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/personal-os/brief` | Full brief |
| GET | `/api/personal-os/open-loops` | Open loops and decisions waiting |
| GET | `/api/personal-os/patterns` | Recurring patterns |
| POST | `/api/personal-os/work-items` | Create work items from brief |

### Parameters (Brief)

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `userId` | string | `"tim"` | User identifier |
| `date` | string | today | ISO date string |
| `daysBack` | number | `7` | Lookback window (1-30) |
| `includeCalendar` | boolean | `true` | Include calendar data |
| `includeJira` | boolean | `true` | Include Jira data |
| `includeGitLab` | boolean | `true` | Include GitLab data |
| `includeGitHub` | boolean | `true` | Include GitHub data |
| `includeWorkItems` | boolean | `true` | Include work items |
| `includeJitbit` | boolean | `true` | Include Jitbit data |
| `includeRoadmap` | boolean | `true` | Include roadmap data |
| `includeMemory` | boolean | `true` | Include conversation memory |

### Open Loop Sources

- Blocked work items (type: `task`)
- Waiting work items (type: `approval`)
- Jira issues in "progress" status
- Open GitHub PRs (type: `followup`)
- Open GitLab MRs (type: `followup`)
- Jitbit follow-up tickets (type: `followup`)

### Pattern Detection

| Pattern | Trigger | Category |
|---------|---------|----------|
| Recurring task | 3+ open items of same type | `recurring_task` |
| Meeting overload | 4+ hours of meetings in a day | `meeting_overload` |
| Review bottleneck | 3+ open PRs/MRs | `review_bottleneck` |
| Support spike | 5+ recent Jitbit tickets | `support_spike` |
| Context switch | Activity across 4+ source types | `context_switch` |

### Design Constraints

- No invasive monitoring — reads existing integration data only
- No auto-changing calendar — only suggests focus blocks
- No health/fitness decisions — only suggests protecting focus time
- Uses policy engine for approval gates on `create_work_items`
- All read-only endpoints are `low` risk; `create_work_items` is `medium` risk

---

## Product Chief of Staff

Turns ideas, customer signals, support trends, roadmap data, and engineering status into clear product direction.

### What It Does

**Workflow Brief** (`product.workflow_brief`) — Takes a raw product idea and produces a structured workflow-first brief with 15 fields: problem, users, actors, job-to-be-done, trigger, desired outcome, current/proposed workflows, friction, automation opportunities, human-in-the-loop, MVP scope, non-goals, risks, and success criteria. Falls back to a template if AI is unavailable.

**Roadmap Proposal** (`product.roadmap_proposal`) — Generates a roadmap proposal from a theme: why now, customer evidence, engineering impact, proposed milestones with target dates, work items, dependencies, risks, cut line, and demo criteria. Falls back to a skeletal proposal if AI fails.

**Roadmap Drift** (`product.roadmap_drift`) — Purely data-driven (no AI). Computes a drift score (0 = on track, 1 = severely drifted) from overdue milestone ratio, blocked item ratio, and inverse completion rate. Returns status: "on track" / "minor drift" / "significant drift".

**Customer Signals** (`product.customer_signals`) — Pulls tickets from Jitbit and detects:
- **repeated_ask** — subjects appearing 3+ times
- **high_friction** — tickets with 5+ comments or open 14+ days
- **stale_theme** — 3+ tickets open beyond lookback
- **waiting_on_roadmap** — 2+ high-priority unresolved tickets

Each signal includes severity, frequency, evidence, and recommendation.

**Weekly Update** (`product.weekly_update`) — Generates a weekly markdown product update from roadmap progress, work items, and customer signals: shipped, in-progress, blocked, customer signals, roadmap changes, decisions needed, next-week priorities.

**Create Work Items** (`product.create_work_items`) — Creates work items from proposals or signals. Requires approval (medium risk).

### API Endpoints

| Method | Path | Input | Description |
|--------|------|-------|-------------|
| POST | `/api/product/workflow-brief` | `{ idea, context? }` | Turn idea into workflow brief |
| POST | `/api/product/roadmap-proposal` | `{ theme, customerEvidence?, engineeringConstraints?, timeHorizon? }` | Generate roadmap proposal |
| GET | `/api/product/roadmap-drift` | `?roadmapId=` | Analyze roadmap drift |
| GET | `/api/product/customer-signals` | `?daysBack=14&limit=50` | Extract customer signals |
| POST | `/api/product/weekly-update` | `{ weekStart?, daysBack? }` | Generate weekly update |
| POST | `/api/product/work-items` | `{ items }` | Create work items |

### Design Constraints

- No roadmap mutation — drift and proposals are read-only; work items created only on explicit request
- Read-only endpoints are `low` risk; `create_work_items` is `medium` risk
- Falls back to structured templates when AI is not configured
- Jitbit signals degrade gracefully when Jitbit is not configured

---

## Code Review / Release Readiness

AI-powered code review and release readiness for GitHub PRs and GitLab MRs.

### What It Does

Fetches PR/MR metadata, changed files, diffs, CI/pipeline status, and existing comments, then generates a structured review.

**Code Review** produces:
- **Risk Level** — `low` | `medium` | `high` | `critical` (rule-based scoring + AI)
- **Recommendation** — `low_risk` | `ready_for_human_review` | `needs_changes` | `high_risk_hold`
- **What Changed** — plain-English summary
- **Must Fix** — blocking issues before merge
- **Should Fix** — non-blocking improvements
- **Test Gaps** — missing coverage
- **Security Concerns** — auth/token/secret patterns detected
- **Observability Concerns** — logging/metrics gaps
- **Migration / Compatibility Risks** — schema migration detection
- **Rollback Considerations** — what's needed to roll back
- **Suggested Review Comment** — copy-pasteable markdown

**Release Readiness** produces:
- Go / No-Go / Conditional Go recommendation
- Included changes, known risks, test status, deployment notes, rollback plan, customer impact, internal comms draft

### Risk Scoring

Algorithmic scoring (no AI) applied before AI review:

| Signal | Score |
|--------|-------|
| Migration files | +3 |
| Config changes | +2 |
| No tests AND 50+ lines added | +2 |
| CI failed | +3 |
| 25+ files changed | +1 |
| 500+ total lines changed | +1 |
| Per file matching security patterns | +2 |
| Per file matching config patterns | +1 |

Score mapping: >=8 critical, >=5 high, >=2 medium, else low.

### API Endpoints

| Method | Path | Input | Description |
|--------|------|-------|-------------|
| POST | `/api/code-review/github/pr` | `{ owner, repo, prNumber }` | Review GitHub PR |
| POST | `/api/code-review/gitlab/mr` | `{ projectId, mrIid }` | Review GitLab MR |
| POST | `/api/code-review/release-readiness` | `{ platform, ... }` | Release readiness report |

### Design Constraints

- **No auto-merge** — analysis only; merging requires explicit `github.merge_pull_request` / `gitlab.merge_merge_request`
- **No auto-post** — `generate_comment` returns markdown; posting requires separate action
- All review tools are `low` risk
- Falls back to rule-based analysis when AI is unavailable or returns malformed JSON

### Example

```
Tim: "Review PR #42 in org/repo"
Assistant: [calls code_review.github_pr]
→ returns CodeReview with risk level, must-fix items, and suggested comment
```

---

## Weekly Plan

Generates a weekly planning view across integrations.

### How to Invoke

```
GET /productivity/weekly-plan?startDate=2026-05-05&weeks=1&userId=tim
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `startDate` | string | today | ISO date for week start |
| `weeks` | number | `1` | Number of weeks to plan |
| `userId` | string | `"tim"` | User identifier |

---

## How to Add a New Agent/Helper

1. **Create the module directory** under `src/` (e.g., `src/my-agent/`)
2. **Implement the business logic** in a service class (e.g., `my-agent-service.ts`)
   - Export a singleton instance
   - Handle AI-unavailable fallbacks gracefully
   - Mark write operations as requiring approval via the policy engine
3. **Create API routes** in `src/routes/my-agent.ts`
   - Register routes with a Fastify plugin function
   - Use Zod schemas for input validation
   - Group under `/api/my-agent/`
4. **Register routes** in `src/server.ts`
   - Import the route plugin and register it
5. **Register tools** in `src/agent/tool-registry.ts`
   - Add tool definitions with name, description, parameters, risk level
   - Add handler functions in `src/agent/tool-dispatcher.ts`
6. **Write tests** alongside the module (e.g., `src/my-agent/__tests__/`)
7. **Update this document** and `README.md` with the new agent's details

### Conventions

- Read-only operations are `low` risk
- Write operations that create/modify external data are `medium` risk
- Destructive operations are `high` or `critical` risk
- Always provide a fallback when AI is not configured
- Gracefully degrade when dependent integrations are not configured
- Use the existing `WorkItemDatabase` for work item creation
- Follow the singleton export pattern (e.g., `export const myAgent = new MyAgent(...)`)