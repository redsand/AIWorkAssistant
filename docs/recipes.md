# Prompt Recipes

Prompt recipes are structured AI prompts for common workflows. Currently, recipes are generated dynamically through the ticket bridge and engineering endpoints rather than stored as standalone recipe objects.

---

## Available Prompt Generation

### Ticket-to-Task

Converts a GitHub issue, Jira ticket, or roadmap item into a structured implementation prompt for a coding agent.

```
POST /api/ticket-bridge/prompt
Content-Type: application/json

{
  "sourceType": "github",
  "sourceId": "123",
  "owner": "your-org",
  "repo": "your-repo",
  "skipMissingCodingPrompt": false,
  "context": {
    "codebaseIndex": true,
    "architecture": true,
    "relatedTickets": true,
    "acceptanceCriteria": true,
    "maxFiles": 10,
    "maxTokens": 8000
  }
}
```

Source types: `github`, `jira`, `roadmap`, `gitlab`, `jitbit`

The generated prompt includes:
- Issue title and body
- Extracted acceptance criteria (checkbox items)
- Codebase context (relevant files from the indexer)
- Architecture constraints (TypeScript strict mode, SQLite, Zod, singleton exports)
- Related ticket links

### Engineering Briefs

```
POST /engineering/workflow-brief
POST /engineering/architecture-proposal
POST /engineering/scaffolding-plan
POST /engineering/jira-tickets
```

These generate structured engineering prompts from high-level ideas. See the [agents doc](agents.md) for details.

### Product Briefs

```
POST /api/product/workflow-brief
POST /api/product/roadmap-proposal
```

These generate product-oriented prompts. See the [agents doc](agents.md) for details.

---

## How to Run

### Via API

```bash
# Generate a prompt from a GitHub issue
curl -X POST http://localhost:3050/api/ticket-bridge/prompt \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-key" \
  -d '{"sourceType":"github","sourceId":"123","owner":"your-org","repo":"your-repo"}'

# Generate an engineering workflow brief
curl -X POST http://localhost:3050/engineering/workflow-brief \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-key" \
  -d '{"idea":"Build a rate limiter for the API","context":"We need to protect against abuse"}'
```

### Via Autonomous Loop

The `aicoder` agent automatically calls `POST /api/ticket-bridge/prompt` when it picks up a GitHub issue labeled `ready-for-agent`. See [autonomous-loop.md](autonomous-loop.md) for full details.

### Via CLI

```bash
# Convert a GitHub issue to a task prompt
npm run cli -- ticket-to-task 123

# Convert for a specific agent
npm run cli -- ticket-to-task 123 --agent codex
npm run cli -- ticket-to-task 123 --agent claude
```

---

## Adding a New Prompt Template

The prompt generation system is code-driven, not configuration-driven. To add a new prompt template:

1. **Identify the source** — Will this prompt come from a ticket type, an idea, or another trigger?
2. **Add the generation logic** — In `src/integrations/ticket-bridge/ticket-bridge.ts` for ticket-to-task, or in the relevant service class (e.g., `src/product/product-chief-of-staff.ts`, `src/engineering/workflow-brief.ts`)
3. **Add the API route** — Create or extend a route in `src/routes/` with Zod validation
4. **Register the tool** — Add the tool definition in `src/agent/tool-registry.ts` and the handler in `src/agent/tool-dispatcher.ts`
5. **Update this doc** — Add the new prompt to the list above

### Prompt Template Structure

Each prompt generator should follow this pattern:

```typescript
interface PromptResult {
  content: string;        // The full prompt markdown
  metadata: {
    source: string;        // "github" | "jira" | "roadmap" | ...
    sourceId: string;      // Original ticket/issue ID
    modelHint?: string;    // Suggested AI model
    estimatedTokens?: number;
  };
}
```

### Architecture Constraints Included in Prompts

The ticket bridge automatically includes these constraints in generated prompts:

- TypeScript strict mode
- Singleton export pattern
- SQLite for persistence
- Zod for validation
- No comments policy (code is self-documenting)

These are hardcoded in `src/integrations/ticket-bridge/ticket-bridge.ts` and can be extended there.