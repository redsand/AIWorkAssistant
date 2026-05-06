import { describe, it, expect, beforeEach } from "vitest";
import { MemoryNotificationStore, NotifiedItem } from "../../../src/push/notification-store";

describe("MemoryNotificationStore", () => {
  let store: MemoryNotificationStore;

  beforeEach(() => {
    store = new MemoryNotificationStore();
  });

  it("should track notified items", async () => {
    const item: NotifiedItem = {
      id: "hawk-ir:CASE-123",
      source: "hawk-ir",
      externalId: "CASE-123",
      riskLevel: "critical",
      notifiedAt: new Date().toISOString(),
      escalationLevel: 1,
    };

    await store.markNotified(item);
    expect(await store.hasBeenNotified("hawk-ir", "CASE-123")).toBe(true);
    expect(await store.hasBeenNotified("jitbit", "CASE-123")).toBe(false);
  });

  it("should mark items as acknowledged", async () => {
    const item: NotifiedItem = {
      id: "jitbit:567",
      source: "jitbit",
      externalId: "567",
      riskLevel: "high",
      notifiedAt: new Date().toISOString(),
      escalationLevel: 1,
    };

    await store.markNotified(item);
    await store.markAcknowledged("jitbit", "567");

    const unacknowledged = await store.getUnacknowledgedPastThreshold(0);
    expect(unacknowledged).toHaveLength(0);
  });

  it("should find unacknowledged items past threshold", async () => {
    const oldItem: NotifiedItem = {
      id: "hawk-ir:OLD",
      source: "hawk-ir",
      externalId: "OLD",
      riskLevel: "critical",
      notifiedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      escalationLevel: 1,
    };

    const recentItem: NotifiedItem = {
      id: "jitbit:RECENT",
      source: "jitbit",
      externalId: "RECENT",
      riskLevel: "high",
      notifiedAt: new Date().toISOString(),
      escalationLevel: 1,
    };

    await store.markNotified(oldItem);
    await store.markNotified(recentItem);

    const unacknowledged = await store.getUnacknowledgedPastThreshold(5);
    expect(unacknowledged).toHaveLength(1);
    expect(unacknowledged[0].externalId).toBe("OLD");
  });

  it("should track escalation levels", async () => {
    const item: NotifiedItem = {
      id: "hawk-ir:ESC",
      source: "hawk-ir",
      externalId: "ESC",
      riskLevel: "critical",
      notifiedAt: new Date(Date.now() - 5000).toISOString(),
      escalationLevel: 1,
    };

    await store.markNotified(item);
    await store.markEscalated("hawk-ir", "ESC", 2);

    const unacknowledged = await store.getUnacknowledgedPastThreshold(0);
    expect(unacknowledged).toHaveLength(1);
    expect(unacknowledged[0].escalationLevel).toBe(2);
  });

  it("should clean up old items", async () => {
    const item: NotifiedItem = {
      id: "jitbit:OLD",
      source: "jitbit",
      externalId: "OLD",
      riskLevel: "high",
      notifiedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      escalationLevel: 1,
    };

    await store.markNotified(item);
    const removed = await store.cleanup(30);
    expect(removed).toBe(1);
    expect(await store.hasBeenNotified("jitbit", "OLD")).toBe(false);
  });
});
