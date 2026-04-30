#!/usr/bin/env tsx
/**
 * Quick test script for OpenCode API integration
 */

import { opencodeClient } from '../src/agent/opencode-client';
import type { ChatMessage, Tool } from '../src/agent/opencode-client';

async function testSimpleChat() {
  console.log('\n=== Test 1: Simple Chat ===\n');

  const messages: ChatMessage[] = [
    { role: 'user', content: 'Say "OK" and nothing else' },
  ];

  try {
    const response = await opencodeClient.chat({ messages });
    console.log('✓ Success!');
    console.log('Response:', response.content);
    console.log('Tokens:', response.usage?.totalTokens);
    return true;
  } catch (error) {
    console.error('✗ Failed:', error);
    return false;
  }
}

async function testProductivityMode() {
  console.log('\n=== Test 2: Productivity Mode ===\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: 'You are a personal productivity assistant. Provide brief, actionable advice.',
    },
    {
      role: 'user',
      content: 'I have 5 Jira tickets and 3 meetings today. What should I focus on?',
    },
  ];

  try {
    const response = await opencodeClient.chat({ messages });
    console.log('✓ Success!');
    console.log('Advice:', response.content.substring(0, 200) + '...');
    return true;
  } catch (error) {
    console.error('✗ Failed:', error);
    return false;
  }
}

async function testToolCalling() {
  console.log('\n=== Test 3: Tool Calling ===\n');

  const tools: Tool[] = [
    {
      type: 'function',
      function: {
        name: 'list_jira_tickets',
        description: 'List Jira tickets assigned to user',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'Filter by status' },
            limit: { type: 'number', description: 'Max results' },
          },
        },
      },
    },
  ];

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: 'You are a productivity assistant with access to tools.',
    },
    {
      role: 'user',
      content: 'What Jira tickets do I have assigned?',
    },
  ];

  try {
    const response = await opencodeClient.chat({ messages, tools });
    console.log('✓ Success!');

    if (response.toolCalls && response.toolCalls.length > 0) {
      console.log('Tool Calls:', response.toolCalls.map(tc => tc.function.name));
    } else {
      console.log('Response:', response.content.substring(0, 200) + '...');
    }

    return true;
  } catch (error) {
    console.error('✗ Failed:', error);
    return false;
  }
}

async function testStreaming() {
  console.log('\n=== Test 4: Streaming ===\n');

  const messages: ChatMessage[] = [
    { role: 'user', content: 'Count from 1 to 5' },
  ];

  try {
    console.log('Streaming: ');
    let chunks = 0;

    for await (const chunk of opencodeClient.chatStream({ messages })) {
      process.stdout.write(chunk);
      chunks++;
    }

    console.log('\n✓ Success!');
    console.log('Chunks received:', chunks);
    return true;
  } catch (error) {
    console.error('\n✗ Failed:', error);
    return false;
  }
}

async function main() {
  console.log('OpenCode API Integration Tests');
  console.log('================================\n');

  // Check configuration
  console.log('Checking configuration...');
  const isConfigured = opencodeClient.isConfigured();
  console.log('API Key configured:', isConfigured ? 'Yes' : 'No');

  if (!isConfigured) {
    console.error('\n✗ OPENCODE_API_KEY not set!');
    console.log('Please set OPENCODE_API_KEY environment variable.');
    process.exit(1);
  }

  const isValid = await opencodeClient.validateConfig();
  console.log('API connection valid:', isValid ? 'Yes' : 'No');

  if (!isValid) {
    console.error('\n✗ Cannot connect to OpenCode API!');
    console.log('Please check your API key and network connection.');
    process.exit(1);
  }

  // Run tests
  const results = {
    simpleChat: await testSimpleChat(),
    productivityMode: await testProductivityMode(),
    toolCalling: await testToolCalling(),
    streaming: await testStreaming(),
  };

  // Summary
  console.log('\n=== Test Summary ===\n');
  console.log('Simple Chat:', results.simpleChat ? '✓' : '✗');
  console.log('Productivity Mode:', results.productivityMode ? '✓' : '✗');
  console.log('Tool Calling:', results.toolCalling ? '✓' : '✗');
  console.log('Streaming:', results.streaming ? '✓' : '✗');

  const passed = Object.values(results).filter(r => r).length;
  const total = Object.keys(results).length;

  console.log(`\n${passed}/${total} tests passed`);

  if (passed === total) {
    console.log('\n🎉 All tests passed!');
    process.exit(0);
  } else {
    console.log('\n⚠️  Some tests failed');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
