# Policy Model

The policy engine is the core of the agent's guardrails system. It evaluates every action before execution and determines whether it can proceed automatically, requires approval, or should be blocked.

## Policy Structure

### Action Type Pattern
Actions are identified by dot-notation patterns:
- `jira.issue.read` - Read Jira issue
- `jira.comment.create` - Post comment to Jira
- `calendar.event.delete` - Delete calendar event
- `gitlab.jira_link.auto_transition` - Auto-transition from GitLab webhook

Wildcards are supported:
- `*.read` - All read operations
- `jira.*.create` - All Jira create operations
- `calendar.*` - All calendar operations

### Policy Rules

Each policy rule has:
- `pattern`: Action type pattern
- `riskLevel`: low, medium, or high
- `defaultResult`: allow, approval_required, or blocked
- `description`: Human-readable explanation

## Risk Levels

### Low Risk
**Automatic approval** - These actions are safe to perform without human intervention.

Examples:
- Reading data (calendar events, Jira issues, GitLab MRs)
- Generating plans and recommendations
- Drafting documents, tickets, comments
- Searching and listing resources

### Medium Risk
**Approval required** - These actions have external side effects but are reversible.

Examples:
- Creating Jira tickets
- Posting comments
- Creating calendar events
- Updating ticket fields
- Linking GitLab activity to Jira

### High Risk
**Approval required or blocked** - These actions are difficult to reverse or affect other users.

Examples:
- Closing Jira tickets
- Transitioning ticket status
- Moving meetings with attendees
- Deleting calendar events
- Bulk operations
- Running shell commands

## Policy Modes

### Strict Mode (Default)
Most actions require approval. Suitable for production or high-stakes environments.

Overrides:
- All medium/high-risk actions require approval
- Calendar delete blocked
- Destructive operations blocked

### Balanced Mode
Read-only and draft operations automatic. Medium-risk actions may require approval.

Overrides:
- Comments and tickets may be automatic
- Health blocks can be automatic
- Still requires approval for closing tickets

### Permissive Mode
More actions automatic. Suitable for development or trusted environments.

Overrides:
- Most create operations automatic
- Comments automatic
- Still blocks destructive operations

## Policy Evaluation

### Flow
```
1. Action proposed
2. Find matching policy pattern
3. Apply mode-specific overrides
4. Return policy decision:
   - allow: Proceed automatically
   - approval_required: Queue for approval
   - blocked: Reject with reason
```

### Pattern Matching
Patterns are matched from most specific to least specific:

1. Exact match: `jira.issue.close`
2. Wildcard match: `jira.*.close`
3. General match: `*.close`

Example: `jira.issue.close` matches:
- `jira.issue.close` ✅
- `jira.*.close` ✅
- `*.close` ✅
- `jira.issue.*` ✅

## Default Policies

### Calendar Operations
| Action | Risk | Default | Notes |
|--------|------|---------|-------|
| `calendar.event.list` | Low | Allow | Read-only |
| `calendar.event.create` | Medium | Approval | Creates external event |
| `calendar.focus_block.create` | Medium | Approval | Creates focus block |
| `calendar.health_block.create` | Medium | Approval | Creates health block |
| `calendar.event.move_with_attendees` | High | Approval | Affects others |
| `calendar.event.delete` | High | Blocked | Destructive |

### Jira Operations
| Action | Risk | Default | Notes |
|--------|------|---------|-------|
| `jira.issue.read` | Low | Allow | Read-only |
| `jira.issue.search` | Low | Allow | Read-only |
| `jira.comment.create` | Medium | Approval | External write |
| `jira.issue.create` | Medium | Approval | Creates ticket |
| `jira.issue.transition` | High | Approval | State change |
| `jira.issue.close` | High | Approval | Terminal state |
| `jira.issue.delete` | High | Blocked | Destructive |

### GitLab Operations
| Action | Risk | Default | Notes |
|--------|------|---------|-------|
| `gitlab.*.read` | Low | Allow | Read-only |
| `gitlab.webhook.process` | Low | Allow | Event handling |
| `gitlab.jira_link.auto_comment` | Medium | Approval | Auto-posts to Jira |
| `gitlab.jira_link.auto_transition` | High | Approval | Auto-transitions Jira |

### HAWK IR Case Management

| Action | Risk | Approval | MFA | Justification | Impact |
|--------|------|----------|-----|---------------|--------|
| `hawk_ir.add_case_note` | Medium | Yes | No | No | Adds note to case record |
| `hawk_ir.update_case_status` | High | Yes | No | Yes | Changes case workflow state |
| `hawk_ir.update_case_risk` | High | Yes | No | Yes | Changes case prioritization |
| `hawk_ir.deescalate_case` | High | Yes | No | Yes | Removes escalation (existing) |
| `hawk_ir.merge_cases` | High | Yes | No | Yes | Merges duplicate case into canonical case |
| `hawk_ir.rename_case` | Low | Yes | No | No | Cosmetic case name change |
| `hawk_ir.update_case_details` | Medium | Yes | No | No | Updates case context/details |
| `hawk_ir.set_case_categories` | Medium | Yes | No | No | Changes case classification |
| `hawk_ir.add_ignore_label` | High | Yes | No | Yes | Suppresses future matching alerts |
| `hawk_ir.delete_ignore_label` | High | Yes | No | Yes | Re-enables previously suppressed alerts |
| `hawk_ir.get_case_categories` | Low | No | No | No | Reads available case categories |
| `hawk_ir.get_case_labels` | Low | No | No | No | Reads label categories and ignore labels |

### Bulk/Destructive Operations
| Action | Risk | Default | Notes |
|--------|------|---------|-------|
| `*.bulk` | High | Blocked | Mass changes |
| `*.destructive` | High | Blocked | Destructive |
| `shell.*` | High | Blocked | Command execution |

## Custom Policies

You can add custom policies in `src/config/policy.ts`:

```typescript
export const DEFAULT_POLICIES: PolicyRule[] = [
  // ... existing policies ...

  // Custom policy
  {
    pattern: 'myapp.feature.toggle',
    riskLevel: 'medium',
    defaultResult: 'approval_required',
    description: 'Toggle feature flag',
  },
];
```

## Per-Project Policies (Future)

Planned feature for project-specific policies:

```typescript
export const PROJECT_POLICIES: Record<string, PolicyRule[]> = {
  'PROJ-1': [
    {
      pattern: 'jira.issue.close',
      defaultResult: 'allow',  // Auto-close allowed for this project
    },
  ],
};
```

## Audit Trail

All policy evaluations are logged:

```json
{
  "id": "uuid",
  "timestamp": "2026-04-30T10:00:00Z",
  "action": "policy_evaluated",
  "actor": "user-123",
  "details": {
    "actionType": "jira.comment.create",
    "result": "approval_required",
    "riskLevel": "medium",
    "reason": "Post comment to Jira issue"
  },
  "severity": "info"
}
```

## Best Practices

1. **Default to approval_required**: If unsure, require approval
2. **Use specific patterns**: Avoid overly broad wildcards
3. **Document reasons**: Clear descriptions help users understand
4. **Log everything**: Maintain audit trail
5. **Review regularly**: Update policies as system evolves
6. **Test policies**: Unit tests for policy decisions
7. **Consider context**: Time, user, and project may affect risk

## Security Considerations

- Policy bypass attempts should be logged
- Unknown actions default to approval_required
- Mode changes require restart (future: runtime updates)
- Audit logs are append-only (tamper-evident)
- Policy evaluation should be fast (sub-millisecond)
