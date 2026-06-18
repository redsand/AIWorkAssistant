import type { JitbitSyncInput, JitbitSyncOutput, JitbitTicket } from "./types";
import { workItemDatabase, WorkItemDatabase } from "../work-items/database";
import type { WorkItemPriority } from "../work-items/types";
import { errorLog } from "../observability/error-log";

const JITBIT_SOURCE = "jitbit";

export class JitbitSyncService {
  private syncedTicketIds: Set<number> = new Set();
  private db: WorkItemDatabase;

  constructor(db: WorkItemDatabase = workItemDatabase) {
    this.db = db;
  }

  /**
   * Placeholder entry point for the production path. The live Jitbit API
   * calls (e.g. jitbit.search_tickets) are owned by the Jitbit integration;
   * once wired, fetched tickets are handed to {@link syncTickets}.
   */
  async syncFromJitbit(_input: JitbitSyncInput): Promise<JitbitSyncOutput> {
    return { synced: 0, skipped: 0, errors: 0, items: [] };
  }

  async syncTickets(tickets: JitbitTicket[]): Promise<JitbitSyncOutput> {
    const result: JitbitSyncOutput = {
      synced: 0,
      skipped: 0,
      errors: 0,
      items: [],
    };

    for (const ticket of tickets) {
      if (this.isAlreadySynced(ticket.id)) {
        result.skipped++;
        continue;
      }

      try {
        const workItem = this.db.createWorkItem({
          type: "support",
          title: `[JIT-${ticket.id}] ${ticket.subject}`,
          description: ticket.body || ticket.subject,
          priority: this.mapPriority(ticket.priority),
          source: JITBIT_SOURCE,
          status: "proposed",
          sourceExternalId: String(ticket.id),
          tags: ["jitbit-sync", `jitbit-ticket-${ticket.id}`],
        });

        this.syncedTicketIds.add(ticket.id);
        result.synced++;
        result.items.push({
          workItemId: workItem.id,
          jitbitTicketId: ticket.id,
          title: ticket.subject,
        });
      } catch (error) {
        result.errors++;
        void errorLog.log({
          source: "jitbit-sync",
          category: "create_work_item_failed",
          message:
            error instanceof Error
              ? error.message
              : `Failed to sync Jitbit ticket ${ticket.id}`,
          error,
          context: { jitbitTicketId: ticket.id },
        });
      }
    }

    return result;
  }

  private mapPriority(priority?: number): WorkItemPriority {
    switch (priority) {
      case 1:
        return "low";
      case 2:
        return "medium";
      case 3:
        return "high";
      case 4:
        return "critical";
      default:
        return "medium";
    }
  }

  isAlreadySynced(ticketId: number): boolean {
    if (this.syncedTicketIds.has(ticketId)) {
      return true;
    }
    // Dedup across restarts via source_external_id matching.
    if (this.db.findByTicketSource(JITBIT_SOURCE, String(ticketId))) {
      this.syncedTicketIds.add(ticketId);
      return true;
    }
    return false;
  }

  getSyncedCount(): number {
    return this.syncedTicketIds.size;
  }
}

export const jitbitSyncService = new JitbitSyncService();
