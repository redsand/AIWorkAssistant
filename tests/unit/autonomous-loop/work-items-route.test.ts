/**
 * Tests for the work_items fetch logic in the autonomous loop route.
 *
 * Since the route handler uses Fastify and the actual workItemDatabase,
 * we test the helper functions and the database integration directly
 * rather than mocking HTTP requests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WorkItemDatabase } from "../../../src/work-items/database";
import { hashUuidToNumber, parseWorkItemTagsJson } from "../../../src/autonomous-loop/work-item-utils";
import { ticketToTaskGenerator } from "../../../src/engineering/ticket-to-task";
import {
  extractJiraSprintNumber,
  getEarliestSprintNumber,
  matchesSprintFocus,
  normalizeSprintFocus,
} from "../../../src/routes/autonomous-loop";

describe("Work Items — autonomous loop integration", () => {
  let db: WorkItemDatabase;

  beforeEach(() => {
    db = new WorkItemDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("fetchWorkItemsWork — database query logic", () => {
    it("should return work items with the matching tag and coding prompt", () => {
      const item = db.createWorkItem({
        type: "task",
        title: "Fix login bug",
        description: "## Coding Prompt\n\nUpdate the auth middleware to handle OAuth2.\n\n## Acceptance Criteria\n- [ ] Users can log in",
        status: "planned",
        tags: ["ready-for-agent", "enhancement"],
      });

      const result = db.listWorkItems({ limit: 100 });
      const filtered = result.items.filter((wi) => {
        if (wi.status === "done" || wi.status === "archived") return false;
        const tags = parseWorkItemTagsJson(wi.tagsJson);
        if (!tags.some((t) => t.toLowerCase() === "ready-for-agent")) return false;
        return ticketToTaskGenerator.hasCodingPromptContent(wi.description || "");
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe(item.id);
      expect(filtered[0].title).toBe("Fix login bug");
    });

    it("should exclude work items without the label tag", () => {
      db.createWorkItem({
        type: "task",
        title: "Fix login bug",
        description: "## Coding Prompt\n\nDo something.",
        status: "planned",
        tags: ["other-tag"],
      });

      const result = db.listWorkItems({ limit: 100 });
      const filtered = result.items.filter((wi) => {
        if (wi.status === "done" || wi.status === "archived") return false;
        const tags = parseWorkItemTagsJson(wi.tagsJson);
        return tags.some((t) => t.toLowerCase() === "ready-for-agent");
      });

      expect(filtered).toHaveLength(0);
    });

    it("should exclude work items that are done or archived", () => {
      db.createWorkItem({
        type: "task",
        title: "Done task",
        description: "## Coding Prompt\n\nDo something.",
        status: "done",
        tags: ["ready-for-agent"],
      });
      db.createWorkItem({
        type: "task",
        title: "Archived task",
        description: "## Coding Prompt\n\nDo something.",
        status: "archived",
        tags: ["ready-for-agent"],
      });

      const result = db.listWorkItems({ limit: 100 });
      const filtered = result.items.filter((wi) => {
        if (wi.status === "done" || wi.status === "archived") return false;
        const tags = parseWorkItemTagsJson(wi.tagsJson);
        return tags.some((t) => t.toLowerCase() === "ready-for-agent");
      });

      expect(filtered).toHaveLength(0);
    });

    it("should include active and planned work items", () => {
      db.createWorkItem({
        type: "task",
        title: "Active task",
        description: "## Coding Prompt\n\nDo something.",
        status: "active",
        tags: ["ready-for-agent"],
      });
      db.createWorkItem({
        type: "task",
        title: "Planned task",
        description: "## Coding Prompt\n\nDo something else.",
        status: "planned",
        tags: ["ready-for-agent"],
      });

      const result = db.listWorkItems({ limit: 100 });
      const filtered = result.items.filter((wi) => {
        if (wi.status === "done" || wi.status === "archived") return false;
        const tags = parseWorkItemTagsJson(wi.tagsJson);
        return tags.some((t) => t.toLowerCase() === "ready-for-agent");
      });

      expect(filtered).toHaveLength(2);
    });

    it("should exclude work items without a coding prompt when skipPromptCheck is false", () => {
      db.createWorkItem({
        type: "task",
        title: "No coding prompt",
        description: "Just a regular description without any coding prompt section.",
        status: "planned",
        tags: ["ready-for-agent"],
      });

      const result = db.listWorkItems({ limit: 100 });
      const filtered = result.items.filter((wi) => {
        if (wi.status === "done" || wi.status === "archived") return false;
        const tags = parseWorkItemTagsJson(wi.tagsJson);
        if (!tags.some((t) => t.toLowerCase() === "ready-for-agent")) return false;
        return ticketToTaskGenerator.hasCodingPromptContent(wi.description || "");
      });

      expect(filtered).toHaveLength(0);
    });

    it("should generate consistent numeric IDs via hashUuidToNumber", () => {
      const item = db.createWorkItem({
        type: "task",
        title: "Test task",
        description: "## Coding Prompt\n\nDo something.",
        status: "planned",
        tags: ["ready-for-agent"],
      });

      const num = hashUuidToNumber(item.id);
      expect(num).toBeGreaterThanOrEqual(0);
      expect(num).toBeLessThan(100000);
      // Same UUID should produce the same number
      expect(hashUuidToNumber(item.id)).toBe(num);
    });

    it("should limit results to the requested count", () => {
      for (let i = 0; i < 10; i++) {
        db.createWorkItem({
          type: "task",
          title: `Task ${i}`,
          description: "## Coding Prompt\n\nDo something.",
          status: "planned",
          tags: ["ready-for-agent"],
        });
      }

      const limit = 5;
      const result = db.listWorkItems({ limit: 100 });
      const filtered = result.items.filter((wi) => {
        if (wi.status === "done" || wi.status === "archived") return false;
        const tags = parseWorkItemTagsJson(wi.tagsJson);
        return tags.some((t) => t.toLowerCase() === "ready-for-agent");
      });

      expect(filtered.slice(0, limit)).toHaveLength(limit);
    });

    it("should handle work items with no tags", () => {
      db.createWorkItem({
        type: "task",
        title: "No tags task",
        description: "## Coding Prompt\n\nDo something.",
        status: "planned",
        tags: [],
      });

      const result = db.listWorkItems({ limit: 100 });
      const filtered = result.items.filter((wi) => {
        if (wi.status === "done" || wi.status === "archived") return false;
        const tags = parseWorkItemTagsJson(wi.tagsJson);
        return tags.some((t) => t.toLowerCase() === "ready-for-agent");
      });

      expect(filtered).toHaveLength(0);
    });
  });
});

describe("Jira sprint focus helpers", () => {
  const issue = (key: string, summary: string, labels: string[] = []) => ({
    key,
    fields: { summary, labels },
  });

  it("extracts sprint numbers from Jira summaries and labels", () => {
    expect(extractJiraSprintNumber(issue("SIEM-31", "[SPRINT-4] Cleanup"))).toBe(4);
    expect(extractJiraSprintNumber(issue("SIEM-15", "Vue scaffold", ["ready-for-agent", "sprint-1"]))).toBe(1);
  });

  it("normalizes explicit sprint focus values", () => {
    expect(normalizeSprintFocus("1")).toEqual({ number: 1, label: "sprint-1" });
    expect(normalizeSprintFocus("sprint-2")).toEqual({ number: 2, label: "sprint-2" });
  });

  it("auto-focuses the earliest sprint present", () => {
    const issues = [
      issue("SIEM-31", "[SPRINT-4] Cleanup"),
      issue("SIEM-15", "[SPRINT-1] Scaffold"),
      issue("SIEM-46", "[SPRINT-3] Additional views"),
    ];

    expect(getEarliestSprintNumber(issues)).toBe(1);
  });

  it("rejects later sprint Jira issues when sprint focus is earlier", () => {
    const focus = normalizeSprintFocus("sprint-1");
    expect(focus).not.toBeNull();
    expect(matchesSprintFocus(issue("SIEM-15", "[SPRINT-1] Scaffold"), focus!)).toBe(true);
    expect(matchesSprintFocus(issue("SIEM-31", "[SPRINT-4] Cleanup"), focus!)).toBe(false);
  });
});
