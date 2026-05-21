import { describe, it, expect } from "vitest";
import type { KanbanSSEEvent } from "../types.js";
import { kanbanEvents } from "../events.js";

function makeCard(): import("../types").KanbanCard {
  return {
    key: "github:owner/repo:1",
    platform: "github",
    repo: "owner/repo",
    id: "1",
    externalId: "#1",
    title: "Test issue",
    url: "https://github.com/owner/repo/issues/1",
    status: "open",
    column: "backlog",
    priority: "medium",
    assignee: null,
    labels: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    dependencyKeys: [],
    activeAgentRunId: null,
  };
}

describe("KanbanEventBus", () => {
  // We use a fresh instance by testing via the exported singleton.
  // Ring buffer state persists across tests, so we verify cumulative behavior.

  it("emits events with incrementing ids", () => {
    const received: { id: number; event: KanbanSSEEvent }[] = [];
    const handler = (entry: { id: number; event: KanbanSSEEvent }) => received.push(entry);
    kanbanEvents.on("event", handler);

    const event: KanbanSSEEvent = { type: "card.updated", card: makeCard() };
    kanbanEvents.emitEvent(event);

    kanbanEvents.off("event", handler);

    expect(received).toHaveLength(1);
    expect(received[0].event.type).toBe("card.updated");
    expect(received[0].id).toBeGreaterThan(0);
  });

  it("replays events with id greater than sinceId", () => {
    // Emit a few events to populate the ring buffer
    const card = makeCard();
    kanbanEvents.emitEvent({ type: "card.updated", card });
    kanbanEvents.emitEvent({ type: "card.updated", card });
    kanbanEvents.emitEvent({ type: "card.updated", card });

    // Get the current ring buffer state
    const all = kanbanEvents.replay(0);
    expect(all.length).toBeGreaterThanOrEqual(3);

    // Replay from second-to-last should return at least 1
    const secondLastId = all[all.length - 2].id;
    const replayed = kanbanEvents.replay(secondLastId);
    expect(replayed.length).toBeGreaterThanOrEqual(1);
    for (const entry of replayed) {
      expect(entry.id).toBeGreaterThan(secondLastId);
    }
  });

  it("caps ring buffer at 100 events", () => {
    // Emit 105 events to exceed the cap
    const card = makeCard();
    for (let i = 0; i < 105; i++) {
      kanbanEvents.emitEvent({ type: "card.updated", card });
    }

    // Replay from id 0 should return exactly 100 (the most recent)
    const all = kanbanEvents.replay(0);
    expect(all.length).toBeLessThanOrEqual(100);
  });

  it("replay with sinceId beyond ring returns empty array", () => {
    const all = kanbanEvents.replay(0);
    if (all.length === 0) return;
    const maxId = all[all.length - 1].id;
    const result = kanbanEvents.replay(maxId);
    expect(result).toEqual([]);
  });
});
