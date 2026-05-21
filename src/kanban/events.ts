import { EventEmitter } from "events";
import type { KanbanSSEEvent } from "./types.js";

class KanbanEventBus extends EventEmitter {
  private ring: { id: number; event: KanbanSSEEvent }[] = [];
  private nextId = 1;

  emitEvent(event: KanbanSSEEvent) {
    const entry = { id: this.nextId++, event };
    this.ring.push(entry);
    if (this.ring.length > 100) this.ring.shift();
    this.emit("event", entry);
  }

  replay(sinceId: number): { id: number; event: KanbanSSEEvent }[] {
    return this.ring.filter((e) => e.id > sinceId);
  }
}

export const kanbanEvents = new KanbanEventBus();
