import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JitbitSyncService } from "../../../src/sync/jitbit-sync-service";
import { WorkItemDatabase } from "../../../src/work-items/database";

describe("JitbitSyncService", () => {
  let db: WorkItemDatabase;
  let service: JitbitSyncService;

  beforeEach(() => {
    db = new WorkItemDatabase(":memory:");
    service = new JitbitSyncService(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("syncTickets", () => {
    it("creates work items from Jitbit tickets", async () => {
      const result = await service.syncTickets([
        { id: 101, subject: "Login broken", body: "User cannot log in", priority: 3 },
        { id: 102, subject: "Slow dashboard", priority: 2 },
      ]);

      expect(result.synced).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].jitbitTicketId).toBe(101);
      expect(result.items[0].title).toBe("Login broken");
      expect(result.items[0].workItemId).toBeDefined();

      const created = db.getWorkItem(result.items[0].workItemId);
      expect(created).not.toBeNull();
      expect(created!.type).toBe("support");
      expect(created!.source).toBe("jitbit");
      expect(created!.status).toBe("proposed");
      expect(created!.priority).toBe("high");
      expect(created!.sourceExternalId).toBe("101");
    });

    it("skips already-synced tickets (deduplication)", async () => {
      const first = await service.syncTickets([{ id: 200, subject: "First sync" }]);
      expect(first.synced).toBe(1);
      expect(first.skipped).toBe(0);

      const second = await service.syncTickets([{ id: 200, subject: "First sync" }]);
      expect(second.synced).toBe(0);
      expect(second.skipped).toBe(1);
      expect(second.items).toHaveLength(0);
    });

    it("deduplicates against existing work items by source_external_id", async () => {
      db.createWorkItem({
        type: "support",
        title: "[JIT-300] Pre-existing",
        source: "jitbit",
        sourceExternalId: "300",
      });

      // Fresh service instance with no in-memory state, same DB.
      const freshService = new JitbitSyncService(db);
      const result = await freshService.syncTickets([{ id: 300, subject: "Pre-existing" }]);

      expect(result.synced).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it("maps Jitbit priority (1-4) to work item priority correctly", async () => {
      const result = await service.syncTickets([
        { id: 1, subject: "p1", priority: 1 },
        { id: 2, subject: "p2", priority: 2 },
        { id: 3, subject: "p3", priority: 3 },
        { id: 4, subject: "p4", priority: 4 },
      ]);

      const priorities = result.items.map(
        (i) => db.getWorkItem(i.workItemId)!.priority,
      );
      expect(priorities).toEqual(["low", "medium", "high", "critical"]);
    });

    it("maps unknown or missing priorities to medium", async () => {
      const result = await service.syncTickets([
        { id: 50, subject: "no priority" },
        { id: 51, subject: "out of range", priority: 99 },
      ]);

      const priorities = result.items.map(
        (i) => db.getWorkItem(i.workItemId)!.priority,
      );
      expect(priorities).toEqual(["medium", "medium"]);
    });

    it("creates items with [JIT-XXX] prefix and jitbit-sync tag", async () => {
      const result = await service.syncTickets([{ id: 555, subject: "Tagged ticket" }]);

      const created = db.getWorkItem(result.items[0].workItemId)!;
      expect(created.title).toBe("[JIT-555] Tagged ticket");
      const tags: string[] = JSON.parse(created.tagsJson ?? "[]");
      expect(tags).toContain("jitbit-sync");
      expect(tags).toContain("jitbit-ticket-555");
    });

    it("falls back to subject when body is missing", async () => {
      const result = await service.syncTickets([{ id: 777, subject: "No body here" }]);
      const created = db.getWorkItem(result.items[0].workItemId)!;
      expect(created.description).toBe("No body here");
    });
  });

  describe("isAlreadySynced", () => {
    it("returns false for unsynced tickets and true after syncing", async () => {
      expect(service.isAlreadySynced(900)).toBe(false);
      await service.syncTickets([{ id: 900, subject: "Sync me" }]);
      expect(service.isAlreadySynced(900)).toBe(true);
    });
  });

  describe("getSyncedCount", () => {
    it("reflects the number of synced tickets", async () => {
      expect(service.getSyncedCount()).toBe(0);
      await service.syncTickets([
        { id: 11, subject: "a" },
        { id: 12, subject: "b" },
      ]);
      expect(service.getSyncedCount()).toBe(2);
    });
  });

  describe("syncFromJitbit", () => {
    it("returns an empty result (API wiring is handled by the Jitbit integration)", async () => {
      const result = await service.syncFromJitbit({ days: 7, maxItems: 25 });
      expect(result).toEqual({ synced: 0, skipped: 0, errors: 0, items: [] });
    });
  });
});
