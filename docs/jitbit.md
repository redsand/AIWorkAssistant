# Jitbit Integration

The Jitbit integration provides a full-featured service layer for the Jitbit helpdesk/ticketing system. It is exposed through 21 assistant tools rather than standalone REST routes.

---

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JITBIT_ENABLED` | Yes | `false` | Set to `true` to enable |
| `JITBIT_BASE_URL` | Yes | — | Helpdesk URL (e.g., `https://your-company.jitbit.com/helpdesk`) |
| `JITBIT_API_TOKEN` | Yes | — | API token |
| `JITBIT_DEFAULT_CATEGORY_ID` | No | — | Default category for new tickets |

---

## Supported Operations

### Ticket Lifecycle

| Tool | Description |
|------|-------------|
| `jitbit.create_ticket` | Create a new ticket |
| `jitbit.close_ticket` | Close a ticket |
| `jitbit.reopen_ticket` | Reopen a closed ticket |
| `jitbit.assign_ticket` | Assign ticket to a user |
| `jitbit.delete_ticket` | Delete a ticket |
| `jitbit.merge_tickets` | Merge two tickets |
| `jitbit.forward_ticket` | Forward a ticket |
| `jitbit.subscribe_ticket` | Subscribe to ticket notifications |
| `jitbit.unsubscribe_ticket` | Unsubscribe from ticket |

### Ticket Querying

| Tool | Description |
|------|-------------|
| `jitbit.search_tickets` | Search tickets by query |
| `jitbit.get_ticket` | Get ticket details |
| `jitbit.list_recent_customer_activity` | Recent activity for a company |
| `jitbit.list_open_support_requests` | Open requests (optionally by company) |
| `jitbit.find_tickets_needing_followup` | Stale unclosed tickets (3+ days) |
| `jitbit.find_high_priority_open_tickets` | High-priority open tickets |

### Comments & Communication

| Tool | Description |
|------|-------------|
| `jitbit.add_comment` | Add a comment to a ticket |
| `jitbit.list_comments` | List ticket comments |

### Assets (CMDB)

| Tool | Description |
|------|-------------|
| `jitbit.list_assets` | List assets |
| `jitbit.get_asset` | Get asset details |
| `jitbit.create_asset` | Create an asset |
| `jitbit.update_asset` | Update an asset |
| `jitbit.disable_asset` | Disable an asset |
| `jitbit.search_assets` | Search assets |

### Custom Fields, Tags, and Sections

| Tool | Description |
|------|-------------|
| `jitbit.list_custom_fields` | List custom field definitions |
| `jitbit.get_custom_field_value` | Get a custom field value on a ticket |
| `jitbit.set_custom_field_value` | Set a custom field value on a ticket |
| `jitbit.list_tags` | List tags on a ticket |
| `jitbit.add_tag` | Add a tag to a ticket |
| `jitbit.list_sections` | List helpdesk sections |
| `jitbit.list_categories` | List helpdesk categories |
| `jitbit.list_priorities` | List priority levels |

### Time Tracking

| Tool | Description |
|------|-------------|
| `jitbit.get_time_entries` | Get time entries for a ticket |
| `jitbit.add_time_entry` | Add a time entry |

### Automation

| Tool | Description |
|------|-------------|
| `jitbit.get_automation_rules` | Get automation rules |
| `jitbit.enable_automation_rule` | Enable an automation rule |
| `jitbit.disable_automation_rule` | Disable an automation rule |

### Companies & Users

| Tool | Description |
|------|-------------|
| `jitbit.list_companies` | List companies |
| `jitbit.get_company` | Get company details |
| `jitbit.list_users` | List users |
| `jitbit.get_user` | Get user details |

---

## Customer Brief Workflow

The customer snapshot feature provides a consolidated view of a customer's support footprint:

### How to Generate a Customer Brief

1. **Find the company** — Use `jitbit.get_company` with company ID or name
2. **Generate snapshot** — Use `jitbit.get_customer_snapshot` which parallel-fetches:
   - Company users
   - Open tickets
   - Recent tickets
3. The snapshot includes summary stats: user count, open ticket count, high-priority count

### Ticket Summarization

`jitbit.summarize_ticket_for_assistant` fetches a ticket plus its comments, sorts by date, and builds a concise text summary including:
- Status and priority
- Customer information
- Latest comment content

Designed for AI assistant consumption — returns a compact text representation rather than raw JSON.

---

## Support Follow-up Workflow

### How to Find Tickets Needing Follow-up

1. **Run follow-up detection** — `jitbit.find_tickets_needing_followup` returns tickets that have been open for 3+ days without a response
2. **Filter by company** (optional) — `jitbit.list_open_support_requests` with `companyId` parameter
3. **Check high-priority** — `jitbit.find_high_priority_open_tickets` for urgent items

### Follow-up in the CTO Daily Command Center

The CTO Daily Command Center automatically includes Jitbit follow-up tickets (limit 15, 3+ days stale) in the "Customer / Support Signals" section. No separate API call needed if you use the CTO brief.

---

## Limitations

| Limitation | Details |
|------------|---------|
| **No tag removal API** | `jitbit.remove_tag` throws an error — the Jitbit API has no endpoint for removing individual tags from a ticket |
| **No time entry deletion** | `jitbit.delete_time_entry` throws an error — the Jitbit API does not support deleting time entries |
| **Priority value interpretation** | `isHighPriority()` treats Priority >= 1 as high. This may be inverted depending on your Jitbit configuration (some setups use 1 = low) |
| **Reopen status detection** | `reopenTicket()` finds an "open" or "new" status by name, which could break if statuses are localized or renamed |
| **Singleton service** | The Jitbit service is exported as a singleton, making dependency injection in tests require module mocking |