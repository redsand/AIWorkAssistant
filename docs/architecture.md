# Architecture Overview

## System Design

OpenClaw Agent follows a **guarded agent architecture** with three core layers:

### 1. Interface Layer
- **OpenClaw**: Chat runtime and user interface
- **Fastify Server**: HTTP API with `/chat`, `/approvals`, `/webhooks` endpoints
- **Tool Registry**: Available tools for each agent mode

### 2. Guard Layer
- **Policy Engine**: Evaluates actions against policy rules
- **Approval Queue**: Manages pending approvals for medium/high-risk actions
- **Audit Logger**: Records all actions, decisions, and outcomes

### 3. Integration Layer
- **Jira Service**: Jira Cloud API integration
- **GitLab Service**: GitLab API and webhook handling
- **Calendar Service**: Microsoft Graph API integration
- **OpenCode Client**: AI reasoning backend

## Request Flow

### Chat Request Flow
```
OpenClaw → Fastify (/chat) → Orchestrator → OpenCode API
                                    ↓
                              Policy Engine
                                    ↓
                         Allow / Approval / Block
                                    ↓
                    Execute / Queue Approval / Return Error
```

### GitLab Webhook Flow
```
GitLab → Fastify (/webhooks/gitlab) → Webhook Handler
                                        ↓
                                  Extract Jira Keys
                                        ↓
                              Policy Engine Evaluation
                                        ↓
                         Auto-comment or Queue Approval
```

### Approval Flow
```
Action Proposed → Policy Engine → Approval Required → Add to Queue
                                                      ↓
                                              User Approves/Rejects
                                                      ↓
                                          Execute or Log Rejection
```

## Component Architecture

### Agent Orchestrator
- Routes chat messages to appropriate mode (productivity/engineering)
- Invokes tools based on OpenCode API responses
- Handles approval requests and policy decisions

### Policy Engine
- Pattern-based action matching (e.g., `jira.comment.create`)
- Risk classification (low/medium/high)
- Policy result determination (allow/approval-required/blocked)
- Mode-specific overrides (strict/balanced/permissive)

### Approval Queue
- In-memory storage (future: database persistence)
- Approval lifecycle management (pending/approved/rejected/executed)
- Cleanup of old approvals

### Audit Logger
- Structured logging of all system events
- File-based append-only log (future: database)
- Queryable audit trail

## Data Models

### Action
```typescript
{
  id: string;
  type: string;           // e.g., "jira.comment.create"
  description: string;
  params: Record<string, unknown>;
  userId: string;
  timestamp: Date;
}
```

### Policy Decision
```typescript
{
  action: Action;
  result: 'allow' | 'approval_required' | 'blocked';
  riskLevel: 'low' | 'medium' | 'high';
  reason: string;
  applicablePolicy?: string;
}
```

### Approval Request
```typescript
{
  id: string;
  action: Action;
  decision: PolicyDecision;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  requestedAt: Date;
  respondedAt?: Date;
  responseBy?: string;
  executionResult?: ExecutionResult;
}
```

## Security Model

### Principle of Least Privilege
- Read-only actions: Automatic
- Destructive actions: Blocked by default
- External writes: Approval required

### Defense in Depth
1. **Policy Engine**: Pre-execution check
2. **Approval Queue**: Human-in-the-loop for risky actions
3. **Audit Logger**: Post-execution traceability
4. **Environment Variables**: No hardcoded secrets
5. **Webhook Verification**: HMAC signature checking

### Risk Classification
- **Low**: Reading, drafting, planning
- **Medium**: Creating resources, posting comments
- **High**: Deleting, closing, moving meetings, bulk operations

## Scalability Considerations

### Current (MVP)
- In-memory approval queue
- File-based audit logging
- Single-instance deployment
- Stateless HTTP server

### Future Enhancements
- Database persistence (PostgreSQL)
- Distributed approval queue (Redis)
- Structured logging (ELK/Loki)
- Horizontal scaling (Kubernetes)
- Caching layer (Redis)
- Message queue (RabbitMQ/Redis)

## Technology Choices

### Why Fastify?
- High performance
- Built-in schema validation
- TypeScript support
- Low overhead

### Why TypeScript?
- Type safety
- Better developer experience
- Catch errors at compile time
- Self-documenting code

### Why Policy-Based Architecture?
- Explicit guardrails
- Human control over risky actions
- Audit trail for compliance
- Extensible without code changes

## Monitoring and Observability

### Health Checks
- `/health` endpoint
- Dependency status (Jira, GitLab, OpenCode)
- Configuration validation

### Logging
- Structured JSON logs
- Log levels: debug, info, warn, error
- Audit trail for all actions

### Metrics (Future)
- Request latency
- Approval queue depth
- Policy decision distribution
- Integration error rates

## Deployment Architecture

### Development
```bash
npm run dev  # Hot-reload with tsx
```

### Production
```bash
docker-compose up -d  # Single container
```

### Future: Kubernetes
- Deployment: 2-3 replicas
- Service: Load balancer
- Ingress: TLS termination
- ConfigMap: Environment variables
- Secret: API tokens and keys
