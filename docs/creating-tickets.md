# Creating Tickets with Coding Prompts

Every ticket (bug, feature, task) created in this project **must include a coding prompt**. This is required for automated agent handoff — our coding agents (Codex, Devin, Cursor Agent, etc.) rely on self-contained prompts to implement changes in a single pass.

## Why Coding Prompts?

| Without Coding Prompt | With Coding Prompt |
|---|---|
| Agent explores codebase (5-10 min) | Agent reads prompt (30 sec) |
| Agent guesses intent, may get wrong | Agent knows exact change and why |
| Multiple iterations to converge | Single-pass implementation |
| Inconsistent quality | Consistent, verifiable output |

## Required Format

Every coding prompt must include these 5 elements:

1. **File & Location** — exact file path and line range (e.g., `src/agent/providers/ollama-provider.ts:56-67`)
2. **Current Code** — the exact code block being replaced (so the agent can locate it)
3. **Replacement Code** — the complete new code block (no `...` placeholders, no "add logic here")
4. **Reasoning** — why this change solves the problem (helps the agent verify intent)
5. **Testing Checklist** — unit/integration tests to write or run after the change

## Template

```markdown
### Task 1: [Short title]

**File:** `src/path/to/file.ts`
**Lines:** 42-58

**Current code:**
```typescript
// exact current code here
```

**Replace with:**
```typescript
// exact replacement code here
```

**Why:** [1-2 sentence explanation]

---

### Task 2: [Short title]

**File:** `src/other/file.ts`
**Lines:** 100-120

**Current code:**
```typescript
// exact current code here
```

**Replace with:**
```typescript
// exact replacement code here
```

**Why:** [1-2 sentence explanation]

---

### Testing Checklist
- [ ] Unit test: [description]
- [ ] Integration test: [description]
```

## Examples

See [Issue #32](https://github.com/redsand/AIWorkAssistant/issues/32) for a complete example of a well-structured coding prompt with 5 tasks.

## Enforcement

Coding prompts are enforced at multiple layers:

1. **GitHub Issue Templates** — Bug report and feature request templates include a required "Coding Prompt" field. Blank issues are disabled via `.github/ISSUE_TEMPLATE/config.yml`.

2. **GitHub Actions** — `.github/workflows/validate-issue.yml` checks new/edited issues for coding prompt sections. Issues without a coding prompt are labeled `missing-coding-prompt` and receive an automated reminder comment.

3. **Jira Ticket Generator** — `src/engineering/jira-ticket-generator.ts` includes a `## Coding Prompt` section in every ticket description. When no coding prompt is provided, a placeholder reminder is included instead.

4. **AI Assistant** — The productivity assistant always generates coding prompts when creating or updating tickets, as specified in `AGENTS.md`.

## For AI Assistants

When creating tickets on behalf of users, always:

1. **Investigate the codebase** — identify exact files, line ranges, and current code
2. **Write the coding prompt** with current code, replacement code, and reasoning
3. **Include a testing checklist** — specify which tests to write or run
4. **If you cannot determine exact changes** — note this in the prompt and provide your best analysis

Never skip the coding prompt. If the change is exploratory or uncertain, say so explicitly in the reasoning section.