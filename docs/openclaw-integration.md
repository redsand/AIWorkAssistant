# AI Assistant Integration Guide

This agent is designed to work with AI Assistant as the chat runtime interface.

## Tool/Skill Registration

Register the agent with AI Assistant using the tool definition in `ai-assistant-tools/agent-tool.json`:

```json
{
  "name": "ai-assistant-agent",
  "description": "Personal productivity and engineering copilot",
  "endpoint": "http://localhost:3000/chat",
  "modes": {
    "productivity": { ... },
    "engineering": { ... }
  }
}
```

## Usage

### Productivity Mode

```
User: "Plan my day today"

Agent Response:
Today's constraints:
- 3 meetings scheduled
- 5 assigned Jira tickets
- Low energy in afternoon

Recommended priorities:
1. Review urgent tickets (PROJ-123, PROJ-456)
2. Focus block: Implementation work
3. Code review for MR !42

Suggested schedule:
- 09:00-09:30: Standup
- 09:30-11:30: Focus: PROJ-123 implementation
- 11:30-12:00: Email and slack
- 12:00-13:00: Lunch break
- 14:00-15:30: Focus: PROJ-456
- 15:30-15:45: Afternoon break
- 16:00-17:00: Code reviews

Decisions needing approval:
- Post comment to PROJ-789 about merge status [Approve] [Reject]
```

### Engineering Mode

```
User: "I want to build a task management app"

Agent:
Let me help you design this properly. I need to understand the workflow first.

Who is the user?
- What role are they in? (developer, manager, executive)
- What are they trying to accomplish?

What triggers the workflow?
- When do they create tasks?
- What information do they have at that point?

What is the successful end state?
- What does "done" look like?

[Continues with workflow brief, architecture, scaffolding, and implementation plan]
```

## Tool Invocations

The agent can invoke tools based on user requests:

### Calendar Tools

```typescript
// List events
{
  "tool": "calendar.list_events",
  "params": {
    "startDate": "2026-04-30T00:00:00Z",
    "endDate": "2026-04-30T23:59:59Z"
  }
}

// Create focus block
{
  "tool": "calendar.create_focus_block",
  "params": {
    "title": "Deep work: PROJ-123",
    "startTime": "2026-04-30T09:00:00Z",
    "duration": 120,
    "description": "Work on authentication flow"
  },
  "approval": "required"
}
```

### Jira Tools

```typescript
// List assigned tickets
{
  "tool": "jira.list_assigned",
  "params": {
    "status": "In Progress",
    "limit": 10
  }
}

// Add comment
{
  "tool": "jira.add_comment",
  "params": {
    "key": "PROJ-123",
    "body": "GitLab commit abc123 relates to this ticket"
  },
  "approval": "required"
}
```

### Engineering Tools

```typescript
// Generate workflow brief
{
  "tool": "engineering.workflow_brief",
  "params": {
    "idea": "Task management app with real-time updates"
  }
}
```

## Approval Flow

When an action requires approval:

1. Agent proposes action with risk level
2. AI Assistant prompts user for approval
3. User approves or rejects
4. Agent executes or cancels action
5. Result logged to audit trail

Example approval prompt:

```
⚠️  Approval Required

Action: Post comment to Jira ticket PROJ-123
Risk Level: Medium
Reason: Creating external comment

Comment body:
"GitLab commit abc123 related to this ticket. See:
https://gitlab.com/project/repo/-/commit/abc123"

What will change:
- Comment will be added to PROJ-123
- Comment will be visible to all ticket watchers
- Notification will be sent to assignee

Rollback: Comment can be deleted, but notification sent

[Approve] [Reject] [View Details]
```

## Webhook Integration

### GitLab Webhooks

Configure GitLab webhook:

```
URL: http://your-domain.com/webhooks/gitlab
Secret: your_webhook_secret
Events: Push events, Merge request events
```

When events occur:

1. GitLab sends webhook to agent
2. Agent extracts Jira keys from commit/MR data
3. Agent evaluates policy
4. Agent posts comment or queues approval
5. Agent suggests transitions if MR merged

## Error Handling

### Integration Errors

```
User: "What's on my calendar today?"

Agent Error:
❌ Unable to connect to Microsoft Graph API

Possible causes:
- OAuth token expired
- Invalid credentials
- API unavailable

Next steps:
1. Check configuration
2. Re-authenticate if needed
3. Try again later

Fallback: Would you like me to help with something else?
```

### Policy Errors

```
User: "Delete all my meetings for today"

Agent Error:
🚫 Action Blocked

Reason: Deleting calendar events is not allowed
Policy: calendar.event.delete → BLOCKED

Alternative actions:
- I can reschedule meetings to different times
- I can block out focus time around meetings
- I can help you decline meetings (one at a time)

What would you like to do?
```

## Configuration

### Environment Variables

Set in AI Assistant configuration:

```bash
OPENCLAW_AGENT_URL=http://localhost:3000
OPENCLAW_AGENT_MODE=productivity  # or engineering
OPENCLAW_AGENT_USER_ID=user-123
```

### Tool Permissions

AI Assistant can restrict which tools are available:

```json
{
  "allowedTools": [
    "calendar.list_events",
    "jira.list_assigned",
    "productivity.generate_daily_plan"
  ],
  "blockedTools": ["calendar.event.delete", "jira.issue.close"]
}
```

## Monitoring

### Health Checks

AI Assistant should ping `/health` endpoint:

```bash
curl http://localhost:3000/health
```

Response:

```json
{
  "status": "ok",
  "timestamp": "2026-04-30T10:00:00Z",
  "version": "0.1.0"
}
```

### Approval Queue

AI Assistant can poll for pending approvals:

```bash
curl http://localhost:3000/approvals?status=pending
```

## Best Practices

1. **Always show risk level**: User should understand implications
2. **Provide context**: Explain why approval is needed
3. **Offer alternatives**: If action blocked, suggest options
4. **Log decisions**: Keep audit trail for compliance
5. **Handle errors gracefully**: Degrade gracefully if integrations fail
6. **Respect user time**: Don't prompt for approvals on trivial actions
7. **Be transparent**: Show what will change before executing

## Troubleshooting

### Connection Issues

If AI Assistant can't reach the agent:

1. Check agent is running: `curl http://localhost:3000/health`
2. Verify CORS configuration
3. Check firewall rules
4. Review agent logs

### Approval Timeouts

If approvals timeout:

1. Check approval queue: `GET /approvals`
2. Verify approval IDs match
3. Review audit logs for failures
4. Check agent logs for errors

### Missing Tool Responses

If tools don't respond:

1. Check OpenCode API configuration
2. Verify tool registration in AI Assistant
3. Review agent logs for errors
4. Test tool directly via API

## Security

### Authentication

Future: Implement authentication between AI Assistant and agent:

```bash
# JWT token in headers
Authorization: Bearer <token>

# API key in query
?api_key=<key>
```

### Rate Limiting

Future: Implement rate limiting:

```bash
# AI Assistant should respect rate limits
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1714450000
```

### Webhook Security

Always verify webhook signatures:

```typescript
const signature = request.headers["x-gitlab-token"];
if (!webhookHandler.verifyWebhook(signature, body)) {
  return 401;
}
```
