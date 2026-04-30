# Security Considerations

## Overview

This agent is designed with security-first principles. All actions are evaluated against policy rules, high-risk operations require approval, and all actions are logged for audit.

## Threat Model

### Primary Threats
1. **Unauthorized access** to Jira, GitLab, or Microsoft 365
2. **Privilege escalation** via policy bypass
3. **Data exfiltration** through logs or responses
4. **System compromise** via dependency vulnerabilities
5. **Webhook impersonation** leading to unauthorized actions

### Security Boundaries
- **External APIs**: Jira, GitLab, Microsoft Graph, OpenCode
- **User Input**: Chat messages and tool parameters
- **Webhooks**: GitLab push and merge request events
- **Approvals**: User approve/reject actions
- **Audit Logs**: Append-only action trail

## Authentication and Authorization

### API Keys and Tokens

**Best Practices:**
- Store in environment variables only
- Never commit to repository
- Rotate regularly
- Use minimum required scope
- Monitor for suspicious activity

**Example:**
```bash
# .env file (never committed)
JIRA_API_TOKEN=your_token_here
GITLAB_TOKEN=your_token_here
OPENCODE_API_KEY=your_key_here
```

### OAuth 2.0 (Future)

For Microsoft 365 integration:
```
1. User clicks "Connect Microsoft 365"
2. Redirect to Microsoft login
3. User grants permissions
4. Receive authorization code
5. Exchange for access token
6. Store token securely (encrypted)
7. Refresh token as needed
```

### Webhook Verification

GitLab webhooks must be verified:

```typescript
verifyWebhook(signature: string, body: string): boolean {
  if (!env.GITLAB_WEBHOOK_SECRET) {
    return true;  // Warning only
  }

  // Verify signature
  return signature === env.GITLAB_WEBHOOK_SECRET;
}
```

**Future: HMAC verification**
```typescript
const hmac = crypto.createHmac('sha256', secret);
hmac.update(body);
const expectedSignature = hmac.digest('hex');
return crypto.timingSafeEqual(
  Buffer.from(signature),
  Buffer.from(expectedSignature)
);
```

## Data Protection

### Data at Rest

- **Environment variables**: Stored in .env file (file system permissions)
- **Audit logs**: Append-only file logs
- **Database**: Future - use encryption at rest

### Data in Transit

- **HTTPS/TLS**: Required for all external API calls
- **Webhook signatures**: Verify source authenticity
- **API tokens**: Use bearer tokens in headers

### Sensitive Data Handling

**Never log:**
- API keys or tokens
- Passwords
- Personal identifying information (PII)
- OAuth tokens
- Session cookies

**Sanitize before logging:**
```typescript
function sanitize(obj: any): any {
  const sensitive = ['password', 'token', 'secret', 'key'];
  // Remove sensitive fields
}
```

## Input Validation

### User Input

Validate all user input:

```typescript
const schema = z.object({
  message: z.string().max(10000),
  mode: z.enum(['productivity', 'engineering']),
  userId: z.string().uuid(),
});
```

### Tool Parameters

Validate tool parameters:

```typescript
{
  name: 'jira.add_comment',
  params: {
    key: z.string().regex(/^[A-Z]+-\d+$/),
    body: z.string().max(10000),
  }
}
```

### Webhook Payloads

Validate webhook structure:

```typescript
const webhookSchema = z.object({
  object_kind: z.enum(['push', 'merge_request']),
  project: z.object({
    id: z.number(),
    name: z.string(),
  }),
  // ...
});
```

## Authorization

### Policy Engine

All actions must be evaluated:

```typescript
const decision = await policyEngine.evaluate(action);

if (!policyEngine.canProceed(decision)) {
  // Action not allowed
}

if (policyEngine.requiresApproval(decision)) {
  // Queue for approval
}

if (policyEngine.isBlocked(decision)) {
  // Action blocked
}
```

### Risk Classification

Actions are classified by risk:

- **Low**: Read-only, drafting (automatic)
- **Medium**: Creating resources (approval required)
- **High**: Destructive operations (blocked or approval)

### Approval Flow

High-risk actions require explicit approval:

```
1. Action proposed
2. Policy evaluation → approval_required
3. Add to approval queue
4. User reviews and approves
5. Action executed
6. Result logged
```

## Audit and Compliance

### Audit Logging

All actions are logged:

```typescript
await auditLogger.log({
  id: uuidv4(),
  timestamp: new Date(),
  action: 'jira.comment.create',
  actor: userId,
  details: { key: 'PROJ-123', body: '...' },
  severity: 'info',
});
```

