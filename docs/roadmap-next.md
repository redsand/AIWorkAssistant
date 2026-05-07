# Roadmap — Next Ideas

These are future ideas for AIWorkAssistant. They are **not yet implemented** and should not be described as working features.

---

## Communication Integrations

### Email Integration

- Connect to email providers (Gmail, Outlook) via IMAP/SMTP or API
- Parse incoming support emails into work items or Jitbit tickets
- Send daily briefs and agent run summaries via email
- Detect follow-up needed from email threads

### Slack Integration

- Post daily briefs, CTO command center summaries, and push notifications to Slack channels
- Slash commands for common queries (`/brief`, `/work-items`, `/review PR#42`)
- Thread-based conversations linked to work items
- Incident escalation via Slack DM with interactive buttons

### Browser Extension

- Chrome/Firefox extension to clip web pages, emails, and support threads as work items
- Quick-create work items from any web page
- Overlay showing relevant context (linked Jira, GitHub, Jitbit) when viewing related pages

### Mobile Shortcut

- iOS/Android quick actions for common workflows
- Push notification integration with mobile deep linking
- Voice-to-work-item via mobile shortcuts

---

## Data & Intelligence

### Semantic Search / Vector Store

- Embed work items, tickets, and conversations using vector embeddings
- Semantic search across all integration data
- "Find similar" for incidents, tickets, and code reviews
- Automatic entity extraction and relationship mapping

### Customer Health Scoring

- Aggregate Jitbit ticket volume, response time, and sentiment into a health score
- Trend analysis over time (improving / stable / declining)
- Proactive alerts when health score drops
- Integration with CTO brief and Product Chief of Staff signals

---

## Automation & Operations

### Release Train Automation

- Automated release readiness checks across all open PRs/MRs
- Release notes generation from merged PR commits
- Staged rollout coordination (canary → percentage → full)
- Rollback automation tied to monitoring signals

### Detection Coverage Dashboard

- Visualize MITRE ATT&CK coverage from HAWK IR detections
- Gap analysis showing uncovered tactics and techniques
- Suggested detection ideas based on threat intelligence
- Coverage scoring per category

---

## When Adding Features From This List

Before implementing any item from this roadmap:

1. **Verify it doesn't already exist** — Check the current codebase and [README](../README.md) first
2. **Create a GitHub issue** — With a `## Coding Prompt` section for the implementation
3. **Update this doc** — Move the item from this file to the README's "What Works Now" table
4. **Update [agents.md](agents.md)** — If the feature adds a new agent/helper
5. **Remove aspirational claims** — Never document a feature as working until the code is merged