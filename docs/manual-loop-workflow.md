# Manual Loop Workflow

Use this guide to test v2 fixes for issues #53–#62 one at a time, without relying on the autonomous polling loop.

---

## Why Manual Testing

The autonomous loop is currently broken. Before re-enabling it, each fix must be verified:

1. Aicoder runs once on a specific issue and produces a PR.
2. Reviewer runs once and outputs findings.
3. You inspect the result manually.

---

## Prerequisites

| Requirement | Check |
|-------------|-------|
| Node.js 20+ | `node --version` |
| AIWorkAssistant server running | `curl http://localhost:3050/health` |
| `AIWORKASSISTANT_API_KEY` exported | `echo $AIWORKASSISTANT_API_KEY` |
| `GITHUB_TOKEN` exported | `echo $GITHUB_TOKEN` |
| Coding agent on PATH | `which codex` / `which claude` |

---

## Phase 1: Single-Cycle Aicoder Test

The `--issue` flag runs aicoder on a specific issue and exits — no polling loop.

**Terminal 1 — Start the server:**
```bash
cd ai-assist-tim
npm run dev
```

**Terminal 2 — Run aicoder on a specific issue:**
```bash
cd /path/to/target-project

npx tsx /path/to/ai-assist-tim/src/aicoder.ts \
  --issue 53 \
  --owner redsand \
  --repo AIWorkAssistant \
  --agent codex
```

> Use `--skip-poll` instead of `--issue` when you want to run one cycle against whatever issue the label queue returns (no specific issue targeted).

**Without a specific issue (label-queue, one-shot):**
```bash
npx tsx /path/to/ai-assist-tim/src/aicoder.ts \
  --owner redsand \
  --repo AIWorkAssistant \
  --agent codex \
  --skip-poll
```

**What to expect:**
- Aicoder fetches issue #53, generates a prompt, runs the agent, pushes a branch, opens a PR.
- Exits with code `0` on success, `1` on error.
- PR title will be `[AI] <issue title>`.

**Check exit code immediately after:**
```bash
echo "Exit code: $?"
```

---

## Phase 2: Manual Reviewer Run

The reviewer polls for `[AI]`-prefixed PRs. It does not have a one-shot mode, so run it and kill it after the first cycle completes.

**Terminal 3 — Run reviewer:**
```bash
cd /path/to/ai-assist-tim

npx tsx src/reviewer.ts \
  --repo AIWorkAssistant \
  --owner redsand \
  --poll-ms 0
```

> `--poll-ms 0` is one-shot mode: the reviewer runs exactly one cycle and exits cleanly.

**Expected log lines (one-shot cycle):**
```
[START]  Reviewer starting…
[POLL]   Scanning AIWorkAssistant for [AI] PRs…
[REVIEW] PR #<n>: [AI] <issue title>
  → security check…
  → QA check…
  → quality check…
[MERGE]  PR #<n> passed — merging     ← clean
  — OR —
[REWORK] PR #<n> has findings — posting rework prompt
```

---

## Phase 3: Per-Issue Verification

Run the checks below after each aicoder + reviewer cycle.

### Verification Checklist

| Check | Command | Expected Result |
|-------|---------|-----------------|
| Aicoder exit code | `echo $?` immediately after aicoder exits | `0` |
| Branch exists | `git branch -r \| grep ai/issue-53` | Branch listed |
| Diff is non-empty | `git diff main...HEAD --stat` | `> 0 files changed` |
| No placeholders | `git diff main...HEAD -U0 \| grep -E '^\+.*(TODO\|FIXME\|PLACEHOLDER)'` | No matches |
| PR opened | `gh pr list --search "[AI]" --json number,title` | PR listed |
| Reviewer output | Reviewer terminal output | `[MERGE]` or actionable `[REWORK]` findings |
| Convergence | Re-run aicoder on same issue | Second run detects no new work (exits 0, no new commits) |

### Issue-by-Issue Log Template

Copy this block for each issue as you test it:

```
Issue: #___
Date tested: ___________

[ ] Aicoder exit code: ___ (expected: 0)
[ ] Branch: git diff main...HEAD --stat → ___ files changed
[ ] No placeholders: clean / found: ___________
[ ] PR #___: <title>
[ ] Reviewer output: [MERGE] / [REWORK]: ___________
[ ] Convergence: second run exits 0 with no new commits

Notes:
___________________________________________________________
```

---

## Exit Code Reference

| Code | Meaning |
|------|---------|
| `0` | Success — FIN detected or clean exit |
| `1` | Error — missing credentials, PR creation failed, or agent error |
| `130` | Killed by Ctrl+C (`SIGINT`) |
| `143` | Killed by `kill` / systemd (`SIGTERM`) |
| `-1` | Internal: agent failed to start or launcher error |

---

## Common Failures and Fixes

**"No qualifying issues found"**
- Issue #N must have the `ready-for-agent` label (exact, case-sensitive).
- Issue body must contain a `## Coding Prompt` section.

**"FIN signal not detected — skipping push"**
- The coding agent ran but never printed `FIN`. Add `Output "FIN" when done.` to the issue's Coding Prompt section.

**"Agent exited with code 1 — aborting"**
- Check agent credentials: `CODEX_API_KEY` for codex, Claude Code CLI installed for claude.
- Run `which codex` / `which claude` to confirm the binary is on PATH.

**Reviewer finds no PRs**
- PR title must start with `[AI]`. Aicoder always adds this prefix.
- Confirm `--repo` matches the exact repo name (case-sensitive).

**`git diff main...HEAD --stat` shows 0 files changed**
- The agent ran but made no code changes. Check the agent output for errors.
- Re-run with `--debug` flag if available, or inspect the agent run via `http://localhost:3050` → Agent Runs.

---

## Re-enabling Autonomous Mode

Once all issues #53–#62 pass the checklist above:

1. Remove `--issue` and `--max-cycles 1` from the aicoder command.
2. Set `--poll-ms 60000` (or use `AICODER_POLL_MS` in `.env`).
3. Run reviewer without `--poll-ms 999999` (default 30s interval is fine).
4. See `docs/autonomous-loop.md` for full production setup.