### Log Retention

- **Development**: 7 days
- **Production**: 90 days (configurable)
- **Compliance**: As required by regulations

### Log Integrity

- **Append-only**: Logs cannot be modified
- **Tamper-evident**: Any tampering is detectable
- **Backup**: Regular backups to secure storage

## Dependency Security

### Vulnerability Scanning

```bash
# Run npm audit
npm audit

# Fix vulnerabilities
npm audit fix

# Run Snyk (alternative)
npx snyk test
```

### Dependency Updates

```bash
# Check for updates
npm outdated

# Update packages
npm update

# Major version updates
npx npm-check-updates -u
npm install
```

### Supply Chain Security

- **Lockfile**: Commit package-lock.json
- **Integrity verification**: Use npm's built-in integrity checks
- **Signed packages**: Prefer packages with signatures

## Rate Limiting

### API Rate Limits

Respect external API rate limits:

```typescript
// Jira: 1000 requests/hour
// GitLab: 2000 requests/minute
// Microsoft Graph: 15000 requests/10 minutes
```

### Client-Side Rate Limiting

```typescript
// Token bucket algorithm
class RateLimiter {
  private tokens = 100;
  private lastRefill = Date.now();

  async allow(): Promise<boolean> {
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return true;
    }
    return false;
  }
}
```

## Error Handling

### Safe Error Messages

Don't expose internal details:

```typescript
// Bad
throw new Error(`Database connection failed: ${connectionString}`);

// Good
throw new Error('Database connection failed');
```

### Error Logging

Log full errors server-side:

```typescript
this.log.error(error, {
  context: 'jira.api.call',
  userId,
  action: 'create_issue',
});
```

### User-Facing Errors

Return safe messages to users:

```typescript
return {
  error: 'Failed to create Jira ticket',
  message: 'Please try again or contact support',
};
```

## Security Monitoring

### Health Checks

Monitor system health:

```bash
GET /health
{
  "status": "ok",
  "timestamp": "2026-04-30T10:00:00Z",
  "version": "0.1.0"
}
```

### Metrics to Monitor

- Failed policy evaluations
- Approval rejection rate
- API error rate
- Unusual activity spikes
- Webhook verification failures

### Alerts

Set up alerts for:
- Policy engine blocked actions
- Multiple failed approvals
- API authentication failures
- Webhook signature verification failures
- High error rates

## Compliance

### GDPR Considerations

- **Data minimization**: Only collect necessary data
- **Right to deletion**: Provide data export/deletion
- **Data portability**: Export user data on request
- **Consent**: Obtain user consent for integrations

### SOC 2 Considerations

- **Access control**: Role-based permissions
- **Encryption**: Data encrypted in transit and at rest
- **Monitoring**: Continuous security monitoring
- **Incident response**: Documented incident response plan

## Best Practices

### Development

1. **Never commit secrets** to repository
2. **Use environment variables** for configuration
3. **Validate all input** from users and APIs
4. **Implement rate limiting** on all endpoints
5. **Log security events** for audit trail
6. **Keep dependencies updated**
7. **Use HTTPS/TLS** everywhere
8. **Implement CORS** correctly
9. **Sanitize error messages** before returning to users
10. **Test security controls** regularly

### Deployment

1. **Use separate secrets** for dev/staging/prod
2. **Rotate credentials** regularly
3. **Enable security headers** (CSP, HSTS, etc.)
4. **Implement rate limiting** in production
5. **Set up monitoring** and alerting
6. **Regular security audits**
7. **Penetration testing** before major releases
8. **Incident response plan** ready
9. **Backup and disaster recovery** tested
10. **Documentation** kept up to date

## Security Checklist

- [ ] All secrets in environment variables
- [ ] Webhook signatures verified
- [ ] Input validation on all endpoints
- [ ] Policy engine evaluating all actions
- [ ] Approval queue functional
- [ ] Audit logging enabled
- [ ] HTTPS/TLS configured
- [ ] CORS properly configured
- [ ] Rate limiting implemented
- [ ] Error messages sanitized
- [ ] Dependencies scanned for vulnerabilities
- [ ] Security monitoring in place
- [ ] Incident response plan documented
- [ ] Regular security updates scheduled

## Incident Response

If a security incident is discovered:

1. **Contain**: Isolate affected systems
2. **Investigate**: Determine scope and impact
3. **Communicate**: Notify stakeholders
4. **Remediate**: Apply fixes and mitigations
5. **Review**: Document lessons learned
6. **Improve**: Update security controls

Report security issues to: security@example.com
