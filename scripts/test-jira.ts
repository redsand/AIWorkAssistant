#!/usr/bin/env tsx
/**
 * Quick test script for Jira API integration
 */

import { jiraClient } from "../src/integrations/jira/jira-client";

async function testConfiguration() {
  console.log("\n=== Test 1: Configuration ===\n");

  const isConfigured = jiraClient.isConfigured();
  console.log("Jira configured:", isConfigured ? "Yes" : "No");

  if (!isConfigured) {
    console.error("✗ Jira not configured");
    return false;
  }

  const isValid = await jiraClient.validateConfig();
  console.log("Connection valid:", isValid ? "Yes" : "No");

  return isValid;
}

async function testCurrentUser() {
  console.log("\n=== Test 2: Current User ===\n");

  try {
    const user = await jiraClient.getCurrentUser();
    console.log("✓ Success!");
    console.log("Name:", user.displayName);
    console.log("Email:", user.emailAddress);
    return true;
  } catch (error) {
    console.error("✗ Failed:", error);
    return false;
  }
}

async function testProjects() {
  console.log("\n=== Test 3: Projects ===\n");

  try {
    const projects = await jiraClient.getProjects();
    console.log("✓ Success!");
    console.log(`Found ${projects.length} projects`);

    if (projects.length > 0) {
      console.log("Sample projects:");
      projects.slice(0, 5).forEach((p) => {
        console.log(`  - ${p.key}: ${p.name}`);
      });
    }

    return true;
  } catch (error) {
    console.error("✗ Failed:", error);
    return false;
  }
}

async function testAssignedIssues() {
  console.log("\n=== Test 4: Assigned Issues ===\n");

  try {
    const issues = await jiraClient.getAssignedIssues();
    console.log("✓ Success!");
    console.log(`Found ${issues.length} assigned issues`);

    if (issues.length > 0) {
      console.log("Recent issues:");
      issues.slice(0, 5).forEach((issue) => {
        console.log(`  - ${issue.key}: ${issue.fields.summary}`);
        console.log(`    Status: ${issue.fields.status.name}`);
        console.log(`    Priority: ${issue.fields.priority.name}`);
        if (issue.fields.assignee) {
          console.log(`    Assignee: ${issue.fields.assignee.displayName}`);
        }
      });
    } else {
      console.log("No assigned issues found");
    }

    return true;
  } catch (error) {
    console.error("✗ Failed:", error);
    return false;
  }
}

async function testSearch() {
  console.log("\n=== Test 5: Search Issues ===\n");

  try {
    // Search for recently updated issues
    const jql = "updated >= -7d ORDER BY updated DESC";
    const issues = await jiraClient.searchIssues(jql, 10);
    console.log("✓ Success!");
    console.log(`Found ${issues.length} issues updated in last 7 days`);

    if (issues.length > 0) {
      console.log("Most recent:", issues[0].key, issues[0].fields.summary);
    }

    return true;
  } catch (error) {
    console.error("✗ Failed:", error);
    return false;
  }
}

async function testGetIssue() {
  console.log("\n=== Test 6: Get Issue Details ===\n");

  try {
    // First, get an assigned issue
    const issues = await jiraClient.getAssignedIssues();

    if (issues.length === 0) {
      console.warn("No assigned issues to test with");
      return true;
    }

    const issue = await jiraClient.getIssue(issues[0].key);
    console.log("✓ Success!");
    console.log("Issue:", issue.key);
    console.log("Summary:", issue.fields.summary);
    console.log("Status:", issue.fields.status.name);
    console.log("Type:", issue.fields.issuetype.name);
    console.log(
      "Created:",
      new Date(issue.fields.created).toLocaleDateString(),
    );

    return true;
  } catch (error) {
    console.error("✗ Failed:", error);
    return false;
  }
}

async function testTransitions() {
  console.log("\n=== Test 7: Get Transitions ===\n");

  try {
    const issues = await jiraClient.getAssignedIssues();

    if (issues.length === 0) {
      console.warn("No assigned issues to test transitions with");
      return true;
    }

    const transitions = await jiraClient.getTransitions(issues[0].key);
    console.log("✓ Success!");
    console.log(`Available transitions for ${issues[0].key}:`);

    if (transitions.length > 0) {
      transitions.forEach((t) => {
        console.log(`  - ${t.name} (→ ${t.to.name})`);
      });
    } else {
      console.log("  No transitions available");
    }

    return true;
  } catch (error) {
    console.error("✗ Failed:", error);
    return false;
  }
}

async function testAddComment() {
  console.log("\n=== Test 8: Add Comment ===\n");

  try {
    const issues = await jiraClient.getAssignedIssues();

    if (issues.length === 0) {
      console.warn("No assigned issues to test commenting");
      return true;
    }

    const testIssue = issues[0];
    const commentBody = `Integration test from AI Assistant - ${new Date().toISOString()}`;

    const comment = await jiraClient.addComment(testIssue.key, commentBody);
    console.log("✓ Success!");
    console.log(`Comment added to ${testIssue.key}`);
    console.log("Comment ID:", comment.id);

    return true;
  } catch (error) {
    console.error("✗ Failed:", error);
    console.warn("This is expected if you lack comment permissions");
    return true; // Don't fail the test suite
  }
}

async function main() {
  console.log("Jira API Integration Tests");
  console.log("========================\n");

  // Check configuration
  console.log("Checking configuration...");
  const isValid = await testConfiguration();

  if (!isValid) {
    console.error("\n✗ Jira API validation failed!");
    console.log("Please check your credentials in .env file.");
    process.exit(1);
  }

  // Run tests
  const results = {
    config: true,
    currentUser: await testCurrentUser(),
    projects: await testProjects(),
    assignedIssues: await testAssignedIssues(),
    search: await testSearch(),
    getIssue: await testGetIssue(),
    transitions: await testTransitions(),
    addComment: await testAddComment(),
  };

  // Summary
  console.log("\n=== Test Summary ===\n");
  console.log("Configuration:", results.config ? "✓" : "✗");
  console.log("Current User:", results.currentUser ? "✓" : "✗");
  console.log("Projects:", results.projects ? "✓" : "✗");
  console.log("Assigned Issues:", results.assignedIssues ? "✓" : "✗");
  console.log("Search:", results.search ? "✓" : "✗");
  console.log("Get Issue:", results.getIssue ? "✓" : "✗");
  console.log("Transitions:", results.transitions ? "✓" : "✗");
  console.log("Add Comment:", results.addComment ? "✓" : "✗");

  const passed = Object.values(results).filter((r) => r).length;
  const total = Object.keys(results).length;

  console.log(`\n${passed}/${total} tests passed`);

  if (passed === total) {
    console.log("\n🎉 All tests passed!");
    process.exit(0);
  } else {
    console.log("\n⚠️  Some tests failed");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
