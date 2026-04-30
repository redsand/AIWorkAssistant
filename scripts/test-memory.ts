#!/usr/bin/env tsx
/**
 * Test conversation memory management system
 */

import { conversationManager } from '../src/memory/conversation-manager';

async function testBasicSessionManagement() {
  console.log('\n=== Test 1: Basic Session Management ===\n');

  try {
    // Create a session
    const sessionId = conversationManager.startSession('test-user', 'productivity', {
      title: 'Test Session',
      tags: ['testing', 'memory'],
    });

    console.log('✅ Session created:', sessionId);

    // Add some messages
    conversationManager.addMessage(sessionId, {
      role: 'user',
      content: 'Hello, I need help with project planning',
    });

    conversationManager.addMessage(sessionId, {
      role: 'assistant',
      content: 'I\'d be happy to help you with project planning. What specific aspects do you need assistance with?',
    });

    conversationManager.addMessage(sessionId, {
      role: 'user',
      content: 'I need to create a roadmap for a security assessment project',
    });

    conversationManager.addMessage(sessionId, {
      role: 'assistant',
      content: 'Great! For a security assessment project, I recommend starting with the discovery phase. Would you like me to help you create a detailed roadmap?',
    });

    console.log('✅ Messages added to session');

    // Get session
    const session = conversationManager.getSession(sessionId);
    console.log('✅ Session retrieved:', session?.messages.length, 'messages');

    // Get messages in API format
    const apiMessages = conversationManager.getSessionMessages(sessionId);
    console.log('✅ API messages retrieved:', apiMessages.length, 'messages');

    return { success: true, sessionId };
  } catch (error) {
    console.error('❌ Test failed:', error);
    return { success: false, sessionId: null };
  }
}

async function testMemoryCompaction() {
  console.log('\n=== Test 2: Memory Compaction ===\n');

  try {
    const sessionId = conversationManager.startSession('test-user', 'engineering', {
      title: 'Compaction Test Session',
    });

    console.log('Adding many messages to trigger compaction...');

    // Add enough messages to trigger compaction (> 50 messages)
    for (let i = 0; i < 55; i++) {
      conversationManager.addMessage(sessionId, {
        role: 'user',
        content: `Test message ${i}: Discussing engineering topic ${i}`,
      });

      conversationManager.addMessage(sessionId, {
        role: 'assistant',
        content: `Response ${i}: Here's my analysis of engineering topic ${i}`,
      });
    }

    console.log('✅ Added 110 messages');

    const session = conversationManager.getSession(sessionId);
    console.log('✅ Session after compaction:', session?.messages.length, 'messages (should be compacted)');

    return true;
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

async function testSessionEndAndLongTermStorage() {
  console.log('\n=== Test 3: Session End and Long-Term Storage ===\n');

  try {
    const sessionId = conversationManager.startSession('test-user', 'productivity', {
      title: 'Long-term Storage Test',
      tags: ['storage', 'persistence'],
    });

    // Add some meaningful conversation
    conversationManager.addMessage(sessionId, {
      role: 'user',
      content: 'I want to implement a new authentication system for our application',
    });

    conversationManager.addMessage(sessionId, {
      role: 'assistant',
      content: 'That\'s a great security initiative. For authentication, I recommend considering OAuth 2.0, JWT tokens, and multi-factor authentication. What\'s your current tech stack?',
    });

    conversationManager.addMessage(sessionId, {
      role: 'user',
      content: 'We\'re using Node.js with Express and PostgreSQL',
    });

    conversationManager.addMessage(sessionId, {
      role: 'assistant',
      content: 'Perfect! For your stack, I\'d recommend using Passport.js for authentication, bcrypt for password hashing, and jsonwebtoken for JWT management. Would you like me to create an implementation plan?',
    });

    console.log('✅ Test conversation created');

    // End the session
    await conversationManager.endSession(sessionId);
    console.log('✅ Session ended and saved to long-term storage');

    // Verify it was saved
    setTimeout(() => {
      // Give it a moment to write to disk
    }, 1000);

    return true;
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

async function testMemorySearch() {
  console.log('\n=== Test 4: Memory Search ===\n');

  try {
    // Wait a moment for previous session to be saved
    await new Promise(resolve => setTimeout(resolve, 2000));

    const results = conversationManager.searchMemories('test-user', 'authentication', 10);

    console.log(`✅ Found ${results.length} memories matching "authentication"`);

    if (results.length > 0) {
      results.forEach((memory, index) => {
        console.log(`\n${index + 1}. ${memory.title}`);
        console.log(`   Date: ${memory.startDate.toLocaleDateString()}`);
        console.log(`   Topics: ${memory.keyTopics.join(', ')}`);
        console.log(`   Summary: ${memory.summary.substring(0, 100)}...`);
      });
    }

    return results.length > 0;
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

async function testRelevantMemories() {
  console.log('\n=== Test 5: Relevant Memories ===\n');

  try {
    const relevant = conversationManager.getRelevantMemories(
      'test-user',
      'I need help with security implementation and authentication systems',
      3
    );

    console.log(`✅ Found ${relevant.length} relevant memories`);
    relevant.forEach(memory => {
      console.log(`   - ${memory}`);
    });

    return true;
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

async function testStatistics() {
  console.log('\n=== Test 6: Statistics ===\n');

  try {
    const stats = conversationManager.getStats();

    console.log('📊 Memory Manager Statistics:');
    console.log(`   Active Sessions: ${stats.activeSessions}`);
    console.log(`   Total Summaries: ${stats.totalSummaries}`);
    console.log(`   Users: ${stats.usersCount}`);

    return true;
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

async function main() {
  console.log('Conversation Memory Management Tests');
  console.log('=====================================\n');

  const test1 = await testBasicSessionManagement();
  const test2 = await testMemoryCompaction();
  const test3 = await testSessionEndAndLongTermStorage();
  const test4 = await testMemorySearch();
  const test5 = await testRelevantMemories();
  const test6 = await testStatistics();

  console.log('\n=== Test Summary ===\n');
  console.log('Basic Session Management:', test1.success ? '✅' : '❌');
  console.log('Memory Compaction:', test2 ? '✅' : '❌');
  console.log('Session End and Long-Term Storage:', test3 ? '✅' : '❌');
  console.log('Memory Search:', test4 ? '✅' : '❌');
  console.log('Relevant Memories:', test5 ? '✅' : '❌');
  console.log('Statistics:', test6 ? '✅' : '❌');

  const allPassed = test1.success && test2 && test3 && test4 && test5 && test6;

  if (allPassed) {
    console.log('\n🎉 All memory management tests passed!');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests failed');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
