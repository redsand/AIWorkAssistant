import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WorkItemDatabase } from "../../../src/work-items/database";

describe("WorkItemDatabase", () => {
  let db: WorkItemDatabase;

  beforeEach(() => {
    db = new WorkItemDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("createWorkItem", () => {
    it("should create a work item with defaults", () => {
      const item = db.createWorkItem({ type: "task", title: "Fix login bug" });
      expect(item.id).toBeDefined();
      expect(item.type).toBe("task");
      expect(item.title).toBe("Fix login bug");
      expect(item.status).toBe("proposed");
      expect(item.priority).toBe("medium");
      expect(item.source).toBe("manual");
    });

    it("should create a work item with all fields", () => {
      const item = db.createWorkItem({
        type: "code_review",
        title: "Review PR #42",
        description: "Check security issues",
        status: "active",
        priority: "high",
        owner: "tim",
        source: "github",
        sourceUrl: "https://github.com/org/repo/pull/42",
        sourceExternalId: "42",
        dueAt: "2026-05-10T00:00:00Z",
        tags: ["security", "urgent"],
        linkedResources: [
          { type: "github", url: "https://github.com/org/repo/pull/42", label: "PR #42" },
        ],
        metadata: { jiraKey: "PROJ-123" },
      });
      expect(item.status).toBe("active");
      expect(item.priority).toBe("high");
      expect(item.owner).toBe("tim");
      expect(item.source).toBe("github");
      expect(item.sourceUrl).toBe("https://github.com/org/repo/pull/42");
      expect(item.sourceExternalId).toBe("42");
      expect(item.dueAt).toBe("2026-05-10T00:00:00Z");
      expect(JSON.parse(item.tagsJson!)).toEqual(["security", "urgent"]);
      expect(JSON.parse(item.linkedResourcesJson!)).toHaveLength(1);
      expect(JSON.parse(item.metadataJson!)).toEqual({ jiraKey: "PROJ-123" });
    });
  });

  describe("updateWorkItem", () => {
    it("should update specific fields", () => {
      const item = db.createWorkItem({ type: "task", title: "Original" });
      const updated = db.updateWorkItem(item.id, {
        title: "Updated",
        status: "active",
        priority: "critical",
      });
      expect(updated!.title).toBe("Updated");
      expect(updated!.status).toBe("active");
      expect(updated!.priority).toBe("critical");
    });

    it("should return null for nonexistent item", () => {
      const result = db.updateWorkItem("nonexistent", { title: "X" });
      expect(result).toBeNull();
    });
  });

  describe("listWorkItems", () => {
    it("should filter by status", () => {
      db.createWorkItem({ type: "task", title: "A", status: "proposed" });
      db.createWorkItem({ type: "task", title: "B", status: "active" });
      db.createWorkItem({ type: "task", title: "C", status: "done" });
      const result = db.listWorkItems({ status: "active" });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("B");
    });

    it("should exclude archived by default", () => {
      db.createWorkItem({ type: "task", title: "A" });
      const archived = db.createWorkItem({ type: "task", title: "B" });
      db.archiveWorkItem(archived.id);
      const result = db.listWorkItems({});
      expect(result.items).toHaveLength(1);
    });

    it("should include archived when flag is set", () => {
      db.createWorkItem({ type: "task", title: "A" });
      const archived = db.createWorkItem({ type: "task", title: "B" });
      db.archiveWorkItem(archived.id);
      const result = db.listWorkItems({ includeArchived: true });
      expect(result.items).toHaveLength(2);
    });

    it("should search by title and description", () => {
      db.createWorkItem({ type: "task", title: "Fix login", description: "OAuth flow broken" });
      db.createWorkItem({ type: "task", title: "Update docs", description: "API reference" });
      const result = db.listWorkItems({ search: "OAuth" });
      expect(result.items).toHaveLength(1);
    });
  });

  describe("addNote", () => {
    it("should add a note to a work item", () => {
      const item = db.createWorkItem({ type: "task", title: "Test" });
      const updated = db.addNote(item.id, "tim", "Started working on this");
      const notes = JSON.parse(updated!.notesJson!);
      expect(notes).toHaveLength(1);
      expect(notes[0].author).toBe("tim");
      expect(notes[0].content).toBe("Started working on this");
    });
  });

  describe("addLinkedResource", () => {
    it("should add a linked resource", () => {
      const item = db.createWorkItem({ type: "task", title: "Test" });
      const updated = db.addLinkedResource(item.id, {
        type: "jira",
        url: "https://jira.example.com/browse/PROJ-123",
        label: "PROJ-123",
      });
      const resources = JSON.parse(updated!.linkedResourcesJson!);
      expect(resources).toHaveLength(1);
      expect(resources[0].type).toBe("jira");
    });
  });

  describe("completeWorkItem", () => {
    it("should mark item as done with completedAt", () => {
      const item = db.createWorkItem({ type: "task", title: "Test" });
      const completed = db.completeWorkItem(item.id);
      expect(completed!.status).toBe("done");
      expect(completed!.completedAt).toBeDefined();
    });
  });

  describe("archiveWorkItem", () => {
    it("should mark item as archived", () => {
      const item = db.createWorkItem({ type: "task", title: "Test" });
      const archived = db.archiveWorkItem(item.id);
      expect(archived!.status).toBe("archived");
    });
  });

  describe("getStats", () => {
    it("should return statistics", () => {
      db.createWorkItem({ type: "task", title: "A", status: "active", priority: "high" });
      db.createWorkItem({ type: "decision", title: "B", status: "proposed", priority: "medium" });
      const stats = db.getStats();
      expect(stats.totalItems).toBe(2);
      expect(stats.byStatus.active).toBe(1);
      expect(stats.byType.task).toBe(1);
      expect(stats.byPriority.high).toBe(1);
    });
  });
});