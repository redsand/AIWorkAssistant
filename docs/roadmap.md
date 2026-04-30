# Roadmap

## Version 0.1.0 (Current MVP)

### ✅ Completed
- Project scaffold and architecture
- Policy engine with risk classification
- Approval queue with approve/reject
- Audit logging system
- Jira key extraction from GitLab data
- Chat endpoint (stubbed OpenCode integration)
- Health check endpoint
- Comprehensive documentation

### 🚧 TODO (Stubbed)
- OpenCode API integration
- Jira REST API client
- GitLab API client
- Microsoft Graph / Calendar integration
- OAuth flow for Microsoft 365
- Actual daily planning logic
- Engineering strategy generation

## Version 0.2.0 - Core Integrations

### Jira Integration
- [ ] Complete Jira REST API client
- [ ] Issue search and filtering
- [ ] Add comments to tickets
- [ ] Transition workflow states
- [ ] Create new tickets
- [ ] Update ticket fields
- [ ] Webhook integration for ticket updates

### GitLab Integration
- [ ] Complete GitLab API client
- [ ] Commit retrieval and analysis
- [ ] Merge request listing
- [ ] Pipeline status checking
- [ ] Webhook processing
- [ ] Auto-link to Jira tickets
- [ ] Auto-transition suggestions

### Policy Engine Enhancements
- [ ] Per-project policy overrides
- [ ] Policy templates
- [ ] Policy testing framework
- [ ] Policy documentation generator

### Testing
- [ ] Unit tests for Jira client
- [ ] Unit tests for GitLab client
- [ ] Integration tests for webhooks
- [ ] Policy engine tests
- [ ] End-to-end tests

## Version 0.3.0 - Calendar Integration

### Microsoft 365 Integration
- [ ] OAuth 2.0 flow implementation
- [ ] Microsoft Graph API client
- [ ] Calendar event listing
- [ ] Focus block creation
- [ ] Health block creation
- [ ] Meeting rescheduling
- [ ] Calendar analysis (meeting density, gaps)

### Daily Planning
- [ ] Generate daily schedules
- [ ] Prioritize Jira tickets
- [ ] Recommend focus blocks
- [ ] Suggest health breaks
- [ ] Detect meeting-heavy days
- [ ] Suggest recovery time

### Productivity Features
- [ ] Weekly planning
- [ ] Workload analysis
- [ ] Energy management
- [ ] Deadline tracking

## Version 0.4.0 - AI Integration

### OpenCode API Integration
- [ ] Complete OpenCode API client
- [ ] Chat completion integration
- [ ] Streaming responses
- [ ] Tool calling support
- [ ] Context management
- [ ] Prompt optimization

### Engineering Mode
- [ ] Workflow brief generation
- [ ] Architecture proposal generation
- [ ] Scaffolding plan generation
- [ ] Jira ticket generation
- [ ] Implementation planning

### Agent Capabilities
- [ ] Conversational context
- [ ] Multi-turn planning
- [ ] Clarification questions
- [ ] Recommendation scoring
- [ ] Trade-off analysis

## Version 0.5.0 - Database and Persistence

### Database Integration
- [ ] PostgreSQL schema
- [ ] Database migrations
- [ ] Approval queue persistence
- [ ] Audit log storage
- [ ] User preferences storage
- [ ] Project configuration storage

### Approval Queue
- [ ] Persistent storage
- [ ] Distributed locking
- [ ] Approval history
- [ ] Bulk approval actions
- [ ] Delegation support

### Audit Logging
- [ ] Database storage
- [ ] Query interface
- [ ] Log aggregation
- [ ] Export functionality
- [ ] Retention policies

## Version 0.6.0 - User Interface

### Web Dashboard
- [ ] Approval queue UI
- [ ] Audit log viewer
- [ ] Policy management UI
- [ ] Integration status dashboard
- [ ] Configuration interface

### Notifications
- [ ] Email notifications
- [ ] Slack integration
- [ ] In-app notifications
- [ ] Notification preferences

### Reporting
- [ ] Activity reports
- [ ] Policy compliance reports
- [ ] Integration usage reports
- [ ] Custom report builder

## Version 1.0.0 - Production Ready

### Performance
- [ ] Response time optimization
- [ ] Caching layer (Redis)
- [ ] Database query optimization
- [ ] Rate limiting
- [ ] Load balancing

### Security
- [ ] Authentication system
- [ ] Authorization model
- [ ] API key management
- [ ] Webhook security enhancements
- [ ] Security audit

### Operations
- [ ] Monitoring and alerting
- [ ] Health checks
- [ ] Metrics collection
- [ ] Log aggregation
- [ ] Deployment automation

### Documentation
- [ ] API documentation
- [ ] Deployment guide
- [ ] Operations runbook
- [ ] Troubleshooting guide
- [ ] User guide

## Future Enhancements

### Advanced Features
- [ ] Multi-user support
- [ ] Team workflows
- [ ] Custom integrations
- [ ] Plugin system
- [ ] Workflow automation

### Analytics
- [ ] Productivity metrics
- [ ] Time tracking
- [ ] Workload forecasting
- [ ] Pattern recognition
- [ ] Recommendations engine

### Integrations
- [ ] GitHub support
- [ ] Linear support
- [ ] Notion integration
- [ ] Slack/Teams integration
- [ ] Email integration
- [ ] Calendar providers (Google, CalDAV)
- [ ] Health/fitness apps
- [ ] Habit trackers

### AI/ML
- [ ] Natural language processing
- [ ] Sentiment analysis
- [ ] Priority prediction
- [ ] Anomaly detection
- [ ] Smart recommendations

## Timeline Estimates

- **v0.2.0**: 2-3 months
- **v0.3.0**: 1-2 months
- **v0.4.0**: 2-3 months
- **v0.5.0**: 1-2 months
- **v0.6.0**: 2-3 months
- **v1.0.0**: 2-3 months

**Total to v1.0.0**: ~12-18 months

## Dependencies

### External Dependencies
- OpenCode API availability and pricing
- Jira Cloud API stability
- GitLab API consistency
- Microsoft Graph API support

### Technical Risks
- API rate limits
- Breaking changes in external APIs
- OAuth complexity
- Scaling challenges
- Performance bottlenecks

## Contribution Guidelines

Contributions welcome! Please:

1. Check existing issues and roadmap
2. Open issue to discuss major changes
3. Follow coding standards
4. Add tests for new features
5. Update documentation
6. Submit pull request

## Release Notes

Each release will include:
- New features
- Bug fixes
- Breaking changes
- Migration guide (if needed)
- Known issues

Follow this project for updates!
