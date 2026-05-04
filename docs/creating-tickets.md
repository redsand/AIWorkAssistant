# Creating Tickets with Coding Prompts

## Why Coding Prompts?

Our coding agents (Codex, Devin, Cursor Agent) rely on tickets containing a **coding prompt** — a self-contained specification with:

- **Exact file paths** — where to make changes
- **Current code** — what the code looks like now (with line numbers)
- **Replacement code** — what the new code should look like
- **Reasoning** — why this change solves the problem

Without a coding prompt, agents waste cycles exploring the codebase and often produce incorrect changes. With a coding prompt, agents can make precise, correct changes on the first attempt.

## Template

Every bug report and feature request must include a coding prompt. Use this template:

```markdown
## Coding Prompt

### File: [path/to/file.ts] (line X-Y)

### Current Code
```typescript
// Paste the current code here
```

### Replacement Code
```typescript
// Paste the new code here
```

### Reasoning
Explain why this change solves the problem or implements the feature.
Reference any related issues, design decisions, or constraints.
```

## Examples

### Example 1: Bug Fix — SSE Stream Error Handling

```markdown
## Coding Prompt

### File: web/js/live.js (line 45-58)

### Current Code
```javascript
const pump = async () => {
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffer.trim()) {
        processChunk("\n", true);
      }
      cleanup();
      break;
    }
    const result = processChunk(
      decoder.decode(value, { stream: true }),
      false,
    );
    if (result.stop) break;
  }
};
```

### Replacement Code
```javascript
const pump = async () => {
  while (true) {
    if (abortController.signal.aborted) break;
    let result;
    try {
      result = await reader.read();
    } catch (err) {
      if (!abortController.signal.aborted) cleanup();
      break;
    }
    const { done, value } = result;
    if (done) {
      if (buffer.trim()) {
        processChunk("\n", true);
      }
      cleanup();
      break;
    }
    const chunkResult = processChunk(
      decoder.decode(value, { stream: true }),
      false,
    );
    if (chunkResult.stop) break;
  }
};
```

### Reasoning
The original `pump()` function doesn't handle the case where `reader.read()` throws
(e.g., when the SSE stream is already closed or the connection drops). This causes
`Cannot read properties of undefined (reading 'stop')` because `result` is undefined
after the error. Wrapping `reader.read()` in try/catch prevents the unhandled error
and ensures `cleanup()` is called properly.
```

### Example 2: New Feature — Health Status Indicator

```markdown
## Coding Prompt

### File: web/js/chat.js (after line 30)

### Current Code
(No code exists — this is a new feature)

### Replacement Code
```javascript
let healthData = null;

export function getHealthData() {
  return healthData;
}

export function updateStatusIndicator(data) {
  const statusText = document.querySelector(".status-text");
  const statusIndicator = document.querySelector(".status-indicator");
  if (!statusText || !statusIndicator) return;

  if (!data) {
    statusText.textContent = "Disconnected";
    statusIndicator.className = "status-indicator status-error";
    return;
  }

  const providerOk = data.provider?.configured && data.provider?.valid;
  if (providerOk) {
    statusText.textContent = `Connected · ${data.provider.active}`;
    statusIndicator.className = "status-indicator status-ok";
  } else {
    statusText.textContent = "Disconnected";
    statusIndicator.className = "status-indicator status-error";
  }
}
```

### Reasoning
The UI needs to display real-time connection status. The `updateStatusIndicator`
function reads the health check response and updates the status text and indicator
dot color. This replaces the hardcoded "Connected" text with dynamic state.
```

### Example 3: Security Fix — XSS Sanitization

```markdown
## Coding Prompt

### File: web/js/sidebar.js (line 85-92, in loadRoadmaps)

### Current Code
```javascript
html += `<div class="roadmap-item" onclick="viewRoadmap('${roadmap.id}','${roadmap.name.replace(/'/g, "\\'")}')">`;
html += `<div class="roadmap-name">${roadmap.name}</div>`;
```

### Replacement Code
```javascript
html += `<div class="roadmap-item" onclick="viewRoadmap('${escapeAttr(roadmap.id)}','${escapeAttr(roadmap.name)}')">`;
html += `<div class="roadmap-name">${escapeHtml(roadmap.name)}</div>`;
```

### Reasoning
The original code only escapes single quotes in the onclick attribute, leaving it
vulnerable to XSS via HTML injection. Using `escapeAttr()` for attribute values
and `escapeHtml()` for text content properly sanitizes all user-sourced data.
```

## Coding Prompt Quality Checklist

Before submitting a ticket, verify:

- [ ] **File path is exact** — no vague references like "the auth file"
- [ ] **Line numbers are correct** — verify against current `main` branch
- [ ] **Current code is accurate** — copy-paste from the actual file, don't paraphrase
- [ ] **Replacement code is complete** — no `...` or "add your code here" placeholders
- [ ] **Reasoning explains the "why"** — not just the "what"
- [ ] **No exploration needed** — an agent should be able to make the change without reading other files

## Enforcement

This project enforces coding prompts through three layers:

1. **Issue Templates** — Bug reports and feature requests require a `coding_prompt` field
2. **GitHub Action** — `validate-issue.yml` auto-labels `missing-coding-prompt` and posts a reminder
3. **Jira Generator** — Includes `## Coding Prompt` section in every ticket (with placeholder if missing)
4. **AGENTS.md** — AI agents read this and know to always include prompts

## For AI Agents

When creating tickets programmatically (e.g., via the Jira ticket generator), always include a `## Coding Prompt` section in the description. If you don't have the exact current code, include:

- The file path(s) to modify
- A description of what the current code does
- The exact replacement code
- The reasoning for the change

See `src/engineering/jira-ticket-generator.ts` for the implementation.