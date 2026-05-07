# Autonomous Loop — Deployment & Usage Guide

The autonomous loop is a two-agent system that takes a GitHub issue from `ready-for-agent` label all the way to a merged PR with no human involvement:

```
Issue (labeled ready-for-agent)
  → [aicoder] generates prompt, runs coding agent, opens PR
  → [reviewer] reviews PR, merges or posts rework prompt
  → rework re-labeled → aicoder picks up → repeat until merged
```

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js 20+ | For running the server and CLIs |
| GitHub token | Needs `repo` scope (read/write issues, PRs, branches) |
| Coding agent | `codex`, `opencode`, or `claude` CLI installed and on `PATH` |
| AIWorkAssistant server | This repo, running and reachable |

---

## Part 1: Deploy the AIWorkAssistant Server

The server is the brain. Both `aicoder` and `reviewer` communicate with it for config, work items, prompt generation, and review delegation.

### 1.1 Install and configure

```bash
git clone <repo-url>
cd ai-assist-tim
npm install
cp .env.example .env
```

Edit `.env` — minimum required settings:

```bash
# Server
PORT=3050
NODE_ENV=production

# Auth (aicoder + reviewer connect with this key)
AUTH_USERNAME=admin
AUTH_PASSWORD=your-strong-password

# GitHub (the repo(s) aicoder will work on)
GITHUB_TOKEN=ghp_your_token_here
GITHUB_DEFAULT_OWNER=your-org
GITHUB_DEFAULT_REPO=your-repo

# AI provider for prompt generation and review
AI_PROVIDER=opencode        # or ollama or zai
OPENCODE_API_KEY=your_key
OPENCODE_API_URL=https://opencode.ai/zen/go/v1

# Autonomous loop — repos reviewer will watch (comma-separated)
REVIEW_REPOS=your-repo,another-repo
REVIEW_POLL_INTERVAL_MS=30000
REVIEW_MAX_CYCLES=5
```

### 1.2 Start the server

```bash
# Development
npm run dev

# Production
npm run build && npm start

# Docker
docker-compose up -d
```

Verify it is running:

```bash
curl http://localhost:3050/health
```

You should see a JSON response with integration statuses.

### 1.3 Generate an API key

The `aicoder` and `reviewer` CLIs authenticate using `AIWORKASSISTANT_API_KEY`. Use the same value you set for `AUTH_PASSWORD` in `.env`, or create a dedicated token if you have a more complex auth setup.

---

## Part 2: Run `aicoder` (Agent 1)

`aicoder` polls the server for issues, runs the coding agent, and opens PRs. It runs in the **target project's workspace** (the repo it will write code to).

### 2.1 Environment variables (aicoder)

Create a `.env` or export these in the shell where you run `aicoder`:

```bash
# AIWORKASSISTANT_URL defaults to http://localhost:3050 — only set if running remotely
# AIWORKASSISTANT_URL=http://your-remote-server:3050
AIWORKASSISTANT_API_KEY=your-server-api-key   # must match AIWORKASSISTANT_API_KEY in server .env

# Optional overrides (server provides defaults from its own .env)
AICODER_OWNER=your-org            # GitHub owner
AICODER_REPO=your-repo            # GitHub repo
AICODER_LABEL=ready-for-agent    # Issue label to poll (default)
AICODER_AGENT=codex               # codex | opencode | claude
AICODER_WORKSPACE=/path/to/repo  # Target repo directory (default: cwd)
AICODER_POLL_MS=60000             # Poll interval ms
AICODER_MAX_CYCLES=0              # 0 = run forever

# Coding agent config (passed to the agent subprocess)
CODEX_MODEL=o4-mini               # for codex agent
CODEX_API_KEY=your-openai-key     # for codex agent
FIN_SIGNAL=FIN                    # completion token (default)
```

### 2.2 Run aicoder

