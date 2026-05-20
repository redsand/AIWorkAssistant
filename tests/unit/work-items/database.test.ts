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
      expect(item.archived).toBe(false);
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

    it("should auto-archive when status is set to done, preserving done status", () => {
      const item = db.createWorkItem({ type: "task", title: "Test" });
      const updated = db.updateWorkItem(item.id, { status: "done" });
      expect(updated!.status).toBe("done");
      expect(updated!.archived).toBe(true);
      expect(updated!.completedAt).toBeDefined();
    });

    it("should not auto-archive when status is set to non-done values", () => {
      const item = db.createWorkItem({ type: "task", title: "Test" });
      const updated = db.updateWorkItem(item.id, { status: "active" });
      expect(updated!.status).toBe("active");
      expect(updated!.archived).toBe(false);
    });

    it("should un-archive when updating an already-archived item's status to non-done", () => {
      const item = db.createWorkItem({ type: "task", title: "Test" });
      // First, mark as done (auto-archives)
      db.updateWorkItem(item.id, { status: "done" });
      const done = db.getWorkItem(item.id);
      expect(done!.status).toBe("done");
      expect(done!.archived).toBe(true);

      // Now update to active — should un-archive
      const reactivated = db.updateWorkItem(item.id, { status: "active" });
      expect(reactivated!.status).toBe("active");
      expect(reactivated!.archived).toBe(false);
    });

    it("should stay archived when updating an already-archived item with non-status changes", () => {
      const item = db.createWorkItem({ type: "task", title: "Test" });
      db.updateWorkItem(item.id, { status: "done" });
      const updated = db.updateWorkItem(item.id, { title: "Updated done item" });
      expect(updated!.title).toBe("Updated done item");
      expect(updated!.status).toBe("done");
      expect(updated!.archived).toBe(true);
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
      const toArchive = db.createWorkItem({ type: "task", title: "B" });
      db.archiveWorkItem(toArchive.id);
      const result = db.listWorkItems({});
      expect(result.items).toHaveLength(1);
    });

    it("should include archived when flag is set", () => {
      db.createWorkItem({ type: "task", title: "A" });
      const toArchive = db.createWorkItem({ type: "task", title: "B" });
      db.archiveWorkItem(toArchive.id);
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
    it("should mark item as done and archived with completedAt", () => {
      const item = db.createWorkItem({ type: "task", title: "Test" });
      const completed = db.completeWorkItem(item.id);
      expect(completed!.status).toBe("done");
      expect(completed!.archived).toBe(true);
      expect(completed!.completedAt).toBeDefined();
    });

    it("should exclude completed items from default list", () => {
      const item = db.createWorkItem({ type: "task", title: "Test" });
      db.completeWorkItem(item.id);
      const result = db.listWorkItems({});
      expect(result.items).toHaveLength(0);
    });

    it("should include completed items when includeArchived is true", () => {
      const item = db.createWorkItem({ type: "task", title: "Test" });
      db.completeWorkItem(item.id);
      const result = db.listWorkItems({ includeArchived: true });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].status).toBe("done");
      expect(result.items[0].archived).toBe(true);
      expect(result.items[0].completedAt).toBeDefined();
    });
  });

  describe("archiveWorkItem", () => {
    it("should mark item as archived while preserving current status", () => {
      const item = db.createWorkItem({ type: "task", title: "Test", status: "active" });
      const archived = db.archiveWorkItem(item.id);
      expect(archived!.archived).toBe(true);
      expect(archived!.status).toBe("active");
    });

    it("should work correctly alongside auto-archiving via updateWorkItem", () => {
      const item1 = db.createWorkItem({ type: "task", title: "Auto-archived" });
      const item2 = db.createWorkItem({ type: "task", title: "Manually archived" });

      // Auto-archive via updateWorkItem with status "done"
      const autoArchived = db.updateWorkItem(item1.id, { status: "done" });
      expect(autoArchived!.status).toBe("done");
      expect(autoArchived!.archived).toBe(true);

      // Manual archive via archiveWorkItem
      const manualArchived = db.archiveWorkItem(item2.id);
      expect(manualArchived!.archived).toBe(true);
      expect(manualArchived!.status).toBe("proposed");

      // Both should be excluded from default listing
      const result = db.listWorkItems({});
      expect(result.items).toHaveLength(0);

      // Both should be visible with includeArchived
      const all = db.listWorkItems({ includeArchived: true });
      expect(all.items).toHaveLength(2);
      expect(all.items.map((i) => i.archived)).toEqual([true, true]);
      expect(all.items.map((i) => i.status).sort()).toEqual(["done", "proposed"]);
    });

    it("should preserve done status when archiving an already-done item", () => {
      const item = db.createWorkItem({ type: "task", title: "Test" });
      db.updateWorkItem(item.id, { status: "done" });
      const beforeArchive = db.getWorkItem(item.id);
      expect(beforeArchive!.status).toBe("done");
      expect(beforeArchive!.archived).toBe(true);

      // archiveWorkItem on an already-archived item should still have archived=true
      const afterArchive = db.archiveWorkItem(item.id);
      expect(afterArchive!.archived).toBe(true);
      expect(afterArchive!.status).toBe("done");
    });
  });

  describe("getStats", () => {
    it("should return statistics excluding archived items", () => {
      db.createWorkItem({ type: "task", title: "A", status: "active", priority: "high" });
      db.createWorkItem({ type: "decision", title: "B", status: "proposed", priority: "medium" });
      const stats = db.getStats();
      expect(stats.totalItems).toBe(2);
      expect(stats.byStatus.active).toBe(1);
      expect(stats.byType.task).toBe(1);
      expect(stats.byPriority.high).toBe(1);
    });

    it("should exclude auto-archived done items from stats", () => {
      db.createWorkItem({ type: "task", title: "Active", status: "active" });
      const done = db.createWorkItem({ type: "task", title: "Done" });
      db.updateWorkItem(done.id, { status: "done" });

      const stats = db.getStats();
      expect(stats.totalItems).toBe(1);
    });
  });
});
