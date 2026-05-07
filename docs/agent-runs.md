# Agent Runs

Agent Runs provide SQLite-backed tracing of AI agent executions. Every run records tool calls, duration, status, token usage, and error messages — with automatic secret redaction before storage.

---

## What Is Traced

### Per Run

| Field | Description |
|-------|-------------|
| `id` | UUID primary key |
| `sessionId` | Optional session identifier |
| `userId` | User who initiated the run |
| `mode` | Agent run mode |
| `model` | LLM model name (populated on completion) |
| `status` | `running`, `completed`, or `failed` |
| `errorMessage` | Error text if the run failed |
| `promptTokens` | Token usage: prompt |
| `completionTokens` | Token usage: completion |
| `totalTokens` | Token usage: total |
| `toolLoopCount` | Number of tool-use iterations |
| `startedAt` | ISO timestamp when run started |
| `lastActivityAt` | ISO timestamp of last step (updated per step) |
| `completedAt` | ISO timestamp when run completed or failed |
| `cancelledAt` | ISO timestamp if run was cancelled by user |

### Per Step

| Field | Description |
|-------|-------------|
| `id` | UUID primary key |
| `runId` | Foreign key to the parent run |
| `stepType` | Step category (see below) |
| `toolName` | Name of the tool, if this is a tool_call step |
| `content` | Arbitrary content (JSON, truncated to 10,000 chars) |
| `sanitizedParams` | Tool parameters with secrets redacted (JSON, 10K chars max) |
| `success` | Whether the step succeeded |
| `errorMessage` | Error text if the step failed |
| `durationMs` | Step execution duration in milliseconds |
| `stepOrder` | Sequence position within the run |
| `createdAt` | ISO timestamp when step was recorded |

### Step Types

| Step Type | Description |
|-----------|-------------|
| `model_request` | Request sent to the AI model |
| `model_response` | Response received from the AI model |
| `thinking` | AI reasoning content |
| `content` | Final content output |
| `tool_call` | Tool invocation |
| `tool_result` | Result from a tool execution |
| `approval_requested` | Action waiting for user approval |
| `error` | Error occurred |
| `note` | Developer/system note |

---

## How to Inspect Runs

### API Endpoints

All endpoints are under `/api/agent-runs`. These are **read-only** — runs and steps are created internally by the application, not via HTTP.

#### List Runs

```
GET /api/agent-runs?status=failed&userId=tim&limit=20&offset=0
```

| Parameter | Description |
|-----------|-------------|
| `status` | Filter by status: `running`, `completed`, `failed` |
| `userId` | Filter by user |
| `limit` | Results per page |
| `offset` | Pagination offset |

#### Get Run with Steps

```
GET /api/agent-runs/:id
```

Returns the run plus all its steps in a single response.

#### Get Steps Only

```
GET /api/agent-runs/:id/steps
```

Returns just the steps for a given run.

#### Aggregate Statistics

```
GET /api/agent-runs/stats
```

Returns: `totalRuns`, `completedRuns`, `failedRuns`, `runningRuns`, `avgToolLoopCount`, `runsLast24h`, `totalStepsLast24h`.

### Web UI

Navigate to the **Agent Runs** page in the sidebar to browse runs, filter by status, and drill into step timelines.

### Database Query

For direct inspection, the SQLite database is at `data/agent-runs.db`:

```sql
-- Recent failed runs
SELECT id, mode, error_message, started_at, completed_at
FROM agent_runs
WHERE status = 'failed'
ORDER BY started_at DESC
LIMIT 10;

-- Steps for a specific run
SELECT step_type, tool_name, success, error_message, duration_ms
FROM agent_run_steps
WHERE run_id = '<run-id>'
ORDER BY step_order;

-- Stats
SELECT status, COUNT(*) FROM agent_runs GROUP BY status;
```

---

## Debugging Failed Runs

### Common Error Patterns

| Pattern | Likely Cause | Resolution |
|---------|-------------|------------|
| `status = 'failed'` with no steps | Model connection failure | Check AI provider env vars (`AI_PROVIDER`, API key) |
| `tool_result` with `success = 0` | Tool execution error | Check the step's `errorMessage` for specifics |
| `status = 'failed'` with `cancelled_at` set | User cancelled the run | Not an error — user-initiated cancellation |
| `error_message = "Run timed out (stale)"` | Run inactive for 30+ minutes | Agent hung or lost connection; check external service health |
| `tool_loop_count` high (20+) | Agent stuck in a loop | Likely missing task completion signal; review the loop steps |
| `sanitizedParams` with `"[REDACTED]"` | Normal — secrets redacted | Not an error; redaction is by design |

### Staleness Detection

Runs still in `running` status after 30 minutes of inactivity (`last_activity_at`) are automatically marked as `failed` with message `"Run timed out (stale)"`. This happens when:
- The `markStaleRunsAsFailed()` method is called (during cleanup or on server restart)
- The cleanup job runs (deletes non-running runs older than 30 days)

---

## Secret Redaction

### How It Works

The sanitizer performs **recursive key-name-based redaction** on all data before storage. When an object property's key (case-insensitive) matches one of the redacted field names, the value is replaced with `"[REDACTED]"`.

### Redacted Field Names

- `apikey`
- `api_key`
- `token`
- `password`
- `authorization`
- `secret`
- `access_token`
- `refresh_token`

### What Is Not Redacted

- **Values** — The sanitizer does not scan string values for patterns that look like API keys or tokens. Only object property keys are checked.
- **Non-object data** — Primitives (strings, numbers, booleans, null) pass through unchanged.
- **Nested objects** — Are recursively sanitized, but only key names trigger redaction.

### Example

```typescript
// Input
{
  "model": "gpt-4",
  "api_key": "sk-abc123",
  "headers": {
    "authorization": "Bearer xyz",
    "content-type": "application/json"
  }
}

// After sanitization
{
  "model": "gpt-4",
  "api_key": "[REDACTED]",
  "headers": {
    "authorization": "[REDACTED]",
    "content-type": "application/json"
  }
}
```

### Content Truncation

Both `content` and `sanitizedParams` JSON strings are hard-truncated at 10,000 characters before storage. This prevents the database from growing unboundedly with large tool responses.