```bash
# From the target repo directory
cd /path/to/your-project

# Run with npm scripts (from ai-assist-tim)
npm run aicoder

# Or run directly with tsx
npx tsx /path/to/ai-assist-tim/src/aicoder.ts

# Or with CLI flags
npx tsx /path/to/ai-assist-tim/src/aicoder.ts \
  --workspace /path/to/your-project \
  --owner your-org \
  --repo your-repo \
  --agent codex \
  --poll-ms 60000
```

### 2.3 CLI flags reference (aicoder)

| Flag | Env override | Default | Description |
|------|-------------|---------|-------------|
| `--workspace <path>` | `AICODER_WORKSPACE` | cwd | Target repo directory |
| `--repo <name>` | `AICODER_REPO` | server default | GitHub repo name |
| `--owner <name>` | `AICODER_OWNER` | server default | GitHub owner/org |
| `--agent <name>` | `AICODER_AGENT` | `codex` | `codex`, `opencode`, or `claude` |
| `--label <label>` | `AICODER_LABEL` | `ready-for-agent` | Issue label to filter |
| `--poll-ms <ms>` | `AICODER_POLL_MS` | `60000` | Poll interval |
| `--max-cycles <n>` | `AICODER_MAX_CYCLES` | `0` (unlimited) | Stop after n work cycles |

### 2.4 What aicoder does per issue

1. Calls `GET /api/autonomous-loop/work` — finds issues labeled `ready-for-agent`
2. Calls `POST /api/ticket-bridge/prompt` — generates full implementation prompt with codebase context
3. Creates a git branch (e.g., `ai/issue-123-fix-login`)
4. Spawns the coding agent (codex/opencode/claude) with the prompt piped to stdin/args
5. Watches stdout for the `FIN` token — when detected, kills the agent
6. Runs `git push origin <branch>`
7. Calls `POST /api/autonomous-loop/pr` — opens PR titled `[AI] <issue title>`, closes `#<issueNumber>`
8. Calls `POST /api/autonomous-loop/complete` — notifies server, posts comment on issue
9. Sleeps `AICODER_POLL_MS`, then repeats

---

## Part 3: Run `reviewer` (Agent 2)

`reviewer` watches for AI-generated PRs, runs multi-agent review, and either merges them or posts a rework prompt.

### 3.1 Environment variables (reviewer)

```bash
# AIWORKASSISTANT_URL defaults to http://localhost:3050 — only set if running remotely
# AIWORKASSISTANT_URL=http://your-remote-server:3050
AIWORKASSISTANT_API_KEY=your-server-api-key   # must match AIWORKASSISTANT_API_KEY in server .env

# Required — GitHub access for listing/merging PRs
GITHUB_TOKEN=ghp_your_token_here
GITHUB_DEFAULT_OWNER=your-org

# Repos to watch (comma-separated)
REVIEW_REPOS=your-repo,another-repo

# Optional tuning
REVIEW_POLL_INTERVAL_MS=30000   # How often to scan for PRs
REVIEW_MAX_CYCLES=5             # Max rework cycles per PR before blocking
```

> When `AIWORKASSISTANT_URL` + `AIWORKASSISTANT_API_KEY` are set, reviewer fetches all config from the server. You can omit the `REVIEW_*` vars and set them server-side in `.env` instead.

### 3.2 Run reviewer

```bash
# From ai-assist-tim directory
npm run reviewer

# Or directly
npx tsx /path/to/ai-assist-tim/src/reviewer.ts

# With CLI flags
npx tsx /path/to/ai-assist-tim/src/reviewer.ts \
  --repo your-repo,another-repo \
  --owner your-org \
  --poll-ms 30000
```

### 3.3 CLI flags reference (reviewer)

| Flag | Env override | Default | Description |
|------|-------------|---------|-------------|
| `--repo <names>` | `REVIEW_REPOS` | server config | Comma-separated repos to watch |
| `--owner <name>` | `GITHUB_DEFAULT_OWNER` | server config | GitHub owner |
| `--poll-ms <ms>` | `REVIEW_POLL_INTERVAL_MS` | `30000` | Poll interval |

