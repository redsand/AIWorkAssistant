# OpenCode API Setup Guide

This guide will help you configure and test the OpenCode API integration.

## Quick Setup

### 1. Get OpenCode API Key

You need an OpenCode API key. If you don't have one:

```bash
# Check if you have one from octorepl
grep opencode_api_key ../octorepl/hawk-ai-agent-soc.cfg
```

The key format is: `sk-12FvtYGvQMMyFFr6nBrMr34Y9mwvc9VnCTMvLTDEWZCHanDqVAoiueuorNl6r47B`

### 2. Configure Environment

Create or edit `.env` file:

```bash
# OpenCode API Configuration
OPENCODE_API_URL=https://opencode.ai/zen/go/v1
OPENCODE_API_KEY=sk-your_actual_api_key_here
```

### 3. Test API Connection

```bash
# Run integration tests
npm run test:opencode

# Or run unit tests
npm test -- opencode-client.test.ts
```

## API Details

**Base URL:** `https://opencode.ai/zen/go/v1`

**Endpoint:** `/chat/completions`

**Models:**
- `glm-5` (default)
- `glm-5.1`
- `kimi-k2.6`

**Features:**
- ✅ Chat completions
- ✅ Tool/function calling
- ✅ Streaming responses
- ✅ Retry logic with exponential backoff
- ✅ Error classification

## Usage Examples

### Simple Chat

```typescript
import { opencodeClient } from './src/agent/opencode-client';

const response = await opencodeClient.chat({
  messages: [
    { role: 'user', content: 'Say "OK"' }
  ],
});

console.log(response.content); // "OK"
```

### With Tools

```typescript
const tools = [
  {
    type: 'function',
    function: {
      name: 'list_jira_tickets',
      description: 'List Jira tickets',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string' }
        }
      }
    }
  }
];

const response = await opencodeClient.chat({
  messages: [
    { role: 'user', content: 'What tickets do I have?' }
  ],
  tools,
});

if (response.toolCalls) {
  console.log('Tool calls:', response.toolCalls);
}
```

### Streaming

```typescript
for await (const chunk of opencodeClient.chatStream({
  messages: [
    { role: 'user', content: 'Tell me a story' }
  ],
})) {
  process.stdout.write(chunk);
}
```

## Productivity Mode

```typescript
import { getSystemPrompt } from './src/agent/prompts';

const systemPrompt = getSystemPrompt('productivity');

const response = await opencodeClient.chat({
  messages: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Plan my day' }
  ],
});
```

## Engineering Mode

```typescript
const systemPrompt = getSystemPrompt('engineering');

const response = await opencodeClient.chat({
  messages: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'I want to build a task management app' }
  ],
});
```

## Testing

### Integration Test Script

```bash
npm run test:opencode
```

This runs:
1. Simple chat test
2. Productivity mode test
3. Tool calling test
4. Streaming test

### Unit Tests

```bash
# Run all tests
npm test

# Run OpenCode tests only
npm test -- opencode-client.test.ts

# Watch mode
npm run test:watch
```

## Troubleshooting

### "API key not configured"

**Solution:** Set `OPENCODE_API_KEY` in `.env` file

### "Authentication failed"

**Solution:** Check your API key is valid and not expired

### "Rate limit exceeded"

**Solution:** Wait a few seconds and retry

### "Connection timeout"

**Solution:** Check network connection and API status

### Tool calls not working

**Solution:** Ensure tool schema is correct and model supports tools

## Next Steps

Once OpenCode API is working:

1. ✅ Test productivity mode prompts
2. ✅ Test engineering mode prompts
3. ✅ Implement Jira integration
4. ✅ Implement GitLab integration
5. ✅ Test end-to-end workflows

## API Status

Check API status and configuration:

```bash
curl http://localhost:3000/chat/health
```

Response:
```json
{
  "opencode": {
    "configured": true,
    "valid": true,
    "baseUrl": "https://opencode.ai/zen/go/v1"
  }
}
```

## Configuration Reference

| Variable | Description | Default |
|----------|-------------|---------|
| OPENCODE_API_URL | API base URL | https://opencode.ai/zen/go/v1 |
| OPENCODE_API_KEY | API authentication key | (required) |
| OPENCODE_MODEL | Model to use | glm-5 |
| OPENCODE_TEMPERATURE | Response randomness | 0.7 |
| OPENCODE_TOP_P | Nucleus sampling | 0.95 |
| OPENCODE_MAX_RETRIES | Retry attempts | 3 |
| OPENCODE_TIMEOUT | Request timeout (ms) | 120000 |

## Performance Tips

1. **Use streaming** for long responses
2. **Enable tool calling** for structured outputs
3. **Set appropriate temperature** for your use case
4. **Cache responses** when possible
5. **Use estimated tokens** to avoid hitting limits

## Support

For issues with:
- **API access:** Contact OpenCode support
- **Integration:** Check documentation in `/docs`
- **Configuration:** Review `.env.example`
