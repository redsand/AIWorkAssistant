/**
 * Tiny event bus for runner UI updates. Separate from kanbanEvents so the
 * runners feature can evolve its event surface without affecting kanban
 * consumers.
 *
 * Ring-buffered so an SSE client that reconnects with Last-Event-ID can
 * catch up without us holding a per-client queue.
 */

import { EventEmitter } from "events";
import type { Runner, RunnerStatus } from "../agent-runs/types";

export type RunnerSSEEvent =
  | { type: "runner.created"; runner: Runner }
  | { type: "runner.updated"; runner: Runner }
  | { type: "runner.deleted"; runnerId: string }
  | { type: "runner.status"; runner: Runner }
  | { type: "runner.log"; runnerId: string; chunk: string };

class RunnerEventBus extends EventEmitter {
  private ring: { id: number; event: RunnerSSEEvent }[] = [];
  private nextId = 1;

  emitEvent(event: RunnerSSEEvent): void {
    const entry = { id: this.nextId++, event };
    this.ring.push(entry);
    if (this.ring.length > 200) this.ring.shift();
    this.emit("event", entry);
  }

  replay(sinceId: number): { id: number; event: RunnerSSEEvent }[] {
    return this.ring.filter((e) => e.id > sinceId);
  }

  emitStatus(runner: Runner): void {
    this.emitEvent({ type: "runner.status", runner });
  }

  emitLog(runnerId: string, chunk: string): void {
    this.emitEvent({ type: "runner.log", runnerId, chunk });
  }
}

export const runnerEvents = new RunnerEventBus();
export type { RunnerStatus };
