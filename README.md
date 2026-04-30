# OpenClaw Agent

A guarded productivity and engineering agent with OpenClaw integration.

## Overview

OpenClaw Agent is a personal productivity and engineering copilot that helps you:

- **Personal Productivity**: Plan your day, protect focus/fitness/mental-health time, manage Jira tickets, and connect GitLab activity to Jira work
- **Engineering Strategy**: Convert vague app ideas into workflow-first designs with thoughtful architecture, scaffolding, and implementation plans

**Core Philosophy**: Design from workflows. Scaffold from architecture. Implement with guardrails. Iterate from evidence.

## Features

### Productivity Mode
- Daily planning with focus blocks
- Health break protection (fitness, meals, mental health)
- Jira ticket management and prioritization
- GitLab commit/MR to Jira linking
- Smart recommendations based on workload and energy

### Engineering Strategy Mode
- Workflow-first project briefs
- Architecture recommendations
- Scaffolding plans
- Implementation milestones
- Jira ticket generation

### Guardrails
- **Policy Engine**: Classifies actions as allow/approval-required/blocked
- **Approval Queue**: Medium/high-risk actions require explicit approval
- **Audit Logging**: All actions, decisions, and outcomes logged
- **Safe Defaults**: Destructive actions blocked unless explicitly enabled

## Quick Start

### Prerequisites
- Node.js 20+
- TypeScript
- Optional: Docker

### Installation

```bash
# Clone repository
git clone <repo-url>
cd openclaw-agent

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Configure environment variables
nano .env
```

### Configuration

Edit `.env` with your credentials:

```bash
# Server
PORT=3000
NODE_ENV=development

# OpenCode API
OPENCODE_API_KEY=your_opencode_api_key

# Jira Cloud
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your_email@example.com
JIRA_API_TOKEN=your_jira_api_token

# GitLab
GITLAB_BASE_URL=https://gitlab.com
GITLAB_TOKEN=your_gitlab_token
GITLAB_WEBHOOK_SECRET=your_webhook_secret

# Microsoft 365 (optional)
MICROSOFT_CLIENT_ID=your_client_id
MICROSOFT_CLIENT_SECRET=your_client_secret

# Policy
POLICY_APPROVAL_MODE=strict  # strict, balanced, permissive
```

### Development

```bash
# Run in development mode
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Lint code
npm run lint

# Format code
npm run format

# Build for production
npm run build

# Start production server
npm start
```

### Docker

```bash
# Build and run with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

## API Endpoints

### Chat
```
POST /chat
{
  "message": "Plan my day today",
  "mode": "productivity",  // or "engineering"
  "userId": "user-123"
}
```

### Approvals
```
GET  /approvals
GET  /approvals/:id
POST /approvals/:id/approve
POST /approvals/:id/reject
```

### Webhooks
```
POST /webhooks/gitlab  # GitLab webhook endpoint
```

### Health
```
GET /health
```

## Architecture

```
src/
├── config/           # Environment and policy configuration
├── agent/            # Chat orchestration and OpenCode client
├── policy/           # Policy engine and rules
├── approvals/        # Approval queue management
├── audit/            # Audit logging
├── integrations/     # External service adapters
│   ├── microsoft/    # Microsoft Graph / Calendar
│   ├── jira/         # Jira Cloud
│   └── gitlab/       # GitLab API and webhooks
├── productivity/     # Daily planning, focus blocks, health breaks
├── engineering/      # Workflow briefs, architecture, scaffolding
└── routes/           # HTTP endpoints
```

## Policy Model

Actions are classified by risk level:

- **Low Risk**: Read-only, drafting, planning (automatic)
- **Medium Risk**: Comments, creating tickets, calendar blocks (approval required)
- **High Risk**: Closing tickets, moving meetings, deletions (approval required or blocked)

Example policies:
- Reading Jira tickets: ✅ Allow
- Posting Jira comments: ⚠️ Approval required
- Closing Jira tickets: ⚠️ Approval required
- Moving meetings with attendees: ⚠️ Approval required
- Deleting calendar events: 🚫 Blocked

## OpenClaw Integration

This agent is designed to work with OpenClaw as the chat runtime interface.

See `openclaw-tools/agent-tool.json` for the tool/skill definition.

## Security Notes

- Never commit `.env` files
- Use strong webhook secrets
- Enable HTTPS in production
- Implement proper OAuth for Microsoft 365
- Scope API tokens to minimum required permissions
- Review and audit logs regularly

## Development Status

### ✅ Implemented
- Policy engine with risk classification
- Approval queue with approve/reject
- Audit logging
- Jira key extraction from GitLab data
- Chat endpoint (stubbed OpenCode integration)
- Health check endpoint

### 🚧 TODO (Stubbed)
- OpenCode API integration
- Jira REST API client
- GitLab API client
- Microsoft Graph / Calendar integration
- OAuth flow for Microsoft 365
- Actual daily planning logic
- Engineering strategy generation

### 📋 Planned
- Database persistence for approvals and audit logs
- More sophisticated policy rules
- Per-project policies
- Scheduling recurring tasks
- Notification system
- Web UI for approval queue
- Metrics and observability

## Roadmap

1. **v0.2**: Complete Jira and GitLab API integrations
2. **v0.3**: Implement Microsoft 365 calendar integration
3. **v0.4**: Add OpenCode API integration
4. **v0.5**: Implement actual daily planning and engineering logic
5. **v1.0**: Production-ready with full feature set

## Contributing

This is a personal project, but suggestions and issues are welcome.

## License

MIT

## Support

For issues and questions, please open a GitHub issue.