### 3.4 What reviewer does per PR

1. Calls `GET /repos/{owner}/{repo}/pulls` — lists open PRs
2. Filters for AI PRs: title starts with `[AI]` or author login contains "ai"
3. Counts previous review cycles (by counting "Review Failed" comments) — stops at `REVIEW_MAX_CYCLES`
4. Calls `POST /api/reviewer/review` on the server — runs multi-agent review (security, QA, quality)
5. **If clean**: posts "Review Passed" comment, auto-merges the PR
6. **If findings**: posts review findings on PR, posts rework prompt on the linked issue (`Closes #N`)
7. Rework prompt gets posted on the original issue → aicoder picks it up on next poll

---

## Part 4: The Complete Loop End-to-End

### 4.1 Issue setup

For aicoder to pick up an issue, it needs:

1. The `ready-for-agent` label (or whatever `AICODER_LABEL` is set to)
2. A `## Coding Prompt` section in the issue body with implementation instructions

Example issue body:

```markdown
## Summary
Fix the login redirect bug where users are sent to /dashboard instead of /home after auth.

## Coding Prompt

### Task
Update `src/auth/callback.ts` to redirect to `/home` instead of `/dashboard` after successful login.

### Acceptance Criteria
- [ ] Login redirect goes to `/home`
- [ ] Tests pass
- [ ] No regression in logout flow

### Notes
The redirect is set at line 47 in `src/auth/callback.ts`.
Output "FIN" when done.
```

> The `FIN` token in the coding prompt tells the agent to print it when finished, which signals aicoder to stop the agent and push the branch.

### 4.2 Full flow walkthrough

```
1. You create GitHub issue #123 with "ready-for-agent" label

2. aicoder polls → finds issue #123
   → fetches prompt from server (with codebase index + acceptance criteria)
   → creates branch "ai/issue-123-fix-login-redirect"
   → spawns: codex --model o4-mini --approval-mode full-auto -q "<prompt>"
   → codex writes code, prints "FIN" when done
   → aicoder detects FIN, kills codex, pushes branch
   → aicoder opens PR #45: "[AI] Fix login redirect bug" (Closes #123)
   → aicoder posts comment on issue #123: "🤖 AiRemoteCoder completed work"

3. reviewer polls → finds PR #45 (starts with [AI])
   → calls server /api/reviewer/review
   → server runs security + QA + quality analysis

   SCENARIO A — Review passes:
   → reviewer posts "✅ Review Passed — Merging" on PR #45
   → reviewer merges PR #45
   → done ✓

   SCENARIO B — Review finds issues:
   → reviewer posts findings on PR #45
   → reviewer posts rework prompt on issue #123:
     "## Coding Prompt\n### Rework from PR Review\nFix [high] security issue in src/auth/callback.ts..."
   → aicoder polls again → picks up issue #123 (still labeled ready-for-agent)
   → new branch, new agent run, new PR
   → review cycle repeats up to REVIEW_MAX_CYCLES times
```

### 4.3 Running both agents together

In production you'll want both running as background services. Here's a simple way to run both:

**Terminal 1 — aicoder:**
```bash
cd /path/to/your-project
AIWORKASSISTANT_URL=http://localhost:3050 \
AIWORKASSISTANT_API_KEY=your-key \
AICODER_AGENT=codex \
npx tsx /path/to/ai-assist-tim/src/aicoder.ts
```

**Terminal 2 — reviewer:**
```bash
cd /path/to/ai-assist-tim
AIWORKASSISTANT_URL=http://localhost:3050 \
AIWORKASSISTANT_API_KEY=your-key \
GITHUB_TOKEN=ghp_... \
REVIEW_REPOS=your-repo \
npx tsx src/reviewer.ts
```

