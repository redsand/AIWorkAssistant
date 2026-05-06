export interface NotifiedItem {
  id: string;
  source: "hawk-ir" | "jitbit";
  externalId: string;
  riskLevel: string;
  notifiedAt: string;
  acknowledgedAt?: string;
  escalationLevel: number;
}

export interface NotificationStore {
  hasBeenNotified(source: string, externalId: string): Promise<boolean>;
  markNotified(item: NotifiedItem): Promise<void>;
  markAcknowledged(source: string, externalId: string): Promise<void>;
  getUnacknowledgedPastThreshold(minutes: number): Promise<NotifiedItem[]>;
  markEscalated(source: string, externalId: string, level: number): Promise<void>;
  cleanup(retentionDays: number): Promise<number>;
}

export class MemoryNotificationStore implements NotificationStore {
  private store = new Map<string, NotifiedItem>();

  async hasBeenNotified(source: string, externalId: string): Promise<boolean> {
    return this.store.has(`${source}:${externalId}`);
  }

  async markNotified(item: NotifiedItem): Promise<void> {
    this.store.set(`${item.source}:${item.externalId}`, item);
  }

  async markAcknowledged(source: string, externalId: string): Promise<void> {
    const key = `${source}:${externalId}`;
    const item = this.store.get(key);
    if (item) {
      item.acknowledgedAt = new Date().toISOString();
      this.store.set(key, item);
    }
  }

  async getUnacknowledgedPastThreshold(minutes: number): Promise<NotifiedItem[]> {
    const threshold = Date.now() - minutes * 60 * 1000;
    return Array.from(this.store.values()).filter(
      (item) => !item.acknowledgedAt && new Date(item.notifiedAt).getTime() < threshold
    );
  }

  async markEscalated(source: string, externalId: string, level: number): Promise<void> {
    const key = `${source}:${externalId}`;
    const item = this.store.get(key);
    if (item) {
      item.escalationLevel = level;
      this.store.set(key, item);
    }
  }

  async cleanup(retentionDays: number): Promise<number> {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const [key, item] of this.store) {
      if (new Date(item.notifiedAt).getTime() < cutoff) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

export const notificationStore = new MemoryNotificationStore();
