# Development Guide

## Getting Started

### Prerequisites

- Node.js 20+
- npm or yarn
- Git
- Optional: Docker, Docker Compose

### Setup

```bash
# Clone repository
git clone <repo-url>
cd ai-assistant

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit environment variables
nano .env

# Run in development mode
npm run dev
```

## Project Structure

```
ai-assistant/
├── src/
│   ├── server.ts              # Main server entry point
│   ├── config/                # Configuration
│   ├── agent/                 # Chat orchestration
│   ├── policy/                # Policy engine
│   ├── approvals/             # Approval queue
│   ├── audit/                 # Audit logging
│   ├── integrations/          # External services
│   ├── productivity/          # Productivity features
│   ├── engineering/           # Engineering features
│   ├── routes/                # HTTP routes
│   └── storage/               # Database (future)
├── tests/                     # Tests
├── docs/                      # Documentation
└── ai-assistant-tools/            # AI Assistant tool definitions
```

## Development Workflow

### Running Locally

```bash
# Development mode with hot-reload
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

### Docker Development

```bash
# Build and run
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down

# Rebuild after changes
docker-compose up -d --build
```

## Testing

### Unit Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- policy.test.ts

# Run with coverage
npm run test:coverage
```

### Writing Tests

```typescript
import { describe, it, expect } from "vitest";
import { extractJiraKeys } from "../src/integrations/gitlab/jira-key-extractor";

describe("Jira Key Extraction", () => {
  it("should extract Jira keys from commit message", () => {
    const message = "PROJ-123: Fix authentication bug";
    const keys = extractJiraKeys(message);
    expect(keys).toEqual(["PROJ-123"]);
  });

  it("should handle multiple Jira keys", () => {
    const message = "PROJ-123: Fix. Related to PROJ-456";
    const keys = extractJiraKeys(message);
    expect(keys).toEqual(["PROJ-123", "PROJ-456"]);
  });
});
```

### Integration Tests

```bash
# Run integration tests
npm run test:integration

# Test with actual services (requires credentials)
INTEGRATION_TESTS=true npm test
```

## Code Quality

### Linting

```bash
# Run ESLint
npm run lint

# Auto-fix issues
npm run lint -- --fix
```

### Formatting

```bash
# Format with Prettier
npm run format

# Check formatting
npm run format -- --check
```

### Type Checking

```bash
# Run TypeScript compiler
npx tsc --noEmit
```

## Debugging

### VS Code Debugging

Create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Server",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "dev"],
      "console": "integratedTerminal",
      "internalConsoleOptions": "neverOpen"
    }
  ]
}
```

### Logging

```bash
# Debug logging
NODE_ENV=development npm run dev

# Production logging
NODE_ENV=production npm start

# Custom log level
AUDIT_LOG_LEVEL=debug npm run dev
```

## Adding Features

### Adding a New Tool

1. Define tool in `src/agent/tool-registry.ts`:

```typescript
{
  name: 'mytool.do_something',
  description: 'Does something useful',
  params: {
    param1: { type: 'string', description: 'First param', required: true },
  },
  actionType: 'mytool.action',
  riskLevel: 'low',
}
```

2. Add policy rule in `src/config/policy.ts`:

```typescript
{
  pattern: 'mytool.*',
  riskLevel: 'low',
  defaultResult: 'allow',
  description: 'My tool operations',
}
```

3. Implement handler in appropriate service file:

```typescript
async doSomething(params: { param1: string }, userId: string) {
  const action: Action = {
    id: Date.now().toString(),
    type: 'mytool.action',
    description: 'Do something',
    params,
    userId,
    timestamp: new Date(),
  };

  const decision = await policyEngine.evaluate(action);

  if (!policyEngine.canProceed(decision)) {
    throw new Error(`Action not allowed: ${decision.reason}`);
  }

  // Execute action
  return result;
}
```

### Adding a New Integration

1. Create client in `src/integrations/myintegration/`:

```typescript
// client.ts
export class MyIntegrationClient {
  constructor() {
    // Initialize client
  }

  async doSomething() {
    // API call
  }
}
```

2. Create service layer:

```typescript
// service.ts
export class MyIntegrationService {
  async doSomething(params: any, userId: string) {
    // Policy checks
    // Execute action
    // Return result
  }
}
```

3. Add to tool registry if needed

### Adding a New Mode

1. Create system prompt in `src/agent/prompts.ts`:

```typescript
export const MY_MODE_SYSTEM_PROMPT = `...`;
```

2. Add tools to `src/agent/tool-registry.ts`:

```typescript
const MY_MODE_TOOLS: Tool[] = [ ... ];
```

3. Update `AGENT_MODES` in `src/config/constants.ts`:

```typescript
export const AGENT_MODES = {
  PRODUCTIVITY: "productivity",
  ENGINEERING: "engineering",
  MY_MODE: "my_mode",
} as const;
```

## Troubleshooting

### Common Issues

**Port already in use:**

```bash
# Kill process on port 3000
npx kill-port 3000

# Or use different port
PORT=3001 npm run dev
```

**TypeScript errors:**

```bash
# Clean build
rm -rf dist/
npm run build

# Regenerate types
npx tsc --declaration
```

**Test failures:**

```bash
# Clear cache
npm test -- --clearCache

# Run specific test
npm test -- testName
```

**Environment variables not loading:**

```bash
# Verify .env file exists
ls -la .env

# Check syntax
cat .env

# Load manually
export $(cat .env | xargs)
```

## Performance

### Profiling

```bash
# Run with profiler
node --prof dist/server.js

# Analyze profile
node --prof-process isolate-*.log > profile.txt
```

### Load Testing

```bash
# Install autocannon
npm install -g autocannon

# Load test chat endpoint
autocannon -c 10 -d 30 http://localhost:3000/chat
```

## Deployment

### Building for Production

```bash
# Run tests
npm test

# Build TypeScript
npm run build

# Verify build
ls -la dist/

# Test production build
NODE_ENV=production npm start
```

### Docker Build

```bash
# Build image
docker build -t ai-assistant .

# Test image
docker run -p 3000:3000 --env-file .env ai-assistant

# Tag image
docker tag ai-assistant ai-assistant:0.1.0

# Push to registry
docker push ai-assistant:0.1.0
```

### Environment Checklist

Before deploying:

- [ ] Set `NODE_ENV=production`
- [ ] Configure all API keys and tokens
- [ ] Set appropriate `POLICY_APPROVAL_MODE`
- [ ] Configure webhook secrets
- [ ] Set up database (if using)
- [ ] Configure logging and monitoring
- [ ] Review and test policies
- [ ] Set up HTTPS/TLS
- [ ] Configure backup strategy
- [ ] Set up error tracking

## Contributing

### Code Style

- Use TypeScript for all new code
- Follow existing code structure
- Add tests for new features
- Update documentation
- Run linter before committing

### Commit Messages

```
feat: add new tool for Jira comments
fix: correct policy engine pattern matching
docs: update architecture documentation
test: add tests for Jira key extraction
refactor: simplify approval queue logic
```

### Pull Request Process

1. Create feature branch
2. Implement changes
3. Add tests
4. Update docs
5. Submit PR
6. Address review feedback
7. Merge to main

## Resources

- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
- [Fastify Documentation](https://www.fastify.io/docs/latest/)
- [Vitest Documentation](https://vitest.dev/)
- [Docker Documentation](https://docs.docker.com/)