**Or as PM2 processes:**
```bash
npm install -g pm2

# From ai-assist-tim directory
pm2 start "npm run dev" --name ai-assistant

# From target project directory
pm2 start "npx tsx /path/to/ai-assist-tim/src/aicoder.ts" \
  --name aicoder \
  --env AIWORKASSISTANT_URL=http://localhost:3050 \
  --env AIWORKASSISTANT_API_KEY=your-key

pm2 start "npx tsx /path/to/ai-assist-tim/src/reviewer.ts" \
  --name reviewer \
  --cwd /path/to/ai-assist-tim

pm2 save
pm2 startup   # auto-restart on reboot
```

---

## Part 5: Interactive CLI

The `ai-assistant` CLI lets you drive the server manually — useful for triggering one-off workflows, converting tickets to prompts, or running the agent interactively.

### 5.1 Run the CLI

```bash
# From ai-assist-tim
npm run cli -- <command>

# Or directly
npx tsx src/cli/cli.ts <command>
```

### 5.2 CLI commands

```bash
# Chat with the agent (productivity or engineering mode)
npm run cli -- chat "What's on my Jira board today?"
npm run cli -- chat "Review PR #42 in org/repo" engineering

# Convert a GitHub issue to an implementation prompt
npm run cli -- ticket-to-task 123
npm run cli -- ticket-to-task 123 --agent codex    # format for codex
npm run cli -- ticket-to-task 123 --agent claude   # format for claude

# Inspect a past agent run
npm run cli -- agent-run <runId>
```

---

## Part 6: Monitoring

### Server health

```bash
curl http://localhost:3050/health
curl http://localhost:3050/chat/health
```

### Agent runs (execution traces)

```bash
# List recent runs via API
curl -H "Authorization: Bearer your-key" \
  http://localhost:3050/api/agent-runs?limit=20

# Or open the web UI
open http://localhost:3050
# Navigate to Agent Runs in the sidebar
```

### Audit log

```bash
tail -f logs/audit.log
```

### Approvals queue

If `POLICY_APPROVAL_MODE=strict` is set, high-risk actions queue for approval:

```bash
# List pending approvals
curl -H "Authorization: Bearer your-key" \
  http://localhost:3050/api/guardrails/approvals/pending

# Approve
curl -X POST -H "Authorization: Bearer your-key" \
  http://localhost:3050/api/guardrails/approvals/<id>/approve
```

---

## Part 7: Troubleshooting

### aicoder: "No qualifying issues found"
- Confirm the issue has the `ready-for-agent` label (exact match, case-sensitive)
- Confirm the issue has a `## Coding Prompt` section — issues without it are skipped with `missing-coding-prompt`
- Check `AICODER_LABEL` matches what's on the issue

### aicoder: "FIN signal not detected — skipping push"
- The coding agent ran but never printed `FIN`
- Add `Output "FIN" when done.` to the coding prompt in the issue body
- For `codex` specifically: it responds to instructions in the prompt, not a hardcoded flag
- You can change the token: `FIN_SIGNAL=DONE` (must match what your coding prompt says)

### aicoder: agent fails to start
- Make sure the agent binary is on `PATH`: `which codex`, `which opencode`, `which claude`
- For `codex`: needs `CODEX_API_KEY` (OpenAI key) and `CODEX_MODEL=o4-mini`
- For `claude`: needs Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`)

### reviewer: "No GitHub token"
- Set `GITHUB_TOKEN` in `.env` or export it before running
- Or set `AIWORKASSISTANT_URL` + `AIWORKASSISTANT_API_KEY` so config is fetched from the server

### reviewer: PR not picked up
- PR title must start with `[AI]` OR the PR author's login must contain "ai"
- aicoder always prefixes titles with `[AI]`, so if PRs are created manually they need this prefix

### Server: `/api/ticket-bridge/prompt` returns `skipped: true`
- The issue body is missing a `## Coding Prompt` section
- Add one (see Issue Setup above) and re-label the issue

### Port conflict
```bash
# Windows
netstat -ano | findstr :3050
taskkill /PID <pid> /F

# Linux/Mac
lsof -i :3050 | awk 'NR>1{print $2}' | xargs kill
```
