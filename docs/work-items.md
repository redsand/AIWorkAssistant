# Work Items

Work Items are an internal task tracking system within AIWorkAssistant. They provide a unified view across all integrations — every task, decision, code review, follow-up, and more in one place with linking back to external sources.

---

## Data Model

### Types

Work items have 10 possible types:

| Type | Description |
|------|-------------|
| `task` | General task or to-do |
| `decision` | A decision that needs to be made |
| `code_review` | Code review item |
| `roadmap` | Roadmap-related work |
| `customer_followup` | Customer follow-up action |
| `detection` | Detection engineering work |
| `research` | Research or investigation |
| `personal` | Personal productivity item |
| `support` | Support ticket follow-up |
| `release` | Release-related work |

### Statuses

Work items flow through 7 statuses:

```
proposed → planned → active → blocked → waiting → done → archived
                                            ↓
                                          done
```

| Status | Description |
|--------|-------------|
| `proposed` | Newly suggested (default on creation) |
| `planned` | Accepted and scheduled |
| `active` | Currently being worked on |
| `blocked` | Cannot proceed due to dependency |
| `waiting` | Waiting on external input/approval |
| `done` | Completed |
| `archived` | Removed from active view |

### Priorities

| Priority | Description |
|----------|-------------|
| `low` | Non-urgent |
| `medium` | Standard (default) |
| `high` | Important |
| `critical` | Urgent/blocking |

### Sources

| Source | Description |
|--------|-------------|
| `manual` | Created directly by user (default) |
| `chat` | Created via chat/assistant |
| `jira` | Linked from Jira |
| `github` | Linked from GitHub |
| `gitlab` | Linked from GitLab |
| `jitbit` | Linked from Jitbit |
| `calendar` | From calendar integration |
| `roadmap` | From roadmap planning |
| `hawk-ir` | From HAWK IR case |

### Linked Resources

Work items can link to external resources. Each link has:

| Field | Description |
|-------|-------------|
| `type` | `jira`, `github`, `gitlab`, `jitbit`, `calendar`, `roadmap`, or `url` |
| `url` | URL to the external resource |
| `label` | Human-readable label (max 500 chars) |

Maximum 20 linked resources per work item.

### Notes

Work items support multiple notes. Each note has:

| Field | Description |
|-------|-------------|
| `id` | Auto-generated UUID |
| `author` | Note author |
| `content` | Note text |
| `createdAt` | Auto-generated timestamp |

Notes are stored as a JSON array in the database.

---

## API Endpoints

All endpoints are under `/api/work-items`.

### List

```
GET /api/work-items?status=active&type=task&priority=high&source=jira&owner=tim&search=keyword&includeArchived=false&limit=50&offset=0
```

Archived items are excluded by default. Set `includeArchived=true` to include them.

### Create

```
POST /api/work-items
Content-Type: application/json

{
  "type": "task",
  "title": "Review security audit findings",
  "description": "Go through the audit report and create follow-up items",
  "status": "proposed",
  "priority": "high",
  "owner": "tim",
  "source": "manual",
  "dueAt": "2026-05-15T00:00:00Z",
  "tags": ["security", "audit"],
  "linkedResources": [
    { "type": "url", "url": "https://example.com/audit-report", "label": "Audit Report" }
  ]
}
```

### Get

```
GET /api/work-items/:id
```

### Update

```
PATCH /api/work-items/:id
Content-Type: application/json

{
  "status": "active",
  "priority": "critical"
}
```

Partial update — only include fields you want to change.

### Add Note

```
POST /api/work-items/:id/notes
Content-Type: application/json

{
  "author": "tim",
  "content": "Started review, found 3 critical findings"
}
```

### Add Linked Resource

```
POST /api/work-items/:id/links
Content-Type: application/json

{
  "type": "jira",
  "url": "https://your-domain.atlassian.net/browse/PROJ-123",
  "label": "PROJ-123: Security audit follow-up"
}
```

### Complete

```
POST /api/work-items/:id/complete
```

Sets `status = 'done'` and `completed_at` to current timestamp.

### Archive

```
POST /api/work-items/:id/archive
```

Sets `status = 'archived'`. Item is hidden from default list views.

### Stats

```
GET /api/work-items/stats
```

Returns counts by status, type, priority, total count, and overdue count. Excludes archived items.

---

## Integration with CTO Daily Command Center

The CTO Daily Command Center uses work items in several ways:

1. **Brief sections** — Due today, overdue, blocked, and waiting work items appear in the "Work Items" section of the daily brief
2. **Suggested work items** — The brief auto-generates up to 12 suggested work items from:
   - Jitbit high-priority tickets → `customer_followup` type
   - Overdue work items → same type as original
   - Failed GitLab pipelines → `code_review` type
   - HAWK IR risky open cases → `customer_followup` type
3. **Create from brief** — `POST /api/cto/daily-command-center/create-work-items` creates suggested items

## Integration with Ticket Bridge

The Ticket Bridge system creates and updates work items to track agent handoffs:

1. **Handoff creation** — When an agent picks up a ticket, a `task`-type work item is created with the `"agent-handoff"` tag and metadata tracking the agent, branch, and start time
2. **Handoff completion** — When the agent finishes, the work item is updated with exit code, files changed, commit messages, and run duration. Status becomes `active` (success) or `waiting` (failure)
3. **Source linking** — The work item's `source` and `source_external_id` map back to the original ticket