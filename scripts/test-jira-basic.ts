#!/usr/bin/env tsx
/**
 * Simple Jira API test - testing basic functionality
 */

import { jiraClient } from '../src/integrations/jira/jira-client';

async function testBasicJira() {
  console.log('Jira API Basic Test');
  console.log('==================\n');

  // Check configuration
  console.log('1. Configuration Check');
  const isConfigured = jiraClient.isConfigured();
  console.log('   Configured:', isConfigured ? '✓' : '✗');

  if (!isConfigured) {
    console.error('Jira not configured. Check .env file.');
    process.exit(1);
  }

  // Validate config
  console.log('\n2. Connection Validation');
  const isValid = await jiraClient.validateConfig();
  console.log('   Connection valid:', isValid ? '✓' : '✗');

  // Get current user
  console.log('\n3. Get Current User');
  try {
    const user = await jiraClient.getCurrentUser();
    console.log('   ✓ User retrieved:', user.displayName);
    console.log('   Email:', user.emailAddress);
    console.log('   Account ID:', user.accountId);
  } catch (error) {
    console.log('   ✗ Failed:', error);
  }

  // Get projects
  console.log('\n4. Get Projects');
  try {
    const projects = await jiraClient.getProjects();
    console.log('   ✓ Projects retrieved:', projects.length);
    projects.forEach(p => console.log(`     - ${p.key}: ${p.name}`));
  } catch (error) {
    console.log('   ✗ Failed:', error);
  }

  // Get a specific issue (we know IR-1 exists from curl test)
  console.log('\n5. Get Specific Issue (IR-1)');
  try {
    const issue = await jiraClient.getIssue('IR-1');
    console.log('   ✓ Issue retrieved:', issue.key);
    console.log('   Summary:', issue.fields.summary);
    console.log('   Status:', issue.fields.status.name);
    console.log('   Assignee:', issue.fields.assignee?.displayName || 'Unassigned');
  } catch (error) {
    console.log('   ✗ Failed:', error);
  }

  // Get transitions for the issue
  console.log('\n6. Get Transitions for IR-1');
  try {
    const transitions = await jiraClient.getTransitions('IR-1');
    console.log('   ✓ Transitions retrieved:', transitions.length);
    transitions.forEach(t => console.log(`     - ${t.name}`));
  } catch (error) {
    console.log('   ✗ Failed:', error);
  }

  console.log('\n=== Test Complete ===');
  console.log('✅ Basic Jira API functionality is working!');
}

testBasicJira().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
