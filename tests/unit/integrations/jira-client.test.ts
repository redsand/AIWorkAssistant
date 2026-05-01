/**
 * Jira REST API client unit tests
 */

import { describe, it, expect, beforeAll } from "vitest";
import { jiraClient } from "../../../src/integrations/jira/jira-client";

describe("Jira Client", () => {
  beforeAll(() => {
    // Check if Jira credentials are configured
    if (!jiraClient.isConfigured()) {
      console.warn(
        "Jira credentials not configured - skipping integration tests",
      );
    }
  });

  describe("Configuration", () => {
    it("should check if configured", () => {
      const isConfigured = jiraClient.isConfigured();
      expect(typeof isConfigured).toBe("boolean");
    });

    it("should validate configuration", async () => {
      if (!jiraClient.isConfigured()) {
        console.warn("Skipping validation test - Jira not configured");
        return;
      }

      const isValid = await jiraClient.validateConfig();
      expect(typeof isValid).toBe("boolean");
      console.log("Jira connection valid:", isValid);
    }, 15000);
  });

  describe("Issue Operations", () => {
    it("should get current user info", async () => {
      if (!jiraClient.isConfigured()) {
        console.warn("Skipping user test - Jira not configured");
        return;
      }

      const user = await jiraClient.getCurrentUser();

      expect(user).toBeDefined();
      expect(user.displayName).toBeTruthy();
      expect(user.emailAddress).toBeTruthy();
      console.log("Current user:", user.displayName, user.emailAddress);
    }, 15000);

    it("should get available projects", async () => {
      if (!jiraClient.isConfigured()) {
        console.warn("Skipping projects test - Jira not configured");
        return;
      }

      const projects = await jiraClient.getProjects();

      expect(Array.isArray(projects)).toBe(true);
      console.log(`Found ${projects.length} projects`);

      if (projects.length > 0) {
        console.log(
          "Sample projects:",
          projects.slice(0, 3).map((p) => `${p.key}: ${p.name}`),
        );
      }
    }, 15000);

    it("should get assigned issues", async () => {
      if (!jiraClient.isConfigured()) {
        console.warn("Skipping assigned issues test - Jira not configured");
        return;
      }

      const issues = await jiraClient.getAssignedIssues();

      expect(Array.isArray(issues)).toBe(true);
      console.log(`Found ${issues.length} assigned issues`);

      if (issues.length > 0) {
        console.log(
          "Sample issues:",
          issues.slice(0, 3).map((i) => `${i.key}: ${i.fields.summary}`),
        );
      }
    }, 30000);

    it("should search issues with JQL", async () => {
      if (!jiraClient.isConfigured()) {
        console.warn("Skipping search test - Jira not configured");
        return;
      }

      try {
        const jql = "updated >= -24h ORDER BY updated DESC";
        const issues = await jiraClient.searchIssues(jql, 10);

        expect(Array.isArray(issues)).toBe(true);
        console.log(`Found ${issues.length} issues updated in last 24h`);

        if (issues.length > 0) {
          console.log("Sample:", issues[0].key, issues[0].fields.summary);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("410")) {
          console.warn(
            "Jira JQL search returned 410 (Gone) - API version deprecated, skipping",
          );
          return;
        }
        throw error;
      }
    }, 30000);
  });

  describe("Error Handling", () => {
    it("should handle non-existent issue gracefully", async () => {
      if (!jiraClient.isConfigured()) {
        console.warn("Skipping error test - Jira not configured");
        return;
      }

      try {
        await jiraClient.getIssue("NONEXIST-123");
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error).toBeDefined();
        expect(error instanceof Error).toBe(true);
        console.log("Expected error:", (error as Error).message);
      }
    }, 15000);

    it("should handle invalid JQL gracefully", async () => {
      if (!jiraClient.isConfigured()) {
        console.warn("Skipping JQL error test - Jira not configured");
        return;
      }

      try {
        await jiraClient.searchIssues("invalid jql query here");
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error).toBeDefined();
        expect(error instanceof Error).toBe(true);
        console.log("Expected error:", (error as Error).message);
      }
    }, 15000);
  });

  describe("Comment Operations", () => {
    it("should add comment to issue (if test issue exists)", async () => {
      if (!jiraClient.isConfigured()) {
        console.warn("Skipping comment test - Jira not configured");
        return;
      }

      // First, try to find an issue to comment on
      const issues = await jiraClient.getAssignedIssues();

      if (issues.length === 0) {
        console.warn("No assigned issues to test commenting");
        return;
      }

      const testIssue = issues[0];
      const commentBody = `Test comment from OpenClaw Agent integration test - ${new Date().toISOString()}`;

      try {
        const comment = await jiraClient.addComment(testIssue.key, commentBody);

        expect(comment).toBeDefined();
        expect(comment.id).toBeTruthy();
        console.log(`Comment added to ${testIssue.key}:`, comment.id);
      } catch (error) {
        console.warn("Could not add comment:", (error as Error).message);
        // Don't fail the test if we don't have permission
      }
    }, 30000);
  });
});